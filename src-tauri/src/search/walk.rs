use std::ffi::OsString;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Instant;

use ignore::{WalkBuilder, WalkState};

use crate::fs::{IndexEntry, home_library};

pub struct WalkOptions {
    pub entries_ceiling: usize,
    pub deadline: Option<Instant>,
    pub threads: usize,
    pub respect_gitignore: bool,
    pub hidden: bool,
    pub exclude: Vec<OsString>,
}

pub struct WalkOutcome {
    pub visited: usize,
    pub partial: bool,
}

pub fn walk(
    root: &Path,
    opts: &WalkOptions,
    cancel: &AtomicBool,
    on_entry: impl Fn(IndexEntry) + Sync,
) -> WalkOutcome {
    let visited = AtomicUsize::new(0);
    let ceiling_hit = AtomicBool::new(false);
    let deadline_hit = AtomicBool::new(false);
    let home_lib = home_library();
    let exclude = opts.exclude.clone();

    let walker = WalkBuilder::new(root)
        .hidden(!opts.hidden)
        .git_ignore(opts.respect_gitignore)
        .git_global(opts.respect_gitignore)
        .git_exclude(opts.respect_gitignore)
        .ignore(opts.respect_gitignore)
        .parents(opts.respect_gitignore)
        .require_git(false)
        .threads(opts.threads)
        .filter_entry(move |e| {
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if !is_dir {
                return true;
            }
            if home_lib.as_deref() == Some(e.path()) {
                return false;
            }
            !exclude.iter().any(|x| e.file_name() == x.as_os_str())
        })
        .build_parallel();

    walker.run(|| {
        let visited = &visited;
        let ceiling_hit = &ceiling_hit;
        let deadline_hit = &deadline_hit;
        let on_entry = &on_entry;
        Box::new(move |result| {
            if cancel.load(Ordering::Relaxed) {
                return WalkState::Quit;
            }
            if let Some(deadline) = opts.deadline
                && Instant::now() >= deadline
            {
                deadline_hit.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }
            let Ok(dir) = result else {
                return WalkState::Continue;
            };
            if dir.depth() == 0 {
                return WalkState::Continue;
            }
            let prev = visited.fetch_add(1, Ordering::Relaxed);
            if prev >= opts.entries_ceiling {
                ceiling_hit.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }

            let path = dir.path();
            let rel = path
                .strip_prefix(root)
                .unwrap_or(path)
                .to_string_lossy()
                .into_owned();
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let is_dir = dir.file_type().map(|t| t.is_dir()).unwrap_or(false);
            on_entry(IndexEntry { rel, name, is_dir });

            WalkState::Continue
        })
    });

    WalkOutcome {
        visited: visited.load(Ordering::Relaxed).min(opts.entries_ceiling),
        partial: ceiling_hit.load(Ordering::Relaxed) || deadline_hit.load(Ordering::Relaxed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn walk_stops_at_entries_ceiling() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..500 {
            std::fs::write(dir.path().join(format!("f{i}")), b"").unwrap();
        }
        let visited = std::sync::atomic::AtomicUsize::new(0);
        let opts = WalkOptions {
            entries_ceiling: 100,
            deadline: None,
            threads: 2,
            respect_gitignore: false,
            hidden: true,
            exclude: vec![],
        };
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let out = walk(dir.path(), &opts, &cancel, |_| {
            visited.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        });
        assert!(
            out.visited <= 100,
            "visited {} exceeded ceiling",
            out.visited
        );
        assert!(out.partial, "index must be marked partial when ceiling hit");
    }

    #[test]
    fn walk_content_matches_expected_set_under_budget() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("a")).unwrap();
        std::fs::write(dir.path().join("a/x.ts"), b"").unwrap();
        std::fs::write(dir.path().join("y.rs"), b"").unwrap();
        let got = std::sync::Mutex::new(std::collections::BTreeSet::new());
        let opts = WalkOptions {
            entries_ceiling: 10_000,
            deadline: None,
            threads: 4,
            respect_gitignore: false,
            hidden: true,
            exclude: vec![],
        };
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let out = walk(dir.path(), &opts, &cancel, |e| {
            got.lock().unwrap().insert(e.rel);
        });
        assert!(!out.partial);
        let got = got.into_inner().unwrap();
        assert!(got.contains("a/x.ts") && got.contains("y.rs") && got.contains("a"));
    }

    #[test]
    fn walk_prunes_excludes_and_home_extra() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("node_modules")).unwrap();
        std::fs::write(dir.path().join("node_modules/dep.js"), b"").unwrap();
        std::fs::create_dir_all(dir.path().join(".cache")).unwrap();
        std::fs::write(dir.path().join(".cache/c"), b"").unwrap();
        std::fs::write(dir.path().join(".env.example"), b"").unwrap();
        let collect = |exclude: Vec<std::ffi::OsString>| {
            let set = std::sync::Mutex::new(std::collections::BTreeSet::new());
            let opts = WalkOptions {
                entries_ceiling: 10_000,
                deadline: None,
                threads: 2,
                respect_gitignore: false,
                hidden: true,
                exclude,
            };
            let cancel = std::sync::atomic::AtomicBool::new(false);
            walk(dir.path(), &opts, &cancel, |e| {
                set.lock().unwrap().insert(e.rel);
            });
            set.into_inner().unwrap()
        };
        let project = collect(vec!["node_modules".into()]);
        assert!(!project.iter().any(|p| p.contains("node_modules")));
        assert!(project.contains(".env.example")); // dotfiles visible
        let home = collect(vec!["node_modules".into(), ".cache".into()]);
        assert!(!home.iter().any(|p| p.contains(".cache")));
    }

    #[test]
    fn walk_respects_gitignore_when_enabled() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".gitignore"), b"ignored.txt\n").unwrap();
        std::fs::write(dir.path().join("ignored.txt"), b"").unwrap();
        std::fs::write(dir.path().join("kept.txt"), b"").unwrap();
        let opts = WalkOptions {
            entries_ceiling: 10_000,
            deadline: None,
            threads: 2,
            respect_gitignore: true,
            hidden: true,
            exclude: vec![],
        };
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let got = std::sync::Mutex::new(std::collections::BTreeSet::new());
        walk(dir.path(), &opts, &cancel, |e| {
            got.lock().unwrap().insert(e.rel);
        });
        let got = got.into_inner().unwrap();
        assert!(
            !got.contains("ignored.txt"),
            "gitignored file should be pruned: {got:?}"
        );
        assert!(got.contains("kept.txt"), "kept file missing: {got:?}");
    }
}
