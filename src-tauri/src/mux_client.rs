use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use shirei_mux::lock::MutexExt;
use shirei_mux::paths::socket_path;
use shirei_mux::proc::Snapshot;
use shirei_mux::protocol::{ClientMsg, ServerMsg, decode, encode, read_frame};
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::config::ConfigManager;
use crate::error::{Error, Result};

const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);
const SPAWN_TIMEOUT: Duration = Duration::from_millis(2000);
const DAEMON_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const DAEMON_CONNECT_RETRY: Duration = Duration::from_millis(50);
const MAX_PROBE_WAITERS: usize = 64;

fn daemon_bin() -> PathBuf {
    if let Ok(p) = std::env::var("SHIREI_MUX_BIN") {
        return PathBuf::from(p);
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        let candidate = dir.join("shirei-mux");
        if candidate.exists() {
            return candidate;
        }
    }
    PathBuf::from("shirei-mux")
}

fn spawn_daemon(orphan_ttl_secs: u32) -> Result<()> {
    let mut cmd = Command::new(daemon_bin());
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env("SHIREI_ORPHAN_TTL", orphan_ttl_secs.to_string());
    // setsid: the daemon gets its own session and survives the app closing.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    cmd.spawn().map_err(Error::Io)?;
    Ok(())
}

fn connect_or_spawn(orphan_ttl_secs: u32) -> Result<UnixStream> {
    let path = socket_path();
    if let Ok(stream) = UnixStream::connect(&path) {
        return Ok(stream);
    }
    spawn_daemon(orphan_ttl_secs)?;
    let deadline = Instant::now() + DAEMON_CONNECT_TIMEOUT;
    loop {
        if let Ok(stream) = UnixStream::connect(&path) {
            return Ok(stream);
        }
        if Instant::now() > deadline {
            return Err(Error::Pty(
                "could not connect to the shirei-mux daemon".into(),
            ));
        }
        thread::sleep(DAEMON_CONNECT_RETRY);
    }
}

/// Pre-warms the persistent-session daemon at boot so the first pane connects
/// without paying the spawn latency. Only fires when persistent sessions are
/// actually enabled (`keep_alive`) — the daemon is useless otherwise, so there's
/// nothing to pre-warm and starting it would be pure overhead.
pub fn autostart(app: &AppHandle) {
    let session = app.state::<ConfigManager>().current().session;
    if !session.autostart_daemon || !session.keep_alive {
        return;
    }
    if UnixStream::connect(socket_path()).is_err() {
        let _ = spawn_daemon(session.orphan_ttl_secs);
    }
}

type ProbeReply = (Option<String>, Option<String>, Option<u32>);

/// One live connection to the daemon. Each concern has its own lock so the
/// reader thread routing output never contends with command writes.
struct Conn {
    write: Mutex<UnixStream>,
    routes: Mutex<HashMap<String, Channel<Response>>>,
    probe_waiters: Mutex<HashMap<String, VecDeque<Sender<ProbeReply>>>>,
    spawn_waiters: Mutex<HashMap<String, VecDeque<Sender<Option<u32>>>>>,
}

#[derive(Default)]
pub struct MuxClient {
    conn: Mutex<Option<Arc<Conn>>>,
}

impl MuxClient {
    fn ensure(&self, app: &AppHandle) -> Result<Arc<Conn>> {
        let mut guard = self.conn.lock_ignore_poison();
        if let Some(conn) = guard.as_ref() {
            return Ok(Arc::clone(conn));
        }
        let ttl = app
            .state::<ConfigManager>()
            .current()
            .session
            .orphan_ttl_secs;
        let write = connect_or_spawn(ttl)?;
        let read = write.try_clone().map_err(Error::Io)?;
        let conn = Arc::new(Conn {
            write: Mutex::new(write),
            routes: Mutex::new(HashMap::new()),
            probe_waiters: Mutex::new(HashMap::new()),
            spawn_waiters: Mutex::new(HashMap::new()),
        });
        spawn_reader(read, Arc::clone(&conn), app.clone());
        *guard = Some(Arc::clone(&conn));
        Ok(conn)
    }

    /// Called when a connection's reader dies: the next command reconnects
    /// (and respawns the daemon if needed) instead of reusing a dead stream.
    fn invalidate(&self, dead: &Arc<Conn>) {
        let mut guard = self.conn.lock_ignore_poison();
        if guard.as_ref().is_some_and(|c| Arc::ptr_eq(c, dead)) {
            *guard = None;
        }
    }

    pub fn probe(&self, app: &AppHandle, id: &str) -> Result<Option<(Snapshot, Option<u32>)>> {
        let conn = self.ensure(app)?;
        let (tx, rx) = channel::<ProbeReply>();
        {
            let mut waiters = conn.probe_waiters.lock_ignore_poison();
            let queue = waiters.entry(id.to_string()).or_default();
            // Timed-out waiters stay queued (see below), so a daemon that never
            // answers would grow this unboundedly; cap it as a safety valve. In
            // normal operation the queue holds 0-1 entries and this never trips.
            while queue.len() >= MAX_PROBE_WAITERS {
                queue.pop_front();
            }
            queue.push_back(tx);
        }
        if let Err(err) = send(&conn, &ClientMsg::Probe { id: id.to_string() }) {
            conn.probe_waiters
                .lock_ignore_poison()
                .get_mut(id)
                .and_then(VecDeque::pop_back);
            return Err(err);
        }
        // On timeout the waiter stays queued on purpose: replies are FIFO per
        // id, so removing it would misroute a late reply to the next caller.
        // The late reply lands on this dropped receiver and dies silently.
        match rx.recv_timeout(PROBE_TIMEOUT) {
            Ok((cwd, command, pid)) if cwd.is_some() || command.is_some() || pid.is_some() => {
                Ok(Some((Snapshot { cwd, command }, pid)))
            }
            Ok(_) => Ok(None),
            Err(_) => Ok(None),
        }
    }
}

fn spawn_reader(mut read: UnixStream, conn: Arc<Conn>, app: AppHandle) {
    thread::spawn(move || {
        while let Ok(Some(body)) = read_frame(&mut read) {
            let Ok(msg) = decode::<ServerMsg>(&body) else {
                continue;
            };
            match msg {
                ServerMsg::Output { id, data } | ServerMsg::Snapshot { id, data } => {
                    let routes = conn.routes.lock_ignore_poison();
                    if let Some(channel) = routes.get(&id) {
                        let _ = channel.send(Response::new(data));
                    }
                }
                ServerMsg::Exit { id } => {
                    let _ = app.emit(&format!("pty-exit-{id}"), ());
                    conn.routes.lock_ignore_poison().remove(&id);
                }
                ServerMsg::Probe {
                    id,
                    cwd,
                    command,
                    pid,
                } => {
                    let mut waiters = conn.probe_waiters.lock_ignore_poison();
                    if let Some(queue) = waiters.get_mut(&id)
                        && let Some(waiter) = queue.pop_front()
                    {
                        let _ = waiter.send((cwd, command, pid));
                    }
                }
                ServerMsg::Spawned { id, pid } => {
                    let mut waiters = conn.spawn_waiters.lock_ignore_poison();
                    if let Some(queue) = waiters.get_mut(&id)
                        && let Some(waiter) = queue.pop_front()
                    {
                        let _ = waiter.send(pid);
                    }
                }
                ServerMsg::Sessions { .. } => {}
            }
        }
        app.state::<MuxClient>().invalidate(&conn);
    });
}

fn send(conn: &Arc<Conn>, msg: &ClientMsg) -> Result<()> {
    let frame = encode(msg).map_err(|e| Error::Pty(e.to_string()))?;
    let mut write = conn.write.lock_ignore_poison();
    write.write_all(&frame).map_err(Error::Io)?;
    write.flush().map_err(Error::Io)?;
    Ok(())
}

// The flat signature mirrors the frontend invoke payload (one-word parameter
// names per project convention); grouping them into a struct would only move
// the noise to the JS side.
//
// Returning before the daemon confirms the spawn would leave a black, unrouted
// pane whenever the socket connects but the daemon can't serve it (a stale
// socket, a daemon that dies mid-handshake, a hung daemon). Blocking on the
// `Spawned` ack lets a failure surface as `Err` so the frontend degrades to an
// in-process PTY instead. The wait runs on the blocking pool so the IPC thread
// stays free for other panes' keystrokes while a slow daemon answers.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn mux_spawn(
    app: AppHandle,
    id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    command: Option<String>,
    on_data: Channel<Response>,
) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = app.state::<MuxClient>().ensure(&app)?;
        let (tx, rx) = channel::<Option<u32>>();
        {
            let mut waiters = conn.spawn_waiters.lock_ignore_poison();
            let queue = waiters.entry(id.clone()).or_default();
            while queue.len() >= MAX_PROBE_WAITERS {
                queue.pop_front();
            }
            queue.push_back(tx);
        }
        // The route must exist before the daemon can emit the first output frame.
        conn.routes.lock_ignore_poison().insert(id.clone(), on_data);
        if let Err(err) = send(
            &conn,
            &ClientMsg::Spawn {
                id: id.clone(),
                cols,
                rows,
                cwd,
                command,
            },
        ) {
            // The daemon never learned about this session: drop the orphaned
            // route so its Channel (and the webview callback it pins) can be
            // collected, and retract the pending ack waiter.
            conn.routes.lock_ignore_poison().remove(&id);
            conn.spawn_waiters
                .lock_ignore_poison()
                .get_mut(&id)
                .and_then(VecDeque::pop_back);
            return Err(err);
        }
        match rx.recv_timeout(SPAWN_TIMEOUT) {
            Ok(Some(_pid)) => Ok(()),
            _ => {
                conn.routes.lock_ignore_poison().remove(&id);
                Err(Error::Pty(
                    "the shirei-mux daemon did not confirm the session".into(),
                ))
            }
        }
    })
    .await
    .map_err(|e| Error::Os(e.to_string()))?
}

#[tauri::command]
pub fn mux_write(
    app: AppHandle,
    client: State<'_, MuxClient>,
    id: String,
    data: String,
) -> Result<()> {
    let conn = client.ensure(&app)?;
    send(
        &conn,
        &ClientMsg::Input {
            id,
            data: data.into_bytes(),
        },
    )
}

#[tauri::command]
pub fn mux_resize(
    app: AppHandle,
    client: State<'_, MuxClient>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<()> {
    let conn = client.ensure(&app)?;
    send(&conn, &ClientMsg::Resize { id, cols, rows })
}

#[tauri::command]
pub fn mux_kill(app: AppHandle, client: State<'_, MuxClient>, id: String) -> Result<()> {
    let conn = client.ensure(&app)?;
    send(&conn, &ClientMsg::Kill { id })
}

#[tauri::command]
pub fn mux_detach(app: AppHandle, client: State<'_, MuxClient>, id: String) -> Result<()> {
    let conn = client.ensure(&app)?;
    conn.routes.lock_ignore_poison().remove(&id);
    send(&conn, &ClientMsg::Detach { id })
}
