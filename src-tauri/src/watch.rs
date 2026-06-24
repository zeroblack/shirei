use std::time::Duration;

use notify::{Event, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};

use crate::config::{Config, ConfigManager};

pub fn start(app: &AppHandle) {
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    let watch_path = dir.join("config.json");
    let handle = app.clone();

    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = match notify::recommended_watcher(move |res: notify::Result<Event>| {
            if res.is_ok() {
                let _ = tx.send(());
            }
        }) {
            Ok(w) => w,
            Err(_) => return,
        };
        if watcher
            .watch(&watch_path, RecursiveMode::NonRecursive)
            .is_err()
        {
            return;
        }
        loop {
            if rx.recv().is_err() {
                break;
            }
            // Debounce: coalesce the burst of events a single save produces.
            while rx.recv_timeout(Duration::from_millis(150)).is_ok() {}
            let Ok(text) = std::fs::read_to_string(&watch_path) else {
                continue;
            };
            let parsed = Config::from_json_or_default(&text);
            let manager = handle.state::<ConfigManager>();
            // Re-emit only when it differs from the in-memory state: this breaks
            // the loop with config_set, which stores the value before writing.
            if manager.current() != parsed {
                manager.replace(parsed.clone());
                let _ = handle.emit("config-changed", parsed);
            }
        }
    });
}
