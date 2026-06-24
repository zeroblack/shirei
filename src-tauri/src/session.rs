use shirei_mux::proc::Snapshot;
use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};
use crate::mux_client::MuxClient;
use crate::pty::PtyManager;

// Probing a daemon session blocks on the socket round-trip for up to
// PROBE_TIMEOUT. Run it on the blocking pool so the IPC thread stays free for
// keystrokes and resizes while a slow daemon is answering.
async fn probe_off_thread(app: AppHandle, id: String) -> Result<Snapshot> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(snap) = app.state::<PtyManager>().probe(&id) {
            return Ok(snap);
        }
        Ok(app
            .state::<MuxClient>()
            .probe(&app, &id)?
            .unwrap_or_default())
    })
    .await
    .map_err(|e| Error::Os(e.to_string()))?
}

#[tauri::command]
pub async fn session_cwd(app: AppHandle, id: String) -> Result<Option<String>> {
    Ok(probe_off_thread(app, id).await?.cwd)
}

#[tauri::command]
pub async fn session_snapshot(app: AppHandle, id: String) -> Result<Snapshot> {
    probe_off_thread(app, id).await
}
