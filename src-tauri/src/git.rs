use std::path::{Path, PathBuf};

use git2::{Commit, Oid, Repository, Sort, Tree};
use serde::Serialize;

use crate::error::Result;

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
