use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{Child, MasterPty};

use crate::lock::MutexExt;
use crate::proc::{Snapshot, snapshot_of};
use crate::protocol::ServerMsg;
use crate::ring::Ring;
use crate::shell::{READ_BUFFER_LEN, ShellPty, open_login_shell, pty_size};

pub const DEFAULT_RING_CAP: usize = 256 * 1024;
// Each dump snapshots the whole ring, so a small threshold re-writes the full
// buffer many times per ring of output. At 128 KiB the amplification stays near
// 2x while a crash loses at most this much trailing scrollback.
const DUMP_THRESHOLD: usize = 128 * 1024;

struct Sub {
    client: u64,
    tx: SyncSender<ServerMsg>,
}

struct Inner {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    ring: Ring,
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
            subs: Vec::new(),
            alive: true,
            persist,
            since_dump: 0,
            detached_at: Some(Instant::now()),
        }));

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
                            g.broadcast(ServerMsg::Output {
                                id: id.clone(),
                                data: buf[..n].to_vec(),
                            });
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
                g.broadcast(ServerMsg::Exit { id: id.clone() });
                g.persist.clone().map(|p| (p, g.ring.snapshot()))
            };
            if let Some((path, data)) = final_dump {
                let _ = dump_to(&path, &data);
            }
        });

        Ok(Session { inner })
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
