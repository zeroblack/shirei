use std::collections::HashMap;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{SyncSender, sync_channel};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::lock::MutexExt;
use crate::protocol::{ClientMsg, ServerMsg, decode, encode, read_frame};
use crate::session::{DEFAULT_RING_CAP, Session};

type Registry = Arc<Mutex<HashMap<String, Session>>>;

const SWEEP_INTERVAL: Duration = Duration::from_secs(5);

/// Per-client outgoing queue, in messages. Output chunks are at most
/// READ_BUFFER_LEN, so this bounds a stalled client to a few MiB in flight;
/// past that the client is dropped (see Session::broadcast).
const CLIENT_QUEUE_CAP: usize = 256;

/// With no sessions and nothing to do the daemon exits and gets respawned on
/// demand; a forgotten daemon should not outlive its purpose.
const DEFAULT_IDLE_EXIT: Duration = Duration::from_secs(600);

static NEXT_CLIENT: AtomicU64 = AtomicU64::new(1);

fn env_duration(var: &str) -> Option<Duration> {
    std::env::var(var)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&secs| secs > 0)
        .map(Duration::from_secs)
}

fn orphan_ttl() -> Option<Duration> {
    env_duration("SHIREI_ORPHAN_TTL")
}

fn idle_exit_ttl() -> Option<Duration> {
    match std::env::var("SHIREI_MUX_IDLE_TTL") {
        Ok(v) if v.trim() == "0" => None,
        Ok(v) => v.parse::<u64>().ok().map(Duration::from_secs),
        Err(_) => Some(DEFAULT_IDLE_EXIT),
    }
}

/// Socket perms (0600) already keep other users out; this guards the same-user
/// boundary explicitly and makes the trust model auditable: only processes of
/// the owning user may drive the daemon.
fn peer_is_same_user(stream: &UnixStream) -> bool {
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    let rc = unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) };
    rc == 0 && uid == unsafe { libc::geteuid() }
}

pub fn run(socket_path: &Path) -> anyhow::Result<()> {
    if socket_path.exists() {
        if UnixStream::connect(socket_path).is_ok() {
            anyhow::bail!("a live daemon already owns {socket_path:?}");
        }
        std::fs::remove_file(socket_path)?;
    }
    if let Some(dir) = socket_path.parent() {
        std::fs::create_dir_all(dir)?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let listener = UnixListener::bind(socket_path)?;
    std::fs::set_permissions(socket_path, std::fs::Permissions::from_mode(0o600))?;

    let persist_dir = socket_path.parent().map(|p| p.join("sessions"));
    if let Some(dir) = &persist_dir {
        let _ = std::fs::create_dir_all(dir);
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    let registry: Registry = Arc::new(Mutex::new(HashMap::new()));
    spawn_reaper(Arc::clone(&registry), orphan_ttl(), idle_exit_ttl());
    for stream in listener.incoming() {
        let stream = match stream {
            Ok(s) => s,
            Err(e) => {
                eprintln!("shirei-mux: accept failed: {e}");
                continue;
            }
        };
        if !peer_is_same_user(&stream) {
            continue;
        }
        let reg = Arc::clone(&registry);
        let persist = persist_dir.clone();
        thread::spawn(move || {
            let _ = handle_client(stream, reg, persist);
        });
    }
    Ok(())
}

fn spawn_reaper(reg: Registry, ttl: Option<Duration>, idle_exit: Option<Duration>) {
    thread::spawn(move || {
        let mut idle_since: Option<Instant> = None;
        loop {
            thread::sleep(SWEEP_INTERVAL);
            let to_kill: Vec<Session> = {
                let mut sessions = reg.lock_ignore_poison();
                let drop_ids: Vec<String> = sessions
                    .iter()
                    .filter(|(_, s)| {
                        // A dead session nobody listens to is done: a later
                        // Spawn recreates it fresh and preloads its buffer.
                        // Live orphans go once they outlast the TTL.
                        let state = s.reap_state();
                        (!state.alive && !state.has_subs)
                            || ttl.is_some_and(|ttl| {
                                state.alive && state.orphaned_for.is_some_and(|d| d >= ttl)
                            })
                    })
                    .map(|(id, _)| id.clone())
                    .collect();
                let removed: Vec<Session> = drop_ids
                    .into_iter()
                    .filter_map(|id| sessions.remove(&id))
                    .collect();
                if sessions.is_empty() {
                    idle_since.get_or_insert_with(Instant::now);
                } else {
                    idle_since = None;
                }
                removed
            };
            for session in &to_kill {
                session.kill();
            }
            if let (Some(limit), Some(since)) = (idle_exit, idle_since)
                && since.elapsed() >= limit
            {
                std::process::exit(0);
            }
        }
    });
}

fn handle_client(
    stream: UnixStream,
    reg: Registry,
    persist_dir: Option<PathBuf>,
) -> anyhow::Result<()> {
    let client = NEXT_CLIENT.fetch_add(1, Ordering::Relaxed);
    let mut reader = stream.try_clone()?;
    let (tx, rx) = sync_channel::<ServerMsg>(CLIENT_QUEUE_CAP);

    let mut wstream = stream;
    let writer_thread = thread::spawn(move || {
        for msg in rx {
            let Ok(frame) = encode(&msg) else { break };
            if wstream.write_all(&frame).is_err() {
                break;
            }
            let _ = wstream.flush();
        }
    });

    while let Some(body) = read_frame(&mut reader)? {
        let msg: ClientMsg = decode(&body)?;
        handle_msg(msg, &reg, &tx, &persist_dir, client);
    }

    for session in reg.lock_ignore_poison().values() {
        session.detach(client);
    }

    drop(tx);
    let _ = writer_thread.join();
    Ok(())
}

/// Control replies use a blocking `send` so they are never silently dropped,
/// but always after releasing the registry lock: a stalled client may block
/// its own handler thread, never the whole daemon.
fn handle_msg(
    msg: ClientMsg,
    reg: &Registry,
    tx: &SyncSender<ServerMsg>,
    persist_dir: &Option<PathBuf>,
    client: u64,
) {
    match msg {
        ClientMsg::Spawn {
            id,
            cols,
            rows,
            cwd,
            command,
        } => {
            let pid = {
                let mut sessions = reg.lock_ignore_poison();
                if !sessions.contains_key(&id) {
                    let persist = persist_dir.as_ref().map(|d| d.join(format!("{id}.buf")));
                    if let Ok(session) = Session::spawn(
                        id.clone(),
                        cols,
                        rows,
                        cwd,
                        command,
                        DEFAULT_RING_CAP,
                        persist,
                    ) {
                        sessions.insert(id.clone(), session);
                    }
                }
                sessions.get(&id).and_then(|s| {
                    s.attach(client, tx.clone(), &id);
                    s.pid()
                })
            };
            let _ = tx.send(ServerMsg::Spawned { id, pid });
        }
        ClientMsg::Attach { id } => {
            let found = {
                let sessions = reg.lock_ignore_poison();
                sessions
                    .get(&id)
                    .map(|session| session.attach(client, tx.clone(), &id))
                    .is_some()
            };
            if !found {
                let _ = tx.send(ServerMsg::Exit { id });
            }
        }
        ClientMsg::Input { id, data } => {
            let sessions = reg.lock_ignore_poison();
            if let Some(session) = sessions.get(&id) {
                session.input(&data);
            }
        }
        ClientMsg::Resize { id, cols, rows } => {
            let sessions = reg.lock_ignore_poison();
            if let Some(session) = sessions.get(&id) {
                session.resize(cols, rows);
            }
        }
        ClientMsg::Kill { id } => {
            let session = reg.lock_ignore_poison().remove(&id);
            if let Some(session) = session {
                session.kill();
            }
            let _ = tx.send(ServerMsg::Exit { id });
        }
        ClientMsg::Detach { id } => {
            let sessions = reg.lock_ignore_poison();
            if let Some(session) = sessions.get(&id) {
                session.detach(client);
            }
        }
        ClientMsg::Probe { id } => {
            let snap = {
                let sessions = reg.lock_ignore_poison();
                sessions.get(&id).map(|s| s.probe()).unwrap_or_default()
            };
            let _ = tx.send(ServerMsg::Probe {
                id,
                cwd: snap.cwd,
                command: snap.command,
            });
        }
        ClientMsg::List => {
            let ids = {
                let sessions = reg.lock_ignore_poison();
                sessions
                    .iter()
                    .filter(|(_, s)| s.alive())
                    .map(|(k, _)| k.clone())
                    .collect()
            };
            let _ = tx.send(ServerMsg::Sessions { ids });
        }
    }
}
