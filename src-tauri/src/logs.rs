use std::backtrace::Backtrace;
use std::panic;

use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::error::{Error, Result};

const LOG_FILE: &str = "shirei.log";

// Routes panics through the `log` facade so they land in the rotated log file
// instead of vanishing with the webview. `force_capture` ignores RUST_BACKTRACE
// (a packaged .app is never launched with it set); `flush` defeats the race
// where the process dies before fern writes the line.
pub fn install_panic_logger() {
    let previous = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        log::error!("panic: {info}\nbacktrace:\n{}", Backtrace::force_capture());
        log::logger().flush();
        previous(info);
    }));
}

fn log_file(app: &AppHandle) -> Result<std::path::PathBuf> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| Error::Config(e.to_string()))?;
    Ok(dir.join(LOG_FILE))
}

#[tauri::command]
pub fn log_reveal(app: AppHandle) -> Result<()> {
    let file = log_file(&app)?;
    app.opener()
        .reveal_item_in_dir(file)
        .map_err(|e| Error::Os(e.to_string()))
}
