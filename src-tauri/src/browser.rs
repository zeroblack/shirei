use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, WebviewUrl, Window};

use crate::error::{Error, Result};

const DEV_ORIGIN: &str = "http://localhost:1420";

// Blocks non-http(s) schemes (file://, tauri://) and, in dev builds, the app's
// own devUrl origin: a page redirecting there would otherwise run as a Local
// IPC origin instead of Remote.
pub(crate) fn allowed_url(url: &str) -> bool {
    let http = url.starts_with("http://") || url.starts_with("https://");
    let dev_origin = cfg!(debug_assertions) && url.starts_with(DEV_ORIGIN);
    http && !dev_origin
}

#[derive(serde::Serialize, Clone)]
struct Navigated {
    label: String,
    url: String,
    title: String,
}

fn webview(app: &AppHandle, label: &str) -> Result<tauri::Webview<tauri::Wry>> {
    app.get_webview(label)
        .ok_or_else(|| Error::Browser(format!("no browser webview {label}")))
}

#[tauri::command]
pub fn browser_open(
    window: Window,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<()> {
    if !allowed_url(&url) {
        return Err(Error::Browser(format!("blocked url {url}")));
    }
    let parsed: tauri::Url = url
        .parse()
        .map_err(|_| Error::Browser(format!("bad url {url}")))?;
    let owner = window.label().to_string();
    let load_label = label.clone();
    let title_label = label.clone();
    let title_owner = owner.clone();
    let builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .on_navigation(|u| u.as_str() == "about:blank" || allowed_url(u.as_str()))
        // No webview handle is available here to force a same-view navigation
        // (the closure only receives the target URL), so target=_blank links
        // (common on YouTube) open natively when allowed, or are denied.
        .on_new_window(|url, _features| {
            if allowed_url(url.as_str()) {
                NewWindowResponse::Allow
            } else {
                NewWindowResponse::Deny
            }
        })
        .on_page_load(move |wv, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let _ = wv.emit_to(
                    owner.as_str(),
                    "browser://navigated",
                    Navigated {
                        label: load_label.clone(),
                        url: payload.url().to_string(),
                        title: String::new(),
                    },
                );
            }
        })
        .on_document_title_changed(move |wv, title| {
            let url = wv.url().map(|u| u.to_string()).unwrap_or_default();
            let _ = wv.emit_to(
                title_owner.as_str(),
                "browser://navigated",
                Navigated {
                    label: title_label.clone(),
                    url,
                    title,
                },
            );
        });
    window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width.max(1.0), height.max(1.0)),
        )
        .map_err(|e| Error::Browser(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub fn browser_navigate(app: AppHandle, label: String, url: String) -> Result<()> {
    if !allowed_url(&url) {
        return Err(Error::Browser(format!("blocked url {url}")));
    }
    let parsed = url
        .parse()
        .map_err(|_| Error::Browser(format!("bad url {url}")))?;
    webview(&app, &label)?
        .navigate(parsed)
        .map_err(|e| Error::Browser(e.to_string()))
}

#[tauri::command]
pub fn browser_back(app: AppHandle, label: String) -> Result<()> {
    webview(&app, &label)?
        .eval("history.back()")
        .map_err(|e| Error::Browser(e.to_string()))
}

#[tauri::command]
pub fn browser_forward(app: AppHandle, label: String) -> Result<()> {
    webview(&app, &label)?
        .eval("history.forward()")
        .map_err(|e| Error::Browser(e.to_string()))
}

#[tauri::command]
pub fn browser_reload(app: AppHandle, label: String) -> Result<()> {
    webview(&app, &label)?
        .reload()
        .map_err(|e| Error::Browser(e.to_string()))
}

#[tauri::command]
pub fn browser_set_bounds(
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
        .map_err(|e| Error::Browser(e.to_string()))
}

#[tauri::command]
pub fn browser_url(app: AppHandle, label: String) -> Result<String> {
    webview(&app, &label)?
        .url()
        .map(|u| u.to_string())
        .map_err(|e| Error::Browser(e.to_string()))
}

#[tauri::command]
pub fn browser_show(app: AppHandle, label: String) -> Result<()> {
    webview(&app, &label)?
        .show()
        .map_err(|e| Error::Browser(e.to_string()))
}

#[tauri::command]
pub fn browser_hide(app: AppHandle, label: String) -> Result<()> {
    webview(&app, &label)?
        .hide()
        .map_err(|e| Error::Browser(e.to_string()))
}

#[tauri::command]
pub fn browser_focus(app: AppHandle, label: String) -> Result<()> {
    webview(&app, &label)?
        .set_focus()
        .map_err(|e| Error::Browser(e.to_string()))
}

// A focused child browser webview holds the window's first responder, so the
// main webview stops receiving key events and its JS shortcuts (pane nav, pin)
// go dead. DOM focus() from the main webview does not reliably wrest it back
// across the native boundary, so make the main webview first responder outright.
#[tauri::command]
pub fn browser_release_focus(app: AppHandle, window: Window) -> Result<()> {
    let label = window.label().to_string();
    let Some(wv) = app.get_webview(&label) else {
        return Ok(());
    };
    wv.with_webview(move |platform| {
        use objc2_app_kit::{NSResponder, NSView};
        // SAFETY: PlatformWebview::inner() is the WKWebView (an NSView) for the
        // duration of this callback, which wry runs on the main thread.
        let view: &NSView = unsafe { &*(platform.inner() as *const NSView) };
        if let Some(win) = view.window() {
            let responder: &NSResponder = view;
            win.makeFirstResponder(Some(responder));
        }
    })
    .map_err(|e| Error::Browser(e.to_string()))
}

// wry's macOS backend re-retains the WKWebView after removeFromSuperview as a
// workaround for an Objective-C crash (see InnerWebView::drop in wry's
// wkwebview/mod.rs), so the object is deliberately leaked: closing alone
// detaches it from the window but never unloads its page, leaving any playing
// audio/video running indefinitely. Navigating to about:blank alone races the
// close and often loses, so first pause and mute every media element in the
// page (webview messages run in order, and the eval runs even on the leaked
// object), then unload with about:blank, then close. The eval only pauses and
// mutes: emptying the element (removeAttribute + load) fires emptied/error at
// the page's own player, which reads that as "this one is over" and autoplays
// the next one in a fresh, unmuted element before the close lands. Closing a
// child webview also doesn't reliably resign first responder, so focus is
// handed back to the owning window explicitly.
const STOP_MEDIA_JS: &str = "try{document.querySelectorAll('video,audio').forEach(function(m){m.muted=true;m.pause()})}catch(e){}";

#[tauri::command]
pub fn browser_close(app: AppHandle, window: Window, label: String) -> Result<()> {
    let wv = webview(&app, &label)?;
    let _ = wv.eval(STOP_MEDIA_JS);
    let _ = wv.navigate("about:blank".parse().expect("valid url"));
    wv.close().map_err(|e| Error::Browser(e.to_string()))?;
    let _ = window.set_focus();
    Ok(())
}

// wry 0.55.1's cross-platform Theme/with_theme is WebView2 (Windows) only; the
// WKWebView backend has no equivalent, so the color scheme is forced the
// native macOS way: WKWebView is an NSView and NSView conforms to
// NSAppearanceCustomization, so setAppearance mirrors what AppKit does for
// prefers-color-scheme. "auto" clears it back to following the window.
#[tauri::command]
pub fn browser_set_color_scheme(app: AppHandle, label: String, scheme: String) -> Result<()> {
    let wv = webview(&app, &label)?;
    wv.with_webview(move |platform| {
        use objc2_app_kit::{
            NSAppearance, NSAppearanceCustomization, NSAppearanceNameAqua,
            NSAppearanceNameDarkAqua, NSView,
        };
        // SAFETY: PlatformWebview::inner() returns the WKWebView pointer for
        // the lifetime of this callback, which wry runs on the main thread;
        // WKWebView is an NSView subclass.
        let view: &NSView = unsafe { &*(platform.inner() as *const NSView) };
        let appearance = match scheme.as_str() {
            "dark" => NSAppearance::appearanceNamed(unsafe { NSAppearanceNameDarkAqua }),
            "light" => NSAppearance::appearanceNamed(unsafe { NSAppearanceNameAqua }),
            _ => None,
        };
        view.setAppearance(appearance.as_deref());
    })
    .map_err(|e| Error::Browser(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::allowed_url;

    #[test]
    fn only_http_schemes_and_not_dev_origin() {
        assert!(allowed_url("https://youtube.com"));
        assert!(allowed_url("http://localhost:5173"));
        assert!(!allowed_url("file:///etc/passwd"));
        assert!(!allowed_url("tauri://x"));
        if cfg!(debug_assertions) {
            assert!(!allowed_url("http://localhost:1420/anything"));
        }
    }
}
