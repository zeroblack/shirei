use std::path::{Path, PathBuf};

use git2::{Commit, Oid, Repository, Sort, Tree};
use serde::Serialize;
use tauri::State;

use crate::config::ConfigManager;
use crate::error::{Error, Result};

const HISTORY_LIMIT: usize = 200;

fn repo_relative(repo: &Repository, file: &Path) -> Option<PathBuf> {
    let workdir = repo.workdir()?.canonicalize().ok()?;
    let canon = file.canonicalize().ok()?;
    canon.strip_prefix(workdir).ok().map(Path::to_path_buf)
}

fn looks_text(bytes: &[u8]) -> bool {
    !bytes.contains(&0)
}

/// Content of `path` as committed at HEAD. `None` when there is no repo, the
/// file is untracked, the branch is unborn, or the blob is binary — the caller
/// shows the diff view only when there is a committed version to compare against.
#[tauri::command]
pub fn git_file_head(path: String) -> Result<Option<String>> {
    let file = Path::new(&path);
    let Ok(repo) = Repository::discover(file) else {
        return Ok(None);
    };
    let Some(rel) = repo_relative(&repo, file) else {
        return Ok(None);
    };
    let Ok(tree) = repo.head().and_then(|h| h.peel_to_tree()) else {
        return Ok(None);
    };
    let Ok(entry) = tree.get_path(&rel) else {
        return Ok(None);
    };
    let blob = repo.find_blob(entry.id())?;
    if !looks_text(blob.content()) {
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(blob.content()).into_owned()))
}

/// The repo's current branch at `path`, `None` with no repo or a
/// detached/unborn HEAD. Notification identity falls back to the session
/// name when this comes back empty.
#[tauri::command]
pub fn git_current_branch(path: String) -> Result<Option<String>> {
    let Ok(repo) = Repository::discover(Path::new(&path)) else {
        return Ok(None);
    };
    let Ok(head) = repo.head() else {
        return Ok(None);
    };
    Ok(head.shorthand().map(str::to_string))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    sha: String,
    short_sha: String,
    author: String,
    date: i64,
    summary: String,
}

fn commit_info(commit: &Commit) -> CommitInfo {
    let sha = commit.id().to_string();
    CommitInfo {
        short_sha: sha.chars().take(7).collect(),
        sha,
        author: commit.author().name().unwrap_or_default().to_string(),
        date: commit.time().seconds(),
        summary: commit.summary().unwrap_or_default().to_string(),
    }
}

fn entry_oid(tree: &Tree, rel: &Path) -> Option<Oid> {
    tree.get_path(rel).ok().map(|e| e.id())
}

// Mirrors git's default history simplification for a single path: a commit is
// "interesting" when the file differs from its parent (or, for a merge, from
// every parent). Root commits count when they introduce the file.
fn commit_touches(commit: &Commit, rel: &Path) -> Result<bool> {
    let cur = entry_oid(&commit.tree()?, rel);
    if commit.parent_count() == 0 {
        return Ok(cur.is_some());
    }
    for i in 0..commit.parent_count() {
        if entry_oid(&commit.parent(i)?.tree()?, rel) == cur {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Commits that changed `path`, newest first, capped at `HISTORY_LIMIT`. Empty
/// when there is no repo, the file is untracked, or the branch is unborn.
#[tauri::command]
pub fn git_file_history(path: String) -> Result<Vec<CommitInfo>> {
    let file = Path::new(&path);
    let Ok(repo) = Repository::discover(file) else {
        return Ok(vec![]);
    };
    let Some(rel) = repo_relative(&repo, file) else {
        return Ok(vec![]);
    };
    let mut walk = repo.revwalk()?;
    if walk.push_head().is_err() {
        return Ok(vec![]);
    }
    walk.set_sorting(Sort::TIME)?;
    let mut out = Vec::new();
    for oid in walk {
        let commit = repo.find_commit(oid?)?;
        if commit_touches(&commit, &rel)? {
            out.push(commit_info(&commit));
            if out.len() >= HISTORY_LIMIT {
                break;
            }
        }
    }
    Ok(out)
}

/// Content of `path` as it stood in commit `sha`. `None` when the commit or
/// path is missing, or the blob is binary.
#[tauri::command]
pub fn git_file_at(path: String, sha: String) -> Result<Option<String>> {
    let file = Path::new(&path);
    let Ok(repo) = Repository::discover(file) else {
        return Ok(None);
    };
    let Some(rel) = repo_relative(&repo, file) else {
        return Ok(None);
    };
    let Ok(oid) = Oid::from_str(&sha) else {
        return Ok(None);
    };
    let Ok(commit) = repo.find_commit(oid) else {
        return Ok(None);
    };
    let Ok(entry) = commit.tree()?.get_path(&rel) else {
        return Ok(None);
    };
    let blob = repo.find_blob(entry.id())?;
    if !looks_text(blob.content()) {
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(blob.content()).into_owned()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    line: usize,
    sha: String,
    short_sha: String,
    author: String,
    date: i64,
    summary: String,
}

/// Per-line authorship of the committed version of `path`. Lines edited since
/// the last commit have no committed origin and are simply absent from the
/// result; the caller leaves those unannotated. Empty when there is no repo.
#[tauri::command]
pub fn git_blame(path: String) -> Result<Vec<BlameLine>> {
    let file = Path::new(&path);
    let Ok(repo) = Repository::discover(file) else {
        return Ok(vec![]);
    };
    let Some(rel) = repo_relative(&repo, file) else {
        return Ok(vec![]);
    };
    let Ok(blame) = repo.blame_file(&rel, None) else {
        return Ok(vec![]);
    };
    let mut out = Vec::new();
    for hunk in blame.iter() {
        let oid = hunk.final_commit_id();
        let info = repo.find_commit(oid).ok().map(|c| commit_info(&c));
        let sha = oid.to_string();
        let short_sha: String = sha.chars().take(7).collect();
        let author = info
            .as_ref()
            .map(|c| c.author.clone())
            .or_else(|| hunk.final_signature().name().map(str::to_string))
            .unwrap_or_default();
        let date = info.as_ref().map(|c| c.date).unwrap_or_default();
        let summary = info.as_ref().map(|c| c.summary.clone()).unwrap_or_default();
        let start = hunk.final_start_line();
        for i in 0..hunk.lines_in_hunk() {
            out.push(BlameLine {
                line: start + i,
                sha: sha.clone(),
                short_sha: short_sha.clone(),
                author: author.clone(),
                date,
                summary: summary.clone(),
            });
        }
    }
    Ok(out)
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,
    pub kind: &'static str,
    pub staged: bool,
    pub unstaged: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusReport {
    pub files: Vec<GitFileStatus>,
    pub truncated: bool,
}

fn kind_of(s: git2::Status) -> &'static str {
    if s.is_conflicted() {
        return "conflicted";
    }
    if s.is_index_new() || s.is_wt_new() {
        return if s.is_wt_new() && !s.is_index_new() {
            "untracked"
        } else {
            "added"
        };
    }
    if s.is_index_deleted() || s.is_wt_deleted() {
        return "deleted";
    }
    if s.is_index_renamed() || s.is_wt_renamed() {
        return "renamed";
    }
    "modified"
}

// `Repository::discover` only walks upward from its starting point, so a
// workspace root that sits *above* its repositories (the common layout:
// `workspace/app/.git`) never finds one that way. We complement it by
// probing every directory the tree has in view for a `.git` entry of its
// own — a plain dir for a normal clone, a file for a linked worktree.
fn resolve_repo_roots(root: &Path, dirs: &[String]) -> Vec<PathBuf> {
    let mut roots = std::collections::BTreeSet::new();
    if let Ok(repo) = Repository::discover(root)
        && let Some(workdir) = repo.workdir().and_then(|w| w.canonicalize().ok())
    {
        roots.insert(workdir);
    }
    for dir in dirs {
        let path = Path::new(dir);
        if path.join(".git").exists()
            && let Ok(canon) = path.canonicalize()
        {
            roots.insert(canon);
        }
    }
    roots.into_iter().collect()
}

/// Working-tree status for one already-open repo, capped at `max` entries.
/// The bool flags whether this repo alone exceeded the cap, before any
/// cross-repo merge.
fn repo_statuses(repo: &Repository, max: usize) -> Result<(Vec<GitFileStatus>, bool)> {
    let Some(workdir) = repo.workdir().map(Path::to_path_buf) else {
        return Ok((Vec::new(), false));
    };
    let mut opts = git2::StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(false)
        .include_ignored(false)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    let statuses = repo.statuses(Some(&mut opts))?;
    let truncated = statuses.len() > max;
    let files = statuses
        .iter()
        .filter_map(|e| {
            let s = e.status();
            let rel = e.path()?;
            Some(GitFileStatus {
                path: workdir
                    .join(rel)
                    .to_string_lossy()
                    .trim_end_matches('/')
                    .to_string(),
                kind: kind_of(s),
                staged: s.is_index_new()
                    || s.is_index_modified()
                    || s.is_index_deleted()
                    || s.is_index_renamed()
                    || s.is_index_typechange(),
                unstaged: s.is_wt_new()
                    || s.is_wt_modified()
                    || s.is_wt_deleted()
                    || s.is_wt_renamed()
                    || s.is_wt_typechange(),
            })
        })
        .take(max)
        .collect();
    Ok((files, truncated))
}

/// Working-tree status for every changed file across every repository
/// resolved from `root` and `dirs`, capped at `max` entries total. Empty
/// (not an error) when nothing resolves to a repo, so the tree can call this
/// unconditionally without special-casing non-repo roots. A repo whose own
/// status walk fails (a corrupted index, an unreadable linked worktree) is
/// skipped rather than failing the whole call — one unhealthy repo must
/// never blank the marks for every healthy repo still in view.
pub fn statuses_at(root: &Path, dirs: &[String], max: usize) -> Result<GitStatusReport> {
    let roots = resolve_repo_roots(root, dirs);
    let mut per_repo = Vec::new();
    for repo_root in &roots {
        let Ok(repo) = Repository::open(repo_root) else {
            continue;
        };
        let Ok((repo_files, repo_truncated)) = repo_statuses(&repo, max) else {
            continue;
        };
        per_repo.push((repo_root.clone(), repo_files, repo_truncated));
    }
    let mut files = Vec::new();
    let mut truncated = false;
    for (repo_root, repo_files, repo_truncated) in per_repo {
        truncated |= repo_truncated;
        // A repo nested inside another resolved repo's workdir (submodule or
        // stray checkout) gets its own, accurate per-file entries below; the
        // outer repo's single directory-level entry for that same path would
        // otherwise double-count it at every ancestor in folderSummaries.
        for file in repo_files {
            let shadowed = roots.iter().any(|other| {
                other != &repo_root
                    && other.starts_with(&repo_root)
                    && Path::new(&file.path).starts_with(other)
            });
            if !shadowed {
                files.push(file);
            }
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    truncated |= files.len() > max;
    // Sorted alphabetically by absolute path: when several repos each
    // exceed the cap on their own, a later-sorting repo's files can be
    // squeezed out of the merge entirely by an earlier-sorting one's.
    files.truncate(max);
    Ok(GitStatusReport { files, truncated })
}

#[tauri::command]
pub async fn git_statuses(
    manager: State<'_, ConfigManager>,
    root: String,
    dirs: Vec<String>,
) -> Result<GitStatusReport> {
    let max = manager.git().status.status_max_files as usize;
    tauri::async_runtime::spawn_blocking(move || statuses_at(Path::new(&root), &dirs, max))
        .await
        .map_err(|e| Error::Os(e.to_string()))?
}

#[cfg(test)]
mod status_tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn repo() -> (TempDir, git2::Repository) {
        let tmp = TempDir::new().unwrap();
        let repo = git2::Repository::init(tmp.path()).unwrap();
        (tmp, repo)
    }

    fn commit_all(repo: &git2::Repository) {
        let mut idx = repo.index().unwrap();
        idx.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
            .unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let sig = git2::Signature::now("t", "t@t").unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, "c", &tree, &parents)
            .unwrap();
    }

    fn kind_of(report: &GitStatusReport, name: &str) -> Option<(String, bool, bool)> {
        report
            .files
            .iter()
            .find(|f| f.path.ends_with(name))
            .map(|f| (f.kind.to_string(), f.staged, f.unstaged))
    }

    #[test]
    fn reports_untracked_modified_and_staged() {
        let (tmp, repo) = repo();
        fs::write(tmp.path().join("tracked.txt"), "one\n").unwrap();
        commit_all(&repo);
        fs::write(tmp.path().join("tracked.txt"), "two\n").unwrap();
        fs::write(tmp.path().join("fresh.txt"), "new\n").unwrap();
        let report = statuses_at(tmp.path(), &[], 2000).unwrap();
        assert_eq!(
            kind_of(&report, "tracked.txt"),
            Some(("modified".into(), false, true))
        );
        assert_eq!(
            kind_of(&report, "fresh.txt"),
            Some(("untracked".into(), false, true))
        );
        assert!(!report.truncated);
    }

    #[test]
    fn a_staged_new_file_is_added_and_staged() {
        let (tmp, repo) = repo();
        fs::write(tmp.path().join("seed.txt"), "seed\n").unwrap();
        commit_all(&repo);
        fs::write(tmp.path().join("added.txt"), "a\n").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("added.txt")).unwrap();
        idx.write().unwrap();
        assert_eq!(
            kind_of(&statuses_at(tmp.path(), &[], 2000).unwrap(), "added.txt"),
            Some(("added".into(), true, false))
        );
    }

    #[test]
    fn a_file_staged_then_edited_again_is_both() {
        let (tmp, repo) = repo();
        fs::write(tmp.path().join("both.txt"), "one\n").unwrap();
        commit_all(&repo);
        fs::write(tmp.path().join("both.txt"), "two\n").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("both.txt")).unwrap();
        idx.write().unwrap();
        fs::write(tmp.path().join("both.txt"), "three\n").unwrap();
        assert_eq!(
            kind_of(&statuses_at(tmp.path(), &[], 2000).unwrap(), "both.txt"),
            Some(("modified".into(), true, true))
        );
    }

    #[test]
    fn a_deleted_file_is_reported() {
        let (tmp, repo) = repo();
        fs::write(tmp.path().join("gone.txt"), "x\n").unwrap();
        commit_all(&repo);
        fs::remove_file(tmp.path().join("gone.txt")).unwrap();
        assert_eq!(
            kind_of(&statuses_at(tmp.path(), &[], 2000).unwrap(), "gone.txt"),
            Some(("deleted".into(), false, true))
        );
    }

    #[test]
    fn an_untracked_directory_is_one_entry_not_its_contents() {
        let (tmp, repo) = repo();
        fs::write(tmp.path().join("seed.txt"), "seed\n").unwrap();
        commit_all(&repo);
        fs::create_dir(tmp.path().join("newdir")).unwrap();
        for n in ["a.txt", "b.txt", "c.txt"] {
            fs::write(tmp.path().join("newdir").join(n), "x\n").unwrap();
        }
        let report = statuses_at(tmp.path(), &[], 2000).unwrap();
        assert_eq!(
            report
                .files
                .iter()
                .filter(|f| f.path.contains("newdir"))
                .count(),
            1
        );
    }

    #[test]
    fn the_cap_truncates_and_flags() {
        let (tmp, repo) = repo();
        fs::write(tmp.path().join("seed.txt"), "seed\n").unwrap();
        commit_all(&repo);
        for n in 0..5 {
            fs::write(tmp.path().join(format!("f{n}.txt")), "x\n").unwrap();
        }
        let report = statuses_at(tmp.path(), &[], 3).unwrap();
        assert!(report.truncated);
        assert!(report.files.len() <= 3);
    }

    #[test]
    fn outside_a_repo_it_is_empty_not_an_error() {
        let tmp = TempDir::new().unwrap();
        let report = statuses_at(tmp.path(), &[], 2000).unwrap();
        assert!(report.files.is_empty() && !report.truncated);
    }

    fn init_repo_at(dir: &std::path::Path, dirty_file: &str) -> git2::Repository {
        fs::create_dir_all(dir).unwrap();
        let repo = git2::Repository::init(dir).unwrap();
        fs::write(dir.join("seed.txt"), "seed\n").unwrap();
        commit_all(&repo);
        fs::write(dir.join(dirty_file), "x\n").unwrap();
        repo
    }

    fn to_dirs(paths: &[&std::path::Path]) -> Vec<String> {
        paths
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn a_workspace_root_finds_sibling_repos_below_it() {
        let tmp = TempDir::new().unwrap();
        let repo_a = tmp.path().join("repo-a");
        let repo_b = tmp.path().join("repo-b");
        init_repo_at(&repo_a, "a.txt");
        init_repo_at(&repo_b, "b.txt");
        let report =
            statuses_at(tmp.path(), &to_dirs(&[tmp.path(), &repo_a, &repo_b]), 2000).unwrap();
        assert!(kind_of(&report, "a.txt").is_some());
        assert!(kind_of(&report, "b.txt").is_some());
        assert!(!report.truncated);
    }

    #[test]
    fn a_root_that_is_itself_a_repo_behaves_as_before() {
        let (tmp, repo) = repo();
        fs::write(tmp.path().join("tracked.txt"), "one\n").unwrap();
        commit_all(&repo);
        fs::write(tmp.path().join("tracked.txt"), "two\n").unwrap();
        let report = statuses_at(tmp.path(), &to_dirs(&[tmp.path()]), 2000).unwrap();
        assert_eq!(
            kind_of(&report, "tracked.txt"),
            Some(("modified".into(), false, true))
        );
    }

    #[test]
    fn a_repo_nested_deeper_than_the_passed_dirs_is_not_reported() {
        let tmp = TempDir::new().unwrap();
        let level1 = tmp.path().join("level1");
        let level2 = level1.join("level2");
        fs::create_dir_all(&level1).unwrap();
        init_repo_at(&level2, "deep.txt");
        let report = statuses_at(tmp.path(), &to_dirs(&[tmp.path(), &level1]), 2000).unwrap();
        assert!(report.files.is_empty());
    }

    #[test]
    fn the_cap_applies_across_merged_repos() {
        let tmp = TempDir::new().unwrap();
        let repo_a = tmp.path().join("repo-a");
        let repo_b = tmp.path().join("repo-b");
        fs::create_dir_all(&repo_a).unwrap();
        fs::create_dir_all(&repo_b).unwrap();
        let ra = git2::Repository::init(&repo_a).unwrap();
        let rb = git2::Repository::init(&repo_b).unwrap();
        fs::write(repo_a.join("seed.txt"), "seed\n").unwrap();
        commit_all(&ra);
        fs::write(repo_b.join("seed.txt"), "seed\n").unwrap();
        commit_all(&rb);
        for n in 0..3 {
            fs::write(repo_a.join(format!("a{n}.txt")), "x\n").unwrap();
            fs::write(repo_b.join(format!("b{n}.txt")), "x\n").unwrap();
        }
        let report = statuses_at(tmp.path(), &to_dirs(&[tmp.path(), &repo_a, &repo_b]), 4).unwrap();
        assert!(report.truncated);
        assert!(report.files.len() <= 4);
    }

    #[test]
    fn a_repo_with_a_broken_index_is_skipped_not_fatal() {
        let tmp = TempDir::new().unwrap();
        let repo_a = tmp.path().join("repo-a");
        let repo_b = tmp.path().join("repo-b");
        init_repo_at(&repo_a, "a.txt");
        init_repo_at(&repo_b, "b.txt");
        fs::write(repo_a.join(".git").join("index"), b"not an index").unwrap();
        let report =
            statuses_at(tmp.path(), &to_dirs(&[tmp.path(), &repo_a, &repo_b]), 2000).unwrap();
        assert!(kind_of(&report, "b.txt").is_some());
        assert!(kind_of(&report, "a.txt").is_none());
    }

    #[test]
    fn a_repo_nested_inside_another_is_reported_once_by_the_inner_repo() {
        let tmp = TempDir::new().unwrap();
        let outer = tmp.path().join("outer");
        fs::create_dir_all(&outer).unwrap();
        let outer_repo = git2::Repository::init(&outer).unwrap();
        fs::write(outer.join("seed.txt"), "seed\n").unwrap();
        commit_all(&outer_repo);
        let inner = outer.join("vendor");
        init_repo_at(&inner, "dirty.txt");
        let report = statuses_at(&outer, &to_dirs(&[&outer, &inner]), 2000).unwrap();
        assert_eq!(report.files.len(), 1);
        assert!(kind_of(&report, "vendor/dirty.txt").is_some());
        assert!(!report.files.iter().any(|f| f.path.ends_with("vendor")));
    }
}
