use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::{Arc, mpsc};
use std::time::Duration;

use notify::event::ModifyKind;
use notify::{Event, EventKind, RecursiveMode, Watcher};

use crate::fs::{IndexEntry, home_library};

pub struct WatchPatch {
    pub added: Vec<IndexEntry>,
    pub removed: Vec<String>,
}

// FSEvents on macOS runs with per-file precision but has no notion of a paired
// rename: both the source and the target of a move surface as
// `Modify(Name(RenameMode::Any))`, and a plain create is sometimes folded into
// a `Modify` flag alongside `Create`. Trying to trust the event kind to decide
// added-vs-removed is a losing game; instead we treat Create/Remove/Name
// events as "this path moved", buffer the touched paths for the debounce
// window, then resolve each one against the filesystem once the burst settles.
// Pure content/metadata modifications on already-known files are ignored — the
// index only tracks path existence, not content.
fn is_structural(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_))
    )
}

fn to_index_entry(root: &Path, path: &Path) -> Option<IndexEntry> {
    if path == root {
        return None;
    }
    let home_lib = home_library();
    if home_lib.as_deref() == Some(path) {
        return None;
    }
    let rel = path.strip_prefix(root).ok()?.to_string_lossy().into_owned();
    let name = path.file_name()?.to_string_lossy().into_owned();
    let is_dir = path.metadata().ok()?.is_dir();
    Some(IndexEntry { rel, name, is_dir })
}

// An atomic save (write-temp-then-rename-over-target) re-fires as an `added`
// event for a path the initial walk already indexed. Dropping every rel the
// patch touches — added or removed — before extending makes `added`
// replace-in-place instead of appending a duplicate `IndexEntry`.
pub fn apply_patch(entries: &mut Vec<IndexEntry>, patch: &WatchPatch) {
    let mut drop_set: HashSet<&str> = patch.removed.iter().map(String::as_str).collect();
    drop_set.extend(patch.added.iter().map(|e| e.rel.as_str()));
    entries.retain(|e| !drop_set.contains(e.rel.as_str()));
    entries.extend(patch.added.iter().cloned());
}

fn resolve(root: &Path, touched: HashSet<PathBuf>) -> WatchPatch {
    let mut added = Vec::new();
    let mut removed = Vec::new();
    for path in touched {
        if path == root {
            continue;
        }
        match to_index_entry(root, &path) {
            Some(entry) => added.push(entry),
            None if path.exists() => {}
            None => {
                if let Ok(rel) = path.strip_prefix(root) {
                    removed.push(rel.to_string_lossy().into_owned());
                }
            }
        }
    }
    WatchPatch { added, removed }
}

// The watcher is created and registered on the caller's thread, synchronously,
// before `spawn` returns. FSEvents only delivers events that occur after the
// stream is live — if setup were deferred to the background thread, a file
// created right after `spawn()` returns could race the watch registration and
// go unseen. The background thread then owns the watcher purely to keep it
// alive for the debounce loop's lifetime.
pub fn spawn(
    root: PathBuf,
    debounce: Duration,
    cancel: Arc<AtomicBool>,
    on_change: impl Fn(WatchPatch) + Send + 'static,
) {
    // FSEvents reports fully-resolved paths (e.g. `/private/var/...` for a
    // `/var/...` root on macOS, where `/var` is itself a symlink). Canonicalize
    // once up front so every event path strips against the same root the
    // caller's `rel` paths are meant to be relative to.
    let root = std::fs::canonicalize(&root).unwrap_or(root);
    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher = match notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    }) {
        Ok(watcher) => watcher,
        Err(err) => {
            log::warn!(
                "quick-open watcher init failed for {}: {err}",
                root.display()
            );
            return;
        }
    };

    if let Err(err) = watcher.watch(&root, RecursiveMode::Recursive) {
        log::warn!(
            "quick-open watcher failed to watch {}: {err}",
            root.display()
        );
        return;
    }

    std::thread::spawn(move || {
        let _watcher = watcher;
        run(root, debounce, cancel, rx, on_change);
    });
}

fn run(
    root: PathBuf,
    debounce: Duration,
    cancel: Arc<AtomicBool>,
    rx: mpsc::Receiver<notify::Result<Event>>,
    on_change: impl Fn(WatchPatch) + Send + 'static,
) {
    let mut touched: HashSet<PathBuf> = HashSet::new();
    loop {
        if cancel.load(Ordering::Relaxed) {
            return;
        }
        match rx.recv_timeout(debounce) {
            Ok(Ok(event)) => {
                if is_structural(&event.kind) {
                    touched.extend(event.paths);
                }
            }
            Ok(Err(err)) => {
                log::warn!(
                    "quick-open watcher event error for {}: {err}",
                    root.display()
                );
            }
            Err(RecvTimeoutError::Timeout) => {
                if !touched.is_empty() {
                    let patch = resolve(&root, std::mem::take(&mut touched));
                    if !patch.added.is_empty() || !patch.removed.is_empty() {
                        on_change(patch);
                    }
                }
            }
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watcher_reports_created_file() {
        let dir = tempfile::tempdir().unwrap();
        let got = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let g2 = got.clone();
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        spawn(
            dir.path().to_path_buf(),
            std::time::Duration::from_millis(100),
            cancel.clone(),
            move |p| {
                g2.lock()
                    .unwrap()
                    .extend(p.added.into_iter().map(|e| e.rel));
            },
        );
        std::fs::write(dir.path().join("new.ts"), b"").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            if got.lock().unwrap().iter().any(|r| r == "new.ts") {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "watcher never reported new.ts"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        cancel.store(true, std::sync::atomic::Ordering::Relaxed);
    }

    #[test]
    fn watcher_reports_deleted_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("gone.ts");
        std::fs::write(&target, b"").unwrap();
        let got = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let g2 = got.clone();
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        spawn(
            dir.path().to_path_buf(),
            std::time::Duration::from_millis(100),
            cancel.clone(),
            move |p| {
                g2.lock().unwrap().extend(p.removed);
            },
        );
        std::fs::remove_file(&target).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            if got.lock().unwrap().iter().any(|r| r == "gone.ts") {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "watcher never reported gone.ts"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        cancel.store(true, std::sync::atomic::Ordering::Relaxed);
    }

    #[test]
    fn watcher_stops_after_cancel() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let c2 = calls.clone();
        spawn(
            dir.path().to_path_buf(),
            std::time::Duration::from_millis(50),
            cancel.clone(),
            move |_| {
                c2.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            },
        );
        cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        std::thread::sleep(std::time::Duration::from_millis(300));
        std::fs::write(dir.path().join("after-cancel.ts"), b"").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert_eq!(
            calls.load(std::sync::atomic::Ordering::Relaxed),
            0,
            "watcher kept reporting changes after cancel"
        );
    }

    fn entry(rel: &str) -> IndexEntry {
        IndexEntry {
            rel: rel.to_string(),
            name: rel.to_string(),
            is_dir: false,
        }
    }

    #[test]
    fn apply_patch_dedupes_a_reindexed_added_entry() {
        let mut entries = vec![entry("a.ts"), entry("b.ts")];

        apply_patch(
            &mut entries,
            &WatchPatch {
                added: vec![entry("a.ts")],
                removed: vec![],
            },
        );
        assert_eq!(entries.iter().filter(|e| e.rel == "a.ts").count(), 1);
        assert!(entries.iter().any(|e| e.rel == "b.ts"));

        apply_patch(
            &mut entries,
            &WatchPatch {
                added: vec![],
                removed: vec!["b.ts".to_string()],
            },
        );
        assert!(!entries.iter().any(|e| e.rel == "b.ts"));

        apply_patch(
            &mut entries,
            &WatchPatch {
                added: vec![entry("c.ts")],
                removed: vec![],
            },
        );
        assert!(entries.iter().any(|e| e.rel == "c.ts"));
        assert_eq!(entries.iter().filter(|e| e.rel == "a.ts").count(), 1);
        assert_eq!(entries.iter().filter(|e| e.rel == "c.ts").count(), 1);
        assert_eq!(entries.len(), 2);
    }
}
