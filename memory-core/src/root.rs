use std::path::{Path, PathBuf};

pub const DEFAULT_DIR_NAME: &str = ".shirei/memory";

pub fn memory_dir(root: &Path, dir_name: &str) -> PathBuf {
    root.join(dir_name)
}

pub fn find_root(start: &Path, dir_name: &str, home: &Path) -> Option<PathBuf> {
    let mut cur = Some(start);
    while let Some(dir) = cur {
        if dir == home {
            return None;
        }
        if dir.join(dir_name).is_dir() {
            return Some(dir.to_path_buf());
        }
        cur = dir.parent();
    }
    None
}

pub fn resolve_root_for_write(start: &Path, dir_name: &str, home: &Path) -> PathBuf {
    if let Some(found) = find_root(start, dir_name, home) {
        return found;
    }

    git2::Repository::discover(start)
        .ok()
        .and_then(|repo| {
            repo.workdir().map(|wd| {
                let mut result = wd.to_path_buf();

                let result_str = result.to_string_lossy();
                if result_str.ends_with('/') {
                    result = PathBuf::from(result_str.trim_end_matches('/'));
                }

                #[cfg(target_os = "macos")]
                {
                    let result_str = result.to_string_lossy();
                    if result_str.starts_with("/private/") {
                        let without_private = PathBuf::from(&result_str[8..]);
                        if without_private.exists() {
                            return without_private;
                        }
                    }
                }

                result
            })
        })
        .unwrap_or_else(|| start.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn tree() -> (TempDir, PathBuf, PathBuf) {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path().join("home");
        let project = home.join("code").join("proj");
        fs::create_dir_all(project.join("src/deep")).unwrap();
        (tmp, home, project)
    }

    #[test]
    fn finds_nearest_ancestor_with_memory_dir() {
        let (_t, home, project) = tree();
        fs::create_dir_all(project.join(DEFAULT_DIR_NAME)).unwrap();
        let found = find_root(&project.join("src/deep"), DEFAULT_DIR_NAME, &home);
        assert_eq!(found.as_deref(), Some(project.as_path()));
    }

    #[test]
    fn stops_at_home_exclusive() {
        let (_t, home, project) = tree();
        fs::create_dir_all(home.join(DEFAULT_DIR_NAME)).unwrap();
        assert_eq!(find_root(&project, DEFAULT_DIR_NAME, &home), None);
    }

    #[test]
    fn worktree_with_own_memory_wins_over_parent() {
        let (_t, home, project) = tree();
        let wt = project.join(".worktrees/feat");
        fs::create_dir_all(wt.join(DEFAULT_DIR_NAME)).unwrap();
        fs::create_dir_all(project.join(DEFAULT_DIR_NAME)).unwrap();
        assert_eq!(
            find_root(&wt, DEFAULT_DIR_NAME, &home).as_deref(),
            Some(wt.as_path())
        );
    }

    #[test]
    fn write_root_falls_back_to_git_toplevel_then_cwd() {
        let (_t, home, project) = tree();
        git2::Repository::init(&project).unwrap();
        let deep = project.join("src/deep");
        assert_eq!(
            resolve_root_for_write(&deep, DEFAULT_DIR_NAME, &home),
            project
        );
        let loose = home.join("loose");
        fs::create_dir_all(&loose).unwrap();
        assert_eq!(
            resolve_root_for_write(&loose, DEFAULT_DIR_NAME, &home),
            loose
        );
    }
}
