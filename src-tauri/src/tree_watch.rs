use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use notify::event::{CreateKind, EventKind, ModifyKind, RemoveKind, RenameMode};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, State};

use crate::config::ConfigManager;
use crate::error::{Error, Result};

#[derive(Default)]
pub struct TreeWatch(Mutex<Option<RecommendedWatcher>>);

// Only structural changes move rows in the tree; content writes (Modify::Data,
// Access) are the bulk of the event volume and never change the listing, so
// filtering to them here keeps the refresh from firing on every keystroke a
// CLI streams into a file.
fn is_structural(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(CreateKind::File | CreateKind::Folder | CreateKind::Any)
            | EventKind::Remove(RemoveKind::File | RemoveKind::Folder | RemoveKind::Any)
            | EventKind::Modify(ModifyKind::Name(
                RenameMode::From | RenameMode::To | RenameMode::Both | RenameMode::Any
            ))
    )
}

fn under_excluded(path: &Path, exclude: &[String]) -> bool {
    path.components().any(|c| {
        let seg = c.as_os_str().to_string_lossy();
        exclude.iter().any(|e| e == seg.as_ref())
    })
}

#[tauri::command]
pub fn tree_watch(
    app: AppHandle,
    state: State<'_, TreeWatch>,
    config: State<'_, ConfigManager>,
    path: Option<String>,
) -> Result<()> {
    // Dropping the stored watcher stops the OS watch and, with it, the sender
    // half held in the callback, so the debounce thread below exits on its own.
    let mut slot = state.0.lock().unwrap_or_else(|e| e.into_inner());
    *slot = None;

    let Some(path) = path else {
        return Ok(());
    };

    let exclude = config.files().exclude_dirs;
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        let Ok(event) = res else { return };
        if !is_structural(&event.kind) {
            return;
        }
        if event.paths.iter().all(|p| under_excluded(p, &exclude)) {
            return;
        }
        let _ = tx.send(());
    })
    .map_err(|e| Error::Os(e.to_string()))?;
    watcher
        .watch(Path::new(&path), RecursiveMode::Recursive)
        .map_err(|e| Error::Os(e.to_string()))?;
    *slot = Some(watcher);

    let handle = app.clone();
    std::thread::spawn(move || {
        loop {
            if rx.recv().is_err() {
                break;
            }
            // Coalesce the burst a single operation (unzip, checkout, generate)
            // produces into one refresh.
            while rx.recv_timeout(Duration::from_millis(200)).is_ok() {}
            let _ = handle.emit("tree-changed", ());
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::AccessKind;

    #[test]
    fn structural_kinds_pass_content_and_access_filtered() {
        assert!(is_structural(&EventKind::Create(CreateKind::File)));
        assert!(is_structural(&EventKind::Remove(RemoveKind::Folder)));
        assert!(is_structural(&EventKind::Modify(ModifyKind::Name(
            RenameMode::Both
        ))));
        assert!(!is_structural(&EventKind::Modify(ModifyKind::Data(
            notify::event::DataChange::Content
        ))));
        assert!(!is_structural(&EventKind::Access(AccessKind::Read)));
    }

    #[test]
    fn under_excluded_matches_by_component_not_substring() {
        let exclude = vec!["node_modules".to_string(), ".git".to_string()];
        assert!(under_excluded(
            Path::new("/proj/node_modules/pkg/index.js"),
            &exclude
        ));
        assert!(under_excluded(Path::new("/proj/.git/HEAD"), &exclude));
        assert!(!under_excluded(Path::new("/proj/src/main.rs"), &exclude));
        // A dir whose name merely contains an excluded name is not excluded.
        assert!(!under_excluded(
            Path::new("/proj/node_modules_backup/x"),
            &exclude
        ));
    }
}
