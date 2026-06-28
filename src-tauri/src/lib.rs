mod config;
mod dialog;
#[cfg(target_os = "macos")]
mod dock;
mod error;
mod fonts;
mod fs;
mod git;
mod logs;
mod mux_client;
mod perf;
mod pty;
#[cfg(target_os = "macos")]
mod screencast;
mod session;
mod todos;
mod watch;

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

fn is_app_window(label: &str) -> bool {
    label == "main" || label.starts_with("win-")
}

fn dispatch_focused<P: serde::Serialize + Clone>(app: &tauri::AppHandle, event: &str, payload: P) {
    if let Some(win) = app
        .webview_windows()
        .into_values()
        .find(|w| is_app_window(w.label()) && w.is_focused().unwrap_or(false))
    {
        let _ = win.emit(event, payload);
    }
}

#[tauri::command]
fn close_active_window(app: tauri::AppHandle, window: tauri::WebviewWindow) {
    let remaining = app
        .webview_windows()
        .into_values()
        .filter(|w| is_app_window(w.label()))
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
    let windows = app.webview_windows();
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
        .manage(pty::PtyManager::default())
        .manage(mux_client::MuxClient::default())
        .manage(config::ConfigManager::default())
        .manage(perf::PerfActiveTab::default())
        .manage(todos::TodoStore::default());

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
            }
            watch::start(app.handle());
            perf::spawn(app.handle().clone());
            mux_client::autostart(app.handle());
            Ok(())
        })
        .menu(|handle| {
            let about = MenuItemBuilder::with_id("about", "About Shirei").build(handle)?;
            let settings = MenuItemBuilder::with_id("settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(handle)?;
            let app_menu = SubmenuBuilder::new(handle, "Shirei")
                .item(&about)
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
                .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu])
                .build()
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "about" => open_settings(app, Some("about")),
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
            session::session_cwd,
            session::session_snapshot,
            fs::fs_read_dir,
            fs::fs_read_file,
            fs::fs_image_meta,
            fs::fs_write_file,
            fs::fs_index,
            git::git_file_head,
            git::git_file_history,
            git::git_file_at,
            git::git_blame,
            config::config_get,
            config::config_set,
            todos::todo_list,
            todos::todo_add,
            todos::todo_toggle,
            todos::todo_delete,
            todos::todo_reorder,
            todos::todo_update,
            fonts::font_install,
            fonts::font_installed,
            fonts::font_read,
            fonts::font_remove,
            perf::perf_set_active_tab,
            pty::pty_pid,
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
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && window.label() == "main"
            {
                let _ = window.app_handle().save_window_state(StateFlags::all());
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(context)
        .expect("failed to build the Tauri application")
        .run(|app, event| match event {
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Ready => dock::install(app),
            tauri::RunEvent::Reopen { .. } => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        });
}
