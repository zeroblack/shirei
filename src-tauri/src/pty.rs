use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use shirei_mux::lock::MutexExt;
use shirei_mux::proc::{Snapshot, snapshot_of};
use shirei_mux::shell::{READ_BUFFER_LEN, ShellPty, open_login_shell, pty_size};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{Error, Result};

struct PtySession {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    pid: Option<u32>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
}

impl PtyManager {
    fn with_session<T>(&self, id: &str, f: impl FnOnce(&mut PtySession) -> Result<T>) -> Result<T> {
        let mut sessions = self.sessions.lock_ignore_poison();
        let session = sessions
            .get_mut(id)
            .ok_or_else(|| Error::SessionNotFound(id.to_string()))?;
        f(session)
    }

    pub fn probe(&self, id: &str) -> Option<Snapshot> {
        let pid = { self.sessions.lock_ignore_poison().get(id)?.pid? };
        Some(snapshot_of(pid))
    }

    pub fn pid_of(&self, id: &str) -> Option<i32> {
        self.sessions
            .lock_ignore_poison()
            .get(id)?
            .pid
            .map(|p| p as i32)
    }
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    manager: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    on_data: Channel<tauri::ipc::Response>,
) -> Result<()> {
    let ShellPty {
        master,
        child,
        mut reader,
        writer,
    } = open_login_shell(cols, rows, cwd, &[])?;
    let pid = child.process_id();

    // Register the session before the reader starts so write/resize never
    // race against a session that exists but is not yet visible.
    manager.sessions.lock_ignore_poison().insert(
        id.clone(),
        PtySession {
            master,
            writer,
            child,
            pid,
        },
    );

    let exit_event = format!("pty-exit-{id}");
    // The reader only copies bytes off the PTY, so it needs nowhere near the 8 MB
    // default stack; cap it so a cockpit with dozens of panes doesn't reserve
    // hundreds of MB of thread stacks (READ_BUFFER_LEN lives here, 512 KB is ample).
    let reader_thread = std::thread::Builder::new()
        .name(format!("pty-reader-{id}"))
        .stack_size(512 * 1024);
    let spawn_result = reader_thread.spawn(move || {
        let mut buf = [0u8; READ_BUFFER_LEN];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if on_data
                        .send(tauri::ipc::Response::new(buf[..n].to_vec()))
                        .is_err()
                    {
                        return;
                    }
                }
            }
        }
        // The shell exited on its own: drop the session and reap the child so its
        // master fd and process handle don't linger until an explicit pty_kill.
        if let Some(mut session) = app
            .state::<PtyManager>()
            .sessions
            .lock_ignore_poison()
            .remove(&id)
        {
            let _ = session.child.wait();
        }
        let _ = app.emit(&exit_event, ());
    });
    spawn_result.expect("failed to spawn the pty reader thread");

    Ok(())
}

#[tauri::command]
pub fn pty_write(manager: State<'_, PtyManager>, id: String, data: String) -> Result<()> {
    manager.with_session(&id, |session| {
        session.writer.write_all(data.as_bytes())?;
        session.writer.flush()?;
        Ok(())
    })
}

#[tauri::command]
pub fn pty_resize(manager: State<'_, PtyManager>, id: String, cols: u16, rows: u16) -> Result<()> {
    manager.with_session(&id, |session| {
        session.master.resize(pty_size(cols, rows))?;
        Ok(())
    })
}

#[tauri::command]
pub fn pty_kill(manager: State<'_, PtyManager>, id: String) {
    let session = manager.sessions.lock_ignore_poison().remove(&id);
    if let Some(mut session) = session {
        let _ = session.child.kill();
        // Reap right away so the shell never lingers as a zombie.
        let _ = session.child.wait();
    }
}
