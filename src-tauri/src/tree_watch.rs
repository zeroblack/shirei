use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use git2::Repository;
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

// `index` records staging (what `git add` changes) and `HEAD` records the
// checked-out branch/commit; both live under the repo's real `.git` dir,
// which for a linked worktree is not `<root>/.git` but wherever `repo.path()`
// points. Watched explicitly (and outside `is_structural`/`under_excluded`,
// which would otherwise drop them as excluded content writes) because they
// are the only signal a plain `git add` or `git commit` in the terminal ever
// produces — the tree's own structural watch never fires for either.
fn git_control_files(root: &Path) -> Vec<PathBuf> {
    let Ok(repo) = Repository::discover(root) else {
        return Vec::new();
    };
    let git_dir = repo.path();
    vec![git_dir.join("index"), git_dir.join("HEAD")]
}

enum WatchSignal {
    Tree,
    Git,
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
    let control_file_list = git_control_files(Path::new(&path));
    let control_files: HashSet<PathBuf> = control_file_list.iter().cloned().collect();
    let (tx, rx) = std::sync::mpsc::channel::<WatchSignal>();
    let tx_events = tx.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        let Ok(event) = res else { return };
        if event.paths.iter().any(|p| control_files.contains(p)) {
            let _ = tx_events.send(WatchSignal::Git);
            return;
        }
        if !is_structural(&event.kind) {
            return;
        }
        if event.paths.iter().all(|p| under_excluded(p, &exclude)) {
            return;
        }
        let _ = tx_events.send(WatchSignal::Tree);
    })
    .map_err(|e| Error::Os(e.to_string()))?;
    watcher
        .watch(Path::new(&path), RecursiveMode::Recursive)
        .map_err(|e| Error::Os(e.to_string()))?;
    // The repo's real `.git` dir can sit outside the tree root (linked
    // worktrees), so the recursive watch above may never see it; a direct,
    // non-recursive watch on each control file covers that case too.
    for control_file in &control_file_list {
        let _ = watcher.watch(control_file, RecursiveMode::NonRecursive);
    }
    *slot = Some(watcher);

    let handle = app.clone();
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut saw_tree = matches!(first, WatchSignal::Tree);
            let mut saw_git = matches!(first, WatchSignal::Git);
            // Coalesce the burst a single operation (unzip, checkout, generate,
            // `git add`) produces into one refresh per signal kind.
            while let Ok(signal) = rx.recv_timeout(Duration::from_millis(200)) {
                match signal {
                    WatchSignal::Tree => saw_tree = true,
                    WatchSignal::Git => saw_git = true,
                }
            }
            if saw_tree {
                let _ = handle.emit("tree-changed", ());
            }
            if saw_git {
                let _ = handle.emit("git-changed", ());
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::AccessKind;
    use tempfile::TempDir;

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

    #[test]
    fn git_control_files_resolves_index_and_head_in_a_repo() {
        let tmp = TempDir::new().unwrap();
        git2::Repository::init(tmp.path()).unwrap();
        let files = git_control_files(tmp.path());
        assert_eq!(files.len(), 2);
        assert!(files.iter().any(|p| p.ends_with("index")));
        assert!(files.iter().any(|p| p.ends_with("HEAD")));
    }

    #[test]
    fn git_control_files_empty_outside_a_repo() {
        let tmp = TempDir::new().unwrap();
        assert!(git_control_files(tmp.path()).is_empty());
    }
}
