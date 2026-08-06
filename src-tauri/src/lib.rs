mod browser;
mod config;
mod dialog;
#[cfg(target_os = "macos")]
mod dock;
mod error;
mod focus;
mod fonts;
mod fs;
mod git;
mod logs;
mod metrics;
mod mux_client;
mod notify;
mod perf;
mod preview;
mod pty;
#[cfg(target_os = "macos")]
mod screencast;
mod search;
mod session;
#[cfg(target_os = "macos")]
mod shortcuts;
mod todos;
mod tree_watch;
mod watch;

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

fn is_app_window(label: &str) -> bool {
    label == "main" || label.starts_with("win-")
}

// A focused child webview (the browser pane) leaves its owning window reporting
// unfocused, so a menu shortcut fired while it holds focus has no "focused
// window" to route to. Remembering the last app window that actually took focus
// gives that window back as the target — it is still the one the user is in.
static LAST_FOCUSED_WINDOW: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn dispatch_focused<P: serde::Serialize + Clone>(app: &tauri::AppHandle, event: &str, payload: P) {
    // webview_windows() silently drops any window that owns child webviews, and
    // the browser pane makes "main" multi-webview — so it disappears from that
    // map and every lookup through it fails while a browser pane is open. Use
    // the window list instead, whose focus tracks NSWindow key state (true even
    // when a child webview holds first responder), and emit by label.
    let label = app
        .windows()
        .into_iter()
        .find(|(label, w)| is_app_window(label) && w.is_focused().unwrap_or(false))
        .map(|(label, _)| label)
        .or_else(|| {
            LAST_FOCUSED_WINDOW
                .lock()
                .ok()
                .and_then(|l| l.clone())
                .filter(|l| is_app_window(l) && app.get_window(l).is_some())
        })
        .or_else(|| app.windows().into_keys().find(|label| is_app_window(label)));
    if let Some(label) = label {
        let _ = app.emit_to(label.as_str(), event, payload);
    }
}

#[tauri::command]
fn close_active_window(app: tauri::AppHandle, window: tauri::WebviewWindow) {
    let remaining = app
        .windows()
        .into_keys()
        .filter(|label| is_app_window(label))
        .count();
    // Closing the last tab empties the window; with no other app window left
    // there is nothing to keep alive, so quit. Otherwise drop just this window
    // (destroy bypasses the main window's hide-on-close so it actually closes).
    if remaining <= 1 {
        let _ = app.save_window_state(StateFlags::all());
        app.exit(0);
    } else {
        let _ = window.destroy();
    }
}

fn open_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    // windows(), not webview_windows(): a window that owns a browser pane is
    // multi-webview and vanishes from the latter, which would let its label be
    // reused and collide.
    let windows = app.windows();
    let label = (1..)
        .map(|n| format!("win-{n}"))
        .find(|candidate| !windows.contains_key(candidate))
        .expect("a free window label always exists");
    let win =
        tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::App("index.html".into()))
            .title("Shirei")
            .inner_size(1000.0, 660.0)
            .min_inner_size(480.0, 320.0)
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .transparent(true)
            .build()?;
    let _ = win.set_focus();
    Ok(())
}

// Opens (or focuses) the Settings window, optionally landing on a specific
// section. A fresh window carries the section in the URL hash so it's selected
// on load with no race; an already-open one gets an event to navigate.
fn open_settings(app: &tauri::AppHandle, section: Option<&str>) {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.set_focus();
        if let Some(id) = section {
            let _ = win.emit("settings-show-section", id);
        }
        return;
    }
    let url = match section {
        Some(id) => format!("settings.html#{id}"),
        None => "settings.html".into(),
    };
    let _ = tauri::WebviewWindowBuilder::new(app, "settings", tauri::WebviewUrl::App(url.into()))
        .title("Shirei · Settings")
        .inner_size(1240.0, 720.0)
        .min_inner_size(820.0, 500.0)
        .resizable(true)
        .transparent(true)
        .build();
}

#[tauri::command]
fn show_settings(app: tauri::AppHandle, section: Option<String>) {
    open_settings(&app, section.as_deref());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

    let context = tauri::generate_context!();
    let logging = config::load_logging(&context.config().identifier);

    let builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::from(logging.level))
                .level_for("shirei_mux", log::LevelFilter::Debug)
                .max_file_size(u128::from(logging.max_file_mb) * 1024 * 1024)
                .rotation_strategy(RotationStrategy::KeepSome(usize::from(logging.keep_files)))
                .timezone_strategy(TimezoneStrategy::UseLocal)
                .targets([
                    Target::new(TargetKind::LogDir {
                        file_name: Some("shirei".into()),
                    }),
                    Target::new(TargetKind::Stdout),
                ])
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .manage(pty::PtyManager::default())
        .manage(mux_client::MuxClient::default())
        .manage(config::ConfigManager::default())
        .manage(perf::PerfActiveTab::default())
        .manage(todos::TodoStore::default())
        .manage(metrics::MetricsStore::default())
        .manage(tree_watch::TreeWatch::default())
        .manage(search::session::SearchState::default());

    #[cfg(target_os = "macos")]
    let builder = builder.manage(screencast::RecorderState::default());

    builder
        .setup(|app| {
            logs::install_panic_logger();
            log::info!(
                "shirei {} starting on {}",
                env!("CARGO_PKG_VERSION"),
                std::env::consts::OS
            );
            app.state::<config::ConfigManager>().load(app.handle());
            if let Ok(dir) = app.path().app_config_dir() {
                let _ = std::fs::create_dir_all(&dir);
                if let Err(e) = app.state::<todos::TodoStore>().open(&dir.join("todos.db")) {
                    log::error!("failed to open todos.db: {e}");
                }
                if let Err(e) = app
                    .state::<metrics::MetricsStore>()
                    .open(&dir.join("metrics.db"))
                {
                    log::error!("failed to open metrics db: {e}");
                } else {
                    // A crash or force-quit can leave a focus session stuck in
                    // `running`/`paused` forever; anything untouched for longer
                    // than a plausible session is reconciled to `crashed` once
                    // at startup rather than left to mislead stats/UI.
                    let stale_after_s = i64::from(
                        app.state::<config::ConfigManager>()
                            .current()
                            .focus
                            .orphan_stale_after_s,
                    );
                    let store = app.state::<metrics::MetricsStore>();
                    match focus::reconcile_orphans(&store, focus::now_secs(), stale_after_s) {
                        Ok(n) if n > 0 => log::info!("reconciled {n} orphaned focus session(s)"),
                        Ok(_) => {}
                        Err(e) => log::error!("failed to reconcile focus sessions: {e}"),
                    }
                }
            }
            watch::start(app.handle());
            perf::spawn(app.handle().clone());
            mux_client::autostart(app.handle());
            Ok(())
        })
        .menu(|handle| {
            let about = MenuItemBuilder::with_id("about", "About Shirei").build(handle)?;
            let check_updates =
                MenuItemBuilder::with_id("check-updates", "Check for Updates…").build(handle)?;
            let settings = MenuItemBuilder::with_id("settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(handle)?;
            let app_menu = SubmenuBuilder::new(handle, "Shirei")
                .item(&about)
                .item(&check_updates)
                .separator()
                .item(&settings)
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;

            let new_window = MenuItemBuilder::with_id("new-window", "New Window")
                .accelerator("CmdOrCtrl+N")
                .build(handle)?;
            let new_tab = MenuItemBuilder::with_id("new-tab", "New Tab")
                .accelerator("CmdOrCtrl+T")
                .build(handle)?;
            let close_tab = MenuItemBuilder::with_id("close-tab", "Close Tab")
                .accelerator("CmdOrCtrl+W")
                .build(handle)?;
            let file_menu = SubmenuBuilder::new(handle, "File")
                .item(&new_window)
                .separator()
                .item(&new_tab)
                .item(&close_tab)
                .build()?;

            let edit_menu = SubmenuBuilder::new(handle, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            let palette = MenuItemBuilder::with_id("palette", "Command Palette")
                .accelerator("CmdOrCtrl+P")
                .build(handle)?;
            let sidebar = MenuItemBuilder::with_id("toggle-sidebar", "Toggle Sidebar")
                .accelerator("CmdOrCtrl+B")
                .build(handle)?;
            let zoom_in = MenuItemBuilder::with_id("zoom-in", "Zoom In")
                .accelerator("CmdOrCtrl+=")
                .build(handle)?;
            let zoom_out = MenuItemBuilder::with_id("zoom-out", "Zoom Out")
                .accelerator("CmdOrCtrl+-")
                .build(handle)?;
            let zoom_reset = MenuItemBuilder::with_id("zoom-reset", "Actual Size")
                .accelerator("CmdOrCtrl+0")
                .build(handle)?;
            let view_menu = SubmenuBuilder::new(handle, "View")
                .item(&palette)
                .item(&sidebar)
                .separator()
                .item(&zoom_in)
                .item(&zoom_out)
                .item(&zoom_reset)
                .build()?;

            // Pane actions live in the menu (not only the JS keymap) so their
            // accelerators reach the app even while a native browser pane holds
            // keyboard focus: the shortcut monitor gives the menu the first
            // crack, which a focused webview cannot intercept.
            let pin_pane = MenuItemBuilder::with_id("pane-pin", "Pin / Unpin Pane")
                .accelerator("CmdOrCtrl+Control+P")
                .build(handle)?;
            let focus_left = MenuItemBuilder::with_id("pane-focus-left", "Focus Pane Left")
                .accelerator("CmdOrCtrl+Shift+ArrowLeft")
                .build(handle)?;
            let focus_right = MenuItemBuilder::with_id("pane-focus-right", "Focus Pane Right")
                .accelerator("CmdOrCtrl+Shift+ArrowRight")
                .build(handle)?;
            let focus_up = MenuItemBuilder::with_id("pane-focus-up", "Focus Pane Up")
                .accelerator("CmdOrCtrl+Shift+ArrowUp")
                .build(handle)?;
            let focus_down = MenuItemBuilder::with_id("pane-focus-down", "Focus Pane Down")
                .accelerator("CmdOrCtrl+Shift+ArrowDown")
                .build(handle)?;
            // Reload and the address bar live in the menu so their accelerators
            // reach the app while the browser's own webview holds first responder
            // — the address bar is the escape hatch back to app keyboard focus.
            // Back/forward stay off the menu on purpose: ⌘[/⌘] are the editor's
            // dedent/indent, which a global menu accelerator would swallow.
            let browser_reload = MenuItemBuilder::with_id("browser-reload", "Browser Reload")
                .accelerator("CmdOrCtrl+Alt+Shift+R")
                .build(handle)?;
            let browser_url = MenuItemBuilder::with_id("browser-url", "Focus Address Bar")
                .accelerator("CmdOrCtrl+L")
                .build(handle)?;
            let pane_menu = SubmenuBuilder::new(handle, "Pane")
                .item(&pin_pane)
                .separator()
                .item(&focus_left)
                .item(&focus_right)
                .item(&focus_up)
                .item(&focus_down)
                .separator()
                .item(&browser_reload)
                .item(&browser_url)
                .build()?;

            let mut tab_items = Vec::with_capacity(9);
            for i in 1..=9u8 {
                tab_items.push(
                    MenuItemBuilder::with_id(format!("goto-{i}"), format!("Tab {i}"))
                        .accelerator(format!("CmdOrCtrl+{i}"))
                        .build(handle)?,
                );
            }
            let mut window_builder = SubmenuBuilder::new(handle, "Window");
            for item in &tab_items {
                window_builder = window_builder.item(item);
            }
            let window_menu = window_builder.build()?;

            MenuBuilder::new(handle)
                .items(&[
                    &app_menu,
                    &file_menu,
                    &edit_menu,
                    &view_menu,
                    &pane_menu,
                    &window_menu,
                ])
                .build()
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "about" => open_settings(app, Some("about")),
            "check-updates" => {
                let _ = app.emit("menu://check-updates", ());
            }
            "settings" => open_settings(app, None),
            "new-window" => {
                if let Err(e) = open_window(app) {
                    log::error!("failed to open window: {e}");
                }
            }
            "new-tab" => dispatch_focused(app, "menu-new-tab", ()),
            "close-tab" => dispatch_focused(app, "menu-close-tab", ()),
            "palette" => dispatch_focused(app, "menu-palette", ()),
            "toggle-sidebar" => dispatch_focused(app, "menu-toggle-sidebar", ()),
            "pane-pin" => dispatch_focused(app, "menu-pane-pin", ()),
            "pane-focus-left" => dispatch_focused(app, "menu-pane-focus-left", ()),
            "pane-focus-right" => dispatch_focused(app, "menu-pane-focus-right", ()),
            "pane-focus-up" => dispatch_focused(app, "menu-pane-focus-up", ()),
            "pane-focus-down" => dispatch_focused(app, "menu-pane-focus-down", ()),
            "browser-reload" => dispatch_focused(app, "menu-browser-reload", ()),
            "browser-url" => dispatch_focused(app, "menu-browser-url", ()),
            "zoom-in" => dispatch_focused(app, "menu-zoom-in", ()),
            "zoom-out" => dispatch_focused(app, "menu-zoom-out", ()),
            "zoom-reset" => dispatch_focused(app, "menu-zoom-reset", ()),
            other => {
                if let Some(n) = other
                    .strip_prefix("goto-")
                    .and_then(|s| s.parse::<usize>().ok())
                {
                    dispatch_focused(app, "menu-goto-tab", n);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            show_settings,
            close_active_window,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            mux_client::mux_spawn,
            mux_client::mux_write,
            mux_client::mux_resize,
            mux_client::mux_kill,
            mux_client::mux_detach,
            notify::notify_fire,
            session::session_cwd,
            session::session_snapshot,
            session::session_pid,
            fs::fs_read_dir,
            tree_watch::tree_watch,
            fs::fs_read_file,
            fs::fs_image_meta,
            fs::fs_write_file,
            fs::fs_create_file,
            search::session::search_start,
            search::session::search_query,
            search::session::search_close,
            search::session::search_heartbeat,
            search::session::record_open,
            git::git_file_head,
            git::git_file_history,
            git::git_file_at,
            git::git_blame,
            git::git_current_branch,
            config::config_get,
            config::config_set,
            todos::todo_list,
            todos::todo_add,
            todos::todo_toggle,
            todos::todo_delete,
            todos::todo_reorder,
            todos::todo_update,
            metrics::metrics_log,
            focus::focus_session_start,
            focus::focus_session_update,
            focus::focus_session_end,
            fonts::font_install,
            fonts::font_installed,
            fonts::font_read,
            fonts::font_remove,
            perf::perf_set_active_tab,
            logs::log_reveal,
            dialog::pick_project_dir,
            dialog::path_is_git_repo,
            dialog::binary_on_path,
            dialog::open_config_file,
            dialog::reveal_in_finder,
            #[cfg(target_os = "macos")]
            screencast::screencast_start,
            #[cfg(target_os = "macos")]
            screencast::screencast_stop,
            #[cfg(target_os = "macos")]
            screencast::screencast_cancel,
            #[cfg(target_os = "macos")]
            screencast::screencast_copy_to_clipboard,
            #[cfg(target_os = "macos")]
            screencast::screencast_share,
            browser::browser_open,
            browser::browser_navigate,
            browser::browser_back,
            browser::browser_forward,
            browser::browser_reload,
            browser::browser_set_bounds,
            browser::browser_url,
            browser::browser_show,
            browser::browser_hide,
            browser::browser_focus,
            browser::browser_release_focus,
            browser::browser_close,
            browser::browser_set_color_scheme,
            preview::preview_open,
            preview::preview_set_bounds,
            preview::preview_show,
            preview::preview_hide,
            preview::preview_reload,
            preview::preview_close,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(true) = event
                && is_app_window(window.label())
            {
                *LAST_FOCUSED_WINDOW.lock().unwrap() = Some(window.label().to_string());
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && window.label() == "main"
            {
                if let (Ok(sz), Ok(pos)) = (window.outer_size(), window.outer_position()) {
                    log::info!(
                        "[winstate] save main on close: {}x{} @ {},{}",
                        sz.width,
                        sz.height,
                        pos.x,
                        pos.y
                    );
                }
                let _ = window.app_handle().save_window_state(StateFlags::all());
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(context)
        .expect("failed to build the Tauri application")
        .run(|app, event| match event {
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Ready => {
                dock::install(app);
                shortcuts::install();
            }
            tauri::RunEvent::Reopen { .. } => {
                if let Some(window) = app.get_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            tauri::RunEvent::ExitRequested { api, .. } => handle_exit_requested(app, &api),
            _ => {}
        });
}

// Cmd+Q / the "Quit Shirei" menu item calls NSApplication termination directly,
// bypassing WindowEvent::CloseRequested entirely — but RunEvent::ExitRequested
// still fires, giving the frontend's IPC-based metrics buffer one guaranteed
// chance to flush its final session_end before the process actually goes away.
static EXIT_FLUSH_STARTED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

fn handle_exit_requested(app: &tauri::AppHandle, api: &tauri::ExitRequestApi) {
    use std::sync::atomic::Ordering;

    if EXIT_FLUSH_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    api.prevent_exit();
    let _ = app.emit("metrics://flush-on-exit", ());
    let app_handle = app.clone();
    std::thread::spawn(move || {
        // Local IPC needs a moment to land the frontend's final metrics flush
        // before native termination tears the webview down mid-write.
        const EXIT_FLUSH_GRACE_MS: u64 = 400;
        std::thread::sleep(std::time::Duration::from_millis(EXIT_FLUSH_GRACE_MS));
        app_handle.exit(0);
    });
}
