use std::path::Path;
use time::OffsetDateTime;

pub fn current_branch(root: &Path) -> Option<String> {
    let repo = git2::Repository::discover(root).ok()?;
    let head = repo.head().ok()?;
    head.shorthand().map(str::to_string)
}

pub fn head_commit_time(root: &Path) -> Option<OffsetDateTime> {
    let repo = git2::Repository::discover(root).ok()?;
    let commit = repo.head().ok()?.peel_to_commit().ok()?;
    OffsetDateTime::from_unix_timestamp(commit.time().seconds()).ok()
}

pub fn commits_since(root: &Path, since: OffsetDateTime) -> Option<usize> {
    let repo = git2::Repository::discover(root).ok()?;
    let mut walk = repo.revwalk().ok()?;
    walk.push_head().ok()?;
    let cutoff = since.unix_timestamp();
    let mut n = 0;
    for oid in walk.flatten() {
        let Ok(c) = repo.find_commit(oid) else {
            continue;
        };
        if c.time().seconds() <= cutoff {
            break;
        }
        n += 1;
    }
    Some(n)
}
