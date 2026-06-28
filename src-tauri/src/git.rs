use std::path::{Path, PathBuf};

use git2::Repository;

use crate::error::Result;

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
