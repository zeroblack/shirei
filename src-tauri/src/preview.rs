use std::path::Path;

use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Rect, WebviewUrl, Window};

use crate::error::{Error, Result};

fn webview(app: &AppHandle, label: &str) -> Result<tauri::Webview<tauri::Wry>> {
    app.get_webview(label)
        .ok_or_else(|| Error::Os(format!("no preview webview {label}")))
}

// Mirrors assetProtocol.scope ($HOME/**/*): a preview only ever renders a file
// the file tree could already have opened, never an arbitrary path off disk.
// Both sides are canonicalized first, so a `..` sequence or a symlink can't
// walk the real target out of $HOME while still matching the prefix textually.
fn under_home_of(path: &Path, home: &Path) -> bool {
    let (Ok(home), Ok(path)) = (std::fs::canonicalize(home), std::fs::canonicalize(path)) else {
        return false;
    };
    path.starts_with(home)
}

#[tauri::command]
pub fn preview_open(
    window: Window,
    label: String,
    path: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<()> {
    let Some(home) = std::env::var_os("HOME") else {
        return Err(Error::Os("HOME not set".into()));
    };
    let file_path = Path::new(&path);
    if !under_home_of(file_path, Path::new(&home)) {
        return Err(Error::Os(format!("preview path outside home: {path}")));
    }
    let file_url = tauri::Url::from_file_path(file_path)
        .map_err(|_| Error::Os(format!("bad preview path {path}")))?;
    let builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(file_url))
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        // Subresource loads (the Tailwind/font CDNs AI-generated reports pull
        // in) are not navigations and are unaffected; this only stops the
        // preview's TOP-LEVEL frame from turning into a browser.
        .on_navigation(|u| u.scheme() == "file" || u.as_str() == "about:blank")
        .on_new_window(|_url, _features| NewWindowResponse::Deny);
    window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width.max(1.0), height.max(1.0)),
        )
        .map_err(|e| Error::Os(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub fn preview_set_bounds(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<()> {
    webview(&app, &label)?
        .set_bounds(Rect {
            position: LogicalPosition::new(x, y).into(),
            size: LogicalSize::new(width.max(1.0), height.max(1.0)).into(),
        })
        .map_err(|e| Error::Os(e.to_string()))
}

#[tauri::command]
pub fn preview_show(app: AppHandle, label: String) -> Result<()> {
    webview(&app, &label)?
        .show()
        .map_err(|e| Error::Os(e.to_string()))
}

#[tauri::command]
pub fn preview_hide(app: AppHandle, label: String) -> Result<()> {
    webview(&app, &label)?
        .hide()
        .map_err(|e| Error::Os(e.to_string()))
}

#[tauri::command]
pub fn preview_reload(app: AppHandle, label: String) -> Result<()> {
    webview(&app, &label)?
        .reload()
        .map_err(|e| Error::Os(e.to_string()))
}

// Same leaked-WKWebView teardown as the browser pane (see browser.rs): media
// is stopped and the frame is unloaded to about:blank before close, and focus
// is handed back to the owning window since closing a child webview doesn't
// reliably resign first responder.
const STOP_MEDIA_JS: &str = "try{document.querySelectorAll('video,audio').forEach(function(m){m.pause();m.muted=true;m.removeAttribute('src');try{m.load()}catch(e){}})}catch(e){}";

#[tauri::command]
pub fn preview_close(app: AppHandle, window: Window, label: String) -> Result<()> {
    let wv = webview(&app, &label)?;
    let _ = wv.eval(STOP_MEDIA_JS);
    let _ = wv.navigate("about:blank".parse().expect("valid url"));
    wv.close().map_err(|e| Error::Os(e.to_string()))?;
    let _ = window.set_focus();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::under_home_of;
    use std::path::Path;

    #[test]
    fn rejects_paths_outside_home() {
        // An explicit fixture home, never the process-global $HOME, so this
        // stays correct under the default parallel test runner regardless of
        // what other tests do to the real environment.
        let home = std::env::temp_dir().join("shirei-preview-test-home");
        std::fs::create_dir_all(&home).expect("create fixture home");
        // canonicalize needs the file to exist: write one under home to accept.
        let f = home.join("preview.html");
        std::fs::write(&f, b"<!doctype html>").expect("write test file");
        assert!(under_home_of(&f, &home));
        assert!(!under_home_of(Path::new("/etc/passwd"), &home));
        // A `..` sequence that textually starts with the fixture home but
        // resolves outside it.
        assert!(!under_home_of(&home.join("../../etc/passwd"), &home));
        std::fs::remove_dir_all(&home).ok();
    }
}
