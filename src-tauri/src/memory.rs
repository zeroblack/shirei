use crate::config::{ConfigManager, MemoryConfig};
use crate::error::{Error, Result};
use shirei_memory_core::store::Store;
use shirei_memory_core::{Status, Thresholds, find_root, resolve_root_for_write, status};
use std::path::{Path, PathBuf};
use tauri::State;

pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

pub fn expand_home(path: &str, home: &Path) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(path),
    }
}

fn thresholds(cfg: &MemoryConfig) -> Thresholds {
    Thresholds {
        stale_after_days: cfg.stale_after_days,
        stale_after_commits: cfg.stale_after_commits,
        resume_stale_hours: cfg.resume_stale_hours,
    }
}

fn absent() -> Status {
    Status {
        exists: false,
        overview_updated: None,
        stale: false,
        stale_reason: None,
        sessions_count: 0,
        resume_age_hours: None,
    }
}

#[tauri::command]
pub fn memory_status(manager: State<'_, ConfigManager>, path: String) -> Result<Status> {
    let cfg = manager.memory();
    let Some(root) = find_root(Path::new(&path), &cfg.dir_name, &home_dir()) else {
        return Ok(absent());
    };
    let store = Store::new(&root, &cfg.dir_name);
    Ok(status(
        &store,
        &root,
        &thresholds(&cfg),
        time::OffsetDateTime::now_utc(),
    ))
}

#[tauri::command]
pub fn memory_init(manager: State<'_, ConfigManager>, path: String) -> Result<String> {
    let cfg = manager.memory();
    let root = resolve_root_for_write(Path::new(&path), &cfg.dir_name, &home_dir());
    let store = Store::new(&root, &cfg.dir_name);
    store
        .init("human")
        .map_err(|e| Error::Memory(e.to_string()))?;
    Ok(store
        .dir()
        .join("overview.md")
        .to_string_lossy()
        .into_owned())
}

pub fn sidecar_path() -> Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let dir = exe
        .parent()
        .ok_or_else(|| Error::Memory("no executable directory".into()))?;
    let candidate = dir.join("shirei-memory");
    if candidate.is_file() {
        return Ok(candidate);
    }
    Err(Error::Memory(format!(
        "sidecar not found next to {}",
        exe.display()
    )))
}

pub fn shim_script(target: &Path) -> String {
    format!("#!/bin/sh\nexec \"{}\" \"$@\"\n", target.display())
}

pub fn install_shim(shim: &Path, target: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    if let Some(parent) = shim.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let desired = shim_script(target);
    if std::fs::read_to_string(shim)
        .map(|cur| cur == desired)
        .unwrap_or(false)
    {
        return Ok(());
    }
    let tmp = shim.with_extension("tmp");
    std::fs::write(&tmp, desired)?;
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
    std::fs::rename(&tmp, shim)?;
    Ok(())
}

#[tauri::command]
pub fn memory_shim_install(manager: State<'_, ConfigManager>) -> Result<String> {
    let cfg = manager.memory();
    let shim = expand_home(&cfg.shim_path, &home_dir());
    install_shim(&shim, &sidecar_path()?)?;
    Ok(shim.to_string_lossy().into_owned())
}

pub fn refresh_shim_if_present(manager: &ConfigManager) {
    let cfg = manager.memory();
    let shim = expand_home(&cfg.shim_path, &home_dir());
    if !shim.exists() {
        return;
    }
    if let Ok(target) = sidecar_path()
        && let Err(e) = install_shim(&shim, &target)
    {
        log::warn!("memory shim refresh failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn expand_home_only_touches_tilde_prefix() {
        let home = Path::new("/Users/me");
        assert_eq!(
            expand_home("~/.shirei/bin/x", home),
            PathBuf::from("/Users/me/.shirei/bin/x")
        );
        assert_eq!(expand_home("/abs/x", home), PathBuf::from("/abs/x"));
    }

    #[test]
    fn shim_is_written_once_and_rewritten_on_target_change() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().unwrap();
        let shim = tmp.path().join("bin/shirei-memory");
        install_shim(&shim, Path::new("/App/A/shirei-memory")).unwrap();
        assert!(
            std::fs::read_to_string(&shim)
                .unwrap()
                .contains("/App/A/shirei-memory")
        );
        install_shim(&shim, Path::new("/App/B/shirei-memory")).unwrap();
        assert!(std::fs::read_to_string(&shim).unwrap().contains("/App/B/"));
        assert_eq!(
            std::fs::metadata(&shim).unwrap().permissions().mode() & 0o111,
            0o111
        );
    }
}
