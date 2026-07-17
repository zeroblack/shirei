use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use shirei_mux::lock::MutexExt;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::config::{ConfigManager, FilesConfig, SearchConfig};
use crate::error::{Error, Result};
use crate::fs::IndexEntry;
use crate::metrics::MetricsStore;
use crate::search::frecency::{self, Frecency};
use crate::search::matcher::Matcher;
use crate::search::walk::{self, WalkOptions};
use crate::search::watch;
use crate::search::{Scope, SearchEvent};

const INDEXING_EVENT_INTERVAL: usize = 2_000;

pub struct Session {
    pub generation: u64,
    pub cancel: Arc<AtomicBool>,
    pub entries: Vec<IndexEntry>,
    pub partial: bool,
    pub matcher: Matcher,
    pub frecency: Option<Frecency>,
    pub channel: Channel<SearchEvent>,
}

#[derive(Default)]
pub struct SearchState {
    inner: Mutex<Option<Session>>,
}

fn resolve_walk_options(scope: Scope, files: &FilesConfig, search: &SearchConfig) -> WalkOptions {
    let mut exclude: Vec<OsString> = files.exclude_dirs.iter().map(OsString::from).collect();
    let hidden = match scope {
        Scope::Project => true,
        Scope::Home => {
            exclude.extend(search.home_exclude_extra.iter().map(OsString::from));
            search.home_hidden
        }
    };
    WalkOptions {
        entries_ceiling: search.walk_entries_ceiling as usize,
        deadline: Some(Instant::now() + Duration::from_millis(search.walk_budget_ms as u64)),
        threads: search.walker_threads as usize,
        respect_gitignore: files.respect_gitignore,
        hidden,
        exclude,
    }
}

fn is_excluded(rel: &str, exclude: &[OsString]) -> bool {
    Path::new(rel)
        .components()
        .any(|c| exclude.iter().any(|x| c.as_os_str() == x.as_os_str()))
}

#[tauri::command]
pub async fn search_start(
    app: AppHandle,
    root: String,
    scope: Scope,
    generation: u64,
    on_event: Channel<SearchEvent>,
) -> Result<()> {
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(Error::NotFound(root));
    }

    let config = app.state::<ConfigManager>().current();
    let opts = resolve_walk_options(scope, &config.files, &config.search);
    let frecency_enabled = config.search.frecency_enabled;
    let frecency_max_multiplier = config.search.frecency_max_multiplier;

    let cancel = Arc::new(AtomicBool::new(false));
    {
        let state = app.state::<SearchState>();
        let mut guard = state.inner.lock_ignore_poison();
        if let Some(prev) = guard.as_ref() {
            prev.cancel.store(true, Ordering::Relaxed);
        }
        *guard = Some(Session {
            generation,
            cancel: Arc::clone(&cancel),
            entries: Vec::new(),
            partial: false,
            matcher: Matcher::new(&config.search),
            frecency: None,
            channel: on_event.clone(),
        });
    }

    let watch_root = root_path.clone();
    let watch_cancel = Arc::clone(&cancel);
    let watch_exclude = opts.exclude.clone();
    let watch_debounce = Duration::from_millis(config.search.watch_debounce_ms as u64);

    let app_for_walk = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let collected: Mutex<Vec<IndexEntry>> = Mutex::new(Vec::new());
        let indexed = AtomicUsize::new(0);

        let outcome = walk::walk(&root_path, &opts, &cancel, |entry| {
            collected.lock_ignore_poison().push(entry);
            let count = indexed.fetch_add(1, Ordering::Relaxed) + 1;
            if count.is_multiple_of(INDEXING_EVENT_INTERVAL) {
                let _ = on_event.send(SearchEvent::Indexing { count });
            }
        });

        let entries = std::mem::take(&mut *collected.lock_ignore_poison());
        let frecency = if frecency_enabled {
            let metrics = app_for_walk.state::<MetricsStore>();
            let paths: Vec<&str> = entries.iter().map(|e| e.rel.as_str()).collect();
            let opens = frecency::lookup(&metrics, &paths);
            Some(Frecency::new(
                opens,
                frecency::now_secs(),
                frecency_max_multiplier,
            ))
        } else {
            None
        };

        let state = app_for_walk.state::<SearchState>();
        let mut guard = state.inner.lock_ignore_poison();
        if let Some(session) = guard.as_mut()
            && session.generation == generation
        {
            session.entries = entries;
            session.partial = outcome.partial;
            session.frecency = frecency;
        }
        drop(guard);

        let _ = on_event.send(SearchEvent::Done {
            total: outcome.visited,
            partial: outcome.partial,
        });
    })
    .await
    .map_err(|e| Error::Os(e.to_string()))?;

    // Spawned only once the walk has assigned `session.entries` — starting it
    // earlier would race a patch delivered mid-walk against the walk's own
    // full assignment, appending a duplicate for a file the walk already saw.
    let app_for_watch = app.clone();
    watch::spawn(watch_root, watch_debounce, watch_cancel, move |patch| {
        let state = app_for_watch.state::<SearchState>();
        let mut guard = state.inner.lock_ignore_poison();
        let Some(session) = guard.as_mut() else {
            return;
        };
        if session.generation != generation {
            return;
        }
        let added = patch
            .added
            .into_iter()
            .filter(|e| !is_excluded(&e.rel, &watch_exclude))
            .collect();
        let patch = watch::WatchPatch {
            added,
            removed: patch.removed,
        };
        watch::apply_patch(&mut session.entries, &patch);
    });

    Ok(())
}

#[tauri::command]
pub fn search_query(app: AppHandle, state: State<'_, SearchState>, generation: u64, query: String) {
    let limit = app
        .state::<ConfigManager>()
        .current()
        .limits
        .quickopen_results;

    let mut guard = state.inner.lock_ignore_poison();
    let Some(session) = guard.as_mut() else {
        return;
    };
    if session.generation != generation {
        return;
    }

    let Session {
        matcher,
        entries,
        partial,
        frecency,
        channel,
        ..
    } = session;
    let items = matcher.query(entries, &query, limit, frecency.as_ref());
    let event = SearchEvent::Results {
        generation,
        items,
        partial: *partial,
    };
    let channel = channel.clone();
    drop(guard);

    let _ = channel.send(event);
}

#[tauri::command]
pub fn search_close(state: State<'_, SearchState>, generation: u64) {
    let mut guard = state.inner.lock_ignore_poison();
    if guard.as_ref().is_some_and(|s| s.generation == generation)
        && let Some(session) = guard.take()
    {
        session.cancel.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn record_open(app: AppHandle, metrics: State<'_, MetricsStore>, path: String) -> Result<()> {
    if !app
        .state::<ConfigManager>()
        .current()
        .search
        .frecency_enabled
    {
        return Ok(());
    }
    frecency::record_open(&metrics, &path, frecency::now_secs())?;
    Ok(())
}

static HEARTBEAT: AtomicU64 = AtomicU64::new(0);

// Used by the E7 harness to prove the IPC thread stays responsive while a
// walk runs on the blocking pool; the automated large-dir check is Task 9.
#[tauri::command]
pub fn search_heartbeat() -> u64 {
    HEARTBEAT.fetch_add(1, Ordering::Relaxed) + 1
}

#[cfg(test)]
mod tests {
    #[test]
    fn cancel_stops_the_walk_promptly() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..5000 {
            std::fs::write(dir.path().join(format!("f{i}")), b"").unwrap();
        }
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let visited = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (c2, v2) = (cancel.clone(), visited.clone());
        let opts = crate::search::walk::WalkOptions {
            entries_ceiling: 1_000_000,
            deadline: None,
            threads: 2,
            respect_gitignore: false,
            hidden: true,
            exclude: vec![],
        };
        let out = crate::search::walk::walk(dir.path(), &opts, &cancel, move |_| {
            let n = v2.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            if n == 50 {
                c2.store(true, std::sync::atomic::Ordering::Relaxed);
            }
        });
        assert!(
            out.visited < 5000,
            "walk kept going after cancel: {}",
            out.visited
        );
    }
}
