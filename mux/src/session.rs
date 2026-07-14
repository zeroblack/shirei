use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{Child, MasterPty};

use crate::detect::{Detector, StateChange};
use crate::lock::MutexExt;
use crate::modes::ModeTracker;
use crate::proc::{ProcStatus, Snapshot, cpu_ticks, foreground_command, proc_status, snapshot_of};
use crate::protocol::ServerMsg;
use crate::ring::Ring;
use crate::shell::{READ_BUFFER_LEN, ShellPty, open_login_shell, pty_size};

pub const DEFAULT_RING_CAP: usize = 256 * 1024;
// Each dump snapshots the whole ring, so a small threshold re-writes the full
// buffer many times per ring of output. At 128 KiB the amplification stays near
// 2x while a crash loses at most this much trailing scrollback.
const DUMP_THRESHOLD: usize = 128 * 1024;
// Consecutive idle ticks before Working flips to a low-confidence Waiting.
const DEFAULT_HYSTERESIS: u32 = 2;
// CPU time (ns) below which a process counts as idle for one tick — the second
// vote (besides output silence) that a quiet session is genuinely waiting.
const CPU_IDLE_DELTA_NS: u64 = 15_000_000;
// How much trailing scrollback the prompt classifier (Layer 3) inspects.
const TAIL_BYTES: usize = 2048;
// Output within this window of the user's last keystroke is the CLI echoing or
// repainting the input line as the user types, not the agent working — it must
// not read as "working".
const ECHO_WINDOW: Duration = Duration::from_millis(1000);

struct Sub {
    client: u64,
    tx: SyncSender<ServerMsg>,
}

struct Inner {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    ring: Ring,
    modes: ModeTracker,
    detector: Detector,
    last_output: Instant,
    last_input: Instant,
    last_cpu: Option<u64>,
    command: Option<String>,
    subs: Vec<Sub>,
    alive: bool,
    persist: Option<PathBuf>,
    since_dump: usize,
    detached_at: Option<Instant>,
}

impl Inner {
    fn pending_dump(&mut self, n: usize) -> Option<(PathBuf, Vec<u8>)> {
        let path = self.persist.clone()?;
        self.since_dump += n;
        if self.since_dump >= DUMP_THRESHOLD {
            self.since_dump = 0;
            Some((path, self.ring.snapshot()))
        } else {
            None
        }
    }

    fn mark_detached_if_empty(&mut self) {
        if self.subs.is_empty() && self.detached_at.is_none() {
            self.detached_at = Some(Instant::now());
        }
    }

    /// Fans a message out to every subscriber. `try_send` keeps a slow client
    /// from growing its queue without bound: when its queue is full it gets
    /// dropped and can reattach later, replaying from the ring. The single-sub
    /// fast path moves the message without cloning the payload.
    fn broadcast(&mut self, msg: ServerMsg) {
        if let [only] = self.subs.as_slice() {
            if only.tx.try_send(msg).is_err() {
                self.subs.clear();
            }
            return;
        }
        self.subs.retain(|s| s.tx.try_send(msg.clone()).is_ok());
    }

    fn broadcast_state(&mut self, id: &str, change: StateChange) {
        let command = self.command.clone();
        self.broadcast(ServerMsg::State {
            id: id.to_string(),
            state: change.state,
            confidence: change.confidence,
            command,
            payload: change.payload,
        });
    }
}

fn dump_to(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, data)?;
    // Scrollback can hold whatever ran in the terminal (tokens, history):
    // keep the dump private to the user even if the parent dir is ever loosened.
    set_private(&tmp);
    std::fs::rename(tmp, path)
}

fn set_private(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

pub struct ReapState {
    pub alive: bool,
    pub has_subs: bool,
    pub orphaned_for: Option<Duration>,
}

pub struct Session {
    inner: Arc<Mutex<Inner>>,
    id: String,
}

impl Session {
    pub fn spawn(
        id: String,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
        command: Option<String>,
        ring_cap: usize,
        persist: Option<PathBuf>,
    ) -> anyhow::Result<Session> {
        // The env mark lets the daemon recognize and clean up orphan shells
        // left behind by previous instances.
        let ShellPty {
            master,
            child,
            mut reader,
            mut writer,
        } = open_login_shell(
            cols,
            rows,
            cwd,
            &[("SHIREI_MUX_DAEMON", std::process::id().to_string())],
        )?;
        if let Some(c) = &command {
            writer.write_all(format!("{c}\n").as_bytes())?;
            writer.flush()?;
        }

        let mut ring = Ring::new(ring_cap);
        if let Some(path) = &persist
            && let Ok(saved) = std::fs::read(path)
        {
            ring.push(&saved);
        }

        let inner = Arc::new(Mutex::new(Inner {
            writer,
            master,
            child,
            ring,
            modes: ModeTracker::default(),
            detector: Detector::new(DEFAULT_HYSTERESIS),
            last_output: Instant::now(),
            last_input: Instant::now(),
            last_cpu: None,
            command: None,
            subs: Vec::new(),
            alive: true,
            persist,
            since_dump: 0,
            detached_at: Some(Instant::now()),
        }));

        let session_id = id.clone();
        let reader_inner = Arc::clone(&inner);
        thread::spawn(move || {
            let mut buf = [0u8; READ_BUFFER_LEN];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let dump = {
                            let mut g = reader_inner.lock_ignore_poison();
                            g.ring.push(&buf[..n]);
                            g.modes.feed(&buf[..n]);
                            let now = Instant::now();
                            let is_echo = now.duration_since(g.last_input) < ECHO_WINDOW;
                            g.last_output = now;
                            let change = g.detector.on_output(&buf[..n], is_echo);
                            g.broadcast(ServerMsg::Output {
                                id: id.clone(),
                                data: buf[..n].to_vec(),
                            });
                            if let Some(change) = change {
                                g.broadcast_state(&id, change);
                            }
                            g.mark_detached_if_empty();
                            g.pending_dump(n)
                        };
                        if let Some((path, data)) = dump {
                            let _ = dump_to(&path, &data);
                        }
                    }
                }
            }
            let final_dump = {
                let mut g = reader_inner.lock_ignore_poison();
                g.alive = false;
                let code = g
                    .child
                    .wait()
                    .ok()
                    .map(|s| s.exit_code() as i32)
                    .unwrap_or(-1);
                if let Some(change) = g.detector.on_exit(code) {
                    g.broadcast_state(&id, change);
                }
                g.broadcast(ServerMsg::Exit { id: id.clone() });
                g.persist.clone().map(|p| (p, g.ring.snapshot()))
            };
            if let Some((path, data)) = final_dump {
                let _ = dump_to(&path, &data);
            }
        });

        Ok(Session {
            inner,
            id: session_id,
        })
    }

    pub fn attach(&self, client: u64, sub: SyncSender<ServerMsg>, id: &str) {
        let mut g = self.inner.lock_ignore_poison();
        let snap = g.ring.snapshot();
        if !snap.is_empty()
            && sub
                .try_send(ServerMsg::Snapshot {
                    id: id.to_string(),
                    data: snap,
                })
                .is_err()
        {
            // The client's queue is already saturated; without the snapshot its
            // view would be corrupt, so let it reconnect instead.
            return;
        }
        // The replayed history can end with a dangling mouse-enable left by a
        // TUI that died with the old daemon (no paired reset ever arrived), so
        // a fresh login shell would otherwise echo raw mouse escape sequences
        // as text. Turn those modes off before re-asserting the live tracker's
        // state below, so a still-running TUI can re-enable its own mouse
        // while a plain shell stays clean.
        const NORMALIZE: &[u8] = b"\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l";
        if sub
            .try_send(ServerMsg::Output {
                id: id.to_string(),
                data: NORMALIZE.to_vec(),
            })
            .is_err()
        {
            return;
        }
        // Re-assert the sticky DEC private modes the ring replay can't rebuild
        // (cursor visibility, mouse, bracketed paste), so a reattaching TUI does
        // not surface a stray cursor or lose mouse input.
        let restore = g.modes.restore_seq();
        if !restore.is_empty()
            && sub
                .try_send(ServerMsg::Output {
                    id: id.to_string(),
                    data: restore,
                })
                .is_err()
        {
            return;
        }
        if g.alive {
            g.subs.push(Sub { client, tx: sub });
            g.detached_at = None;
        } else {
            let _ = sub.try_send(ServerMsg::Exit { id: id.to_string() });
        }
    }

    pub fn detach(&self, client: u64) {
        let mut g = self.inner.lock_ignore_poison();
        g.subs.retain(|s| s.client != client);
        g.mark_detached_if_empty();
    }

    pub fn input(&self, data: &[u8]) {
        let mut g = self.inner.lock_ignore_poison();
        let _ = g.writer.write_all(data);
        let _ = g.writer.flush();
        g.last_input = Instant::now();
        if let Some(change) = g.detector.on_input() {
            g.broadcast_state(&self.id, change);
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        let g = self.inner.lock_ignore_poison();
        let _ = g.master.resize(pty_size(cols, rows));
    }

    pub fn kill(&self) {
        let mut g = self.inner.lock_ignore_poison();
        let _ = g.child.kill();
        // Reap immediately; otherwise the shell lingers as a zombie until the
        // daemon itself exits.
        let _ = g.child.wait();
        g.alive = false;
        // Take the persist path so the reader thread's final dump can't recreate
        // the file after we unlink it: a killed session is gone for good, so its
        // scrollback buffer must not leak on disk.
        if let Some(path) = g.persist.take() {
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::remove_file(path.with_extension("tmp"));
        }
    }

    pub fn alive(&self) -> bool {
        self.inner.lock_ignore_poison().alive
    }

    pub fn has_subs(&self) -> bool {
        !self.inner.lock_ignore_poison().subs.is_empty()
    }

    pub fn orphan_for(&self) -> Option<Duration> {
        self.inner
            .lock_ignore_poison()
            .detached_at
            .map(|t| t.elapsed())
    }

    /// Single-lock snapshot for the reaper: reading alive/subs/orphan age via
    /// separate calls would interleave with the reader thread.
    pub fn reap_state(&self) -> ReapState {
        let g = self.inner.lock_ignore_poison();
        ReapState {
            alive: g.alive,
            has_subs: !g.subs.is_empty(),
            orphaned_for: g.detached_at.map(|t| t.elapsed()),
        }
    }

    pub fn pid(&self) -> Option<u32> {
        let g = self.inner.lock_ignore_poison();
        if g.alive { g.child.process_id() } else { None }
    }

    pub fn probe(&self) -> Snapshot {
        match self.pid() {
            Some(pid) => snapshot_of(pid),
            None => Snapshot::default(),
        }
    }

    /// One periodic re-evaluation of the agent state (Layers 0+1+3). Broadcasts
    /// a `State` message to this session's subscribers only when the state or
    /// confidence actually changed, so the wire carries transitions, not ticks.
    pub fn tick(&self, idle_threshold: Duration, tentative_threshold: Duration, now: Instant) {
        let mut g = self.inner.lock_ignore_poison();
        if !g.alive {
            return;
        }
        let (status, cpu_idle) = match g.child.process_id() {
            Some(pid) => {
                let status = proc_status(pid);
                let cpu_now = cpu_ticks(pid);
                let cpu_idle = matches!(
                    (g.last_cpu, cpu_now),
                    (Some(prev), Some(cur)) if cur.saturating_sub(prev) < CPU_IDLE_DELTA_NS
                );
                g.last_cpu = cpu_now;
                g.command = foreground_command(pid);
                (status, cpu_idle)
            }
            None => (ProcStatus::Gone, true),
        };
        let silence = now.duration_since(g.last_output);
        let idle = silence >= idle_threshold;
        let long_idle = silence >= tentative_threshold;
        let tail = tail_text(&g.ring.snapshot(), TAIL_BYTES);
        if let Some(change) = g.detector.tick(idle, long_idle, status, cpu_idle, &tail) {
            g.broadcast_state(&self.id, change);
        }
    }
}

/// Strips CSI and OSC escape sequences from the last `n` bytes of a raw ring
/// snapshot so the prompt classifier (Layer 3) sees plain text, not control codes.
fn tail_text(buf: &[u8], n: usize) -> String {
    let slice = &buf[buf.len().saturating_sub(n)..];
    let mut out: Vec<u8> = Vec::with_capacity(slice.len());
    let mut i = 0;
    while i < slice.len() {
        if slice[i] == 0x1b {
            i += 1;
            match slice.get(i) {
                Some(b'[') => {
                    i += 1;
                    while i < slice.len() && !(0x40..=0x7e).contains(&slice[i]) {
                        i += 1;
                    }
                    i += 1;
                }
                Some(b']') => {
                    i += 1;
                    while i < slice.len() && slice[i] != 0x07 && slice[i] != 0x1b {
                        i += 1;
                    }
                    i += 1;
                }
                _ => i += 1,
            }
        } else {
            out.push(slice[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::sync_channel;
    use std::time::{Duration, Instant};

    const TEST_QUEUE_CAP: usize = 64;

    #[test]
    fn spawn_and_attach_deliver_command_output() {
        let session = Session::spawn(
            "t".into(),
            80,
            24,
            Some("/tmp".into()),
            Some("echo SHIREI_OK".into()),
            64 * 1024,
            None,
        )
        .unwrap();
        let (tx, rx) = sync_channel(TEST_QUEUE_CAP);
        session.attach(0, tx, "t");

        let deadline = Instant::now() + Duration::from_secs(6);
        let mut got: Vec<u8> = Vec::new();
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(250)) {
                Ok(ServerMsg::Output { data, .. } | ServerMsg::Snapshot { data, .. }) => {
                    got.extend(data);
                    if String::from_utf8_lossy(&got).contains("SHIREI_OK") {
                        break;
                    }
                }
                Ok(_) => {}
                Err(_) => {}
            }
        }
        session.kill();
        assert!(
            String::from_utf8_lossy(&got).contains("SHIREI_OK"),
            "expected output never arrived"
        );
    }

    #[test]
    fn exit_broadcasts_a_done_state_with_the_code() {
        use crate::detect::AgentState;
        let session = Session::spawn(
            "x".into(),
            80,
            24,
            Some("/tmp".into()),
            None,
            64 * 1024,
            None,
        )
        .unwrap();
        let (tx, rx) = sync_channel(TEST_QUEUE_CAP);
        session.attach(0, tx, "x");
        // Attach first, then trigger the exit, so the Done broadcast can't race
        // ahead of the subscriber (State messages are not replayed from the ring).
        std::thread::sleep(Duration::from_millis(300));
        session.input(b"exit 0\n");

        let deadline = Instant::now() + Duration::from_secs(6);
        let mut done_code = None;
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(250)) {
                Ok(ServerMsg::State {
                    state: AgentState::Done { code },
                    ..
                }) => {
                    done_code = Some(code);
                    break;
                }
                Ok(ServerMsg::Exit { .. }) => break,
                _ => {}
            }
        }
        session.kill();
        assert_eq!(done_code, Some(0), "exit did not broadcast Done{{code:0}}");
    }

    #[test]
    fn ticking_an_idle_session_broadcasts_waiting() {
        use crate::detect::AgentState;
        let session = Session::spawn(
            "w".into(),
            80,
            24,
            Some("/tmp".into()),
            Some("sleep 5".into()),
            64 * 1024,
            None,
        )
        .unwrap();
        let (tx, rx) = sync_channel(TEST_QUEUE_CAP);
        session.attach(0, tx, "w");
        // Let the shell start `sleep` and drain the initial prompt/echo, so the
        // transition we assert is the tick-driven one, not startup output.
        std::thread::sleep(Duration::from_millis(500));
        while rx.try_recv().is_ok() {}

        // Zero idle threshold + the shell blocked in `sleep` (≈0 CPU): once past
        // the CPU-idle warmup tick and the hysteresis, it must flip to Waiting.
        let deadline = Instant::now() + Duration::from_secs(4);
        let mut saw_waiting = false;
        while Instant::now() < deadline {
            session.tick(Duration::ZERO, Duration::from_secs(45), Instant::now());
            if let Ok(ServerMsg::State {
                state: AgentState::Waiting(_),
                ..
            }) = rx.recv_timeout(Duration::from_millis(150))
            {
                saw_waiting = true;
                break;
            }
        }
        session.kill();
        assert!(saw_waiting, "an idle session never flipped to Waiting");
    }

    #[test]
    fn preload_replays_the_buffer_saved_on_disk() {
        let path =
            std::env::temp_dir().join(format!("shirei-mux-preload-{}.buf", std::process::id()));
        std::fs::write(&path, b"OLD_OUTPUT\n").unwrap();

        let session = Session::spawn(
            "p".into(),
            80,
            24,
            Some("/tmp".into()),
            None,
            64 * 1024,
            Some(path.clone()),
        )
        .unwrap();
        let (tx, rx) = sync_channel(TEST_QUEUE_CAP);
        session.attach(0, tx, "p");

        let mut got: Vec<u8> = Vec::new();
        if let Ok(ServerMsg::Snapshot { data, .. } | ServerMsg::Output { data, .. }) =
            rx.recv_timeout(Duration::from_secs(2))
        {
            got.extend(data);
        }
        session.kill();
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("tmp"));
        assert!(
            String::from_utf8_lossy(&got).contains("OLD_OUTPUT"),
            "snapshot did not replay the preloaded buffer"
        );
    }

    #[test]
    fn detach_marks_the_session_as_orphaned() {
        let session = Session::spawn(
            "d".into(),
            80,
            24,
            Some("/tmp".into()),
            None,
            64 * 1024,
            None,
        )
        .unwrap();
        let (tx, _rx) = sync_channel(TEST_QUEUE_CAP);
        session.attach(7, tx, "d");
        assert!(session.has_subs());
        assert!(session.orphan_for().is_none());
        session.detach(7);
        assert!(!session.has_subs());
        assert!(session.orphan_for().is_some());
        session.kill();
    }

    #[test]
    fn pid_is_none_after_kill() {
        let session = Session::spawn(
            "k".into(),
            80,
            24,
            Some("/tmp".into()),
            None,
            64 * 1024,
            None,
        )
        .unwrap();
        assert!(session.pid().is_some());
        session.kill();
        assert!(session.pid().is_none());
        assert_eq!(session.probe(), Snapshot::default());
    }

    #[test]
    fn kill_unlinks_the_persist_file() {
        let path =
            std::env::temp_dir().join(format!("shirei-mux-killbuf-{}.buf", std::process::id()));
        std::fs::write(&path, b"OLD_SCROLLBACK\n").unwrap();

        let session = Session::spawn(
            "kb".into(),
            80,
            24,
            Some("/tmp".into()),
            None,
            64 * 1024,
            Some(path.clone()),
        )
        .unwrap();
        assert!(path.exists());

        session.kill();
        assert!(
            !path.exists(),
            "the persist file must be unlinked when a session is killed"
        );
    }

    #[test]
    fn a_saturated_subscriber_is_dropped_not_buffered() {
        let session = Session::spawn(
            "s".into(),
            80,
            24,
            Some("/tmp".into()),
            Some("yes shirei | head -c 200000; echo DONE".into()),
            64 * 1024,
            None,
        )
        .unwrap();
        let (tx, rx) = sync_channel(1);
        session.attach(1, tx, "s");

        let deadline = Instant::now() + Duration::from_secs(6);
        while session.has_subs() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        let dropped = !session.has_subs();
        drop(rx);
        session.kill();
        assert!(dropped, "slow subscriber was never dropped");
    }
}
