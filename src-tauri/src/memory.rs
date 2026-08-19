use crate::config::{ConfigManager, MemoryConfig};
use crate::error::{Error, Result};
use shirei_memory_core::store::{Skeleton, Store};
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
        overview_filled: false,
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

#[derive(serde::Deserialize)]
pub struct MemorySkeleton {
    pub overview: String,
    pub decisions: String,
}

fn resolve_skeleton(skeleton: Option<MemorySkeleton>) -> Skeleton {
    let builtin = Skeleton::builtin();
    match skeleton {
        None => builtin,
        Some(s) => Skeleton {
            overview: if s.overview.trim().is_empty() {
                builtin.overview
            } else {
                s.overview
            },
            decisions: if s.decisions.trim().is_empty() {
                builtin.decisions
            } else {
                s.decisions
            },
        },
    }
}

#[tauri::command]
pub fn memory_init(
    manager: State<'_, ConfigManager>,
    path: String,
    skeleton: Option<MemorySkeleton>,
) -> Result<String> {
    let cfg = manager.memory();
    let root = resolve_root_for_write(Path::new(&path), &cfg.dir_name, &home_dir());
    let store = Store::new(&root, &cfg.dir_name);
    store
        .init("human", &resolve_skeleton(skeleton))
        .map_err(|e| Error::Memory(e.to_string()))?;
    Ok(store
        .dir()
        .join("overview.md")
        .to_string_lossy()
        .into_owned())
}

#[derive(serde::Serialize)]
struct MemoryDefaultsFile {
    overview_skeleton: String,
    decisions_header: String,
}

fn memory_defaults_path() -> PathBuf {
    home_dir().join(".shirei/memory-defaults.json")
}

fn write_defaults_file(path: &Path, overview: String, decisions: String) -> Result<String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let payload = MemoryDefaultsFile {
        overview_skeleton: overview,
        decisions_header: decisions,
    };
    let text = serde_json::to_string_pretty(&payload).map_err(|e| Error::Memory(e.to_string()))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn memory_write_defaults(overview: String, decisions: String) -> Result<String> {
    write_defaults_file(&memory_defaults_path(), overview, decisions)
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
    let escaped = target
        .display()
        .to_string()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    format!("#!/bin/sh\nexec \"{escaped}\" \"$@\"\n")
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

    #[test]
    fn shim_script_escapes_quotes_and_backslashes_in_target() {
        let script = shim_script(Path::new("/Users/me/\"weird\"\\App/shirei-memory"));
        assert_eq!(
            script,
            "#!/bin/sh\nexec \"/Users/me/\\\"weird\\\"\\\\App/shirei-memory\" \"$@\"\n"
        );
    }
    #[test]
    fn resolve_skeleton_falls_back_to_builtin_when_none() {
        let s = resolve_skeleton(None);
        assert_eq!(s, Skeleton::builtin());
    }

    #[test]
    fn resolve_skeleton_falls_back_per_field_when_blank() {
        let s = resolve_skeleton(Some(MemorySkeleton {
            overview: "  ".into(),
            decisions: "# Custom decisions\n".into(),
        }));
        assert_eq!(s.overview, Skeleton::builtin().overview);
        assert_eq!(s.decisions, "# Custom decisions\n");
    }

    #[test]
    fn resolve_skeleton_keeps_non_empty_overrides() {
        let s = resolve_skeleton(Some(MemorySkeleton {
            overview: "# Custom overview\n".into(),
            decisions: "# Custom decisions\n".into(),
        }));
        assert_eq!(s.overview, "# Custom overview\n");
        assert_eq!(s.decisions, "# Custom decisions\n");
    }
    #[test]
    fn write_defaults_file_creates_parent_and_writes_json() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("nested/memory-defaults.json");
        let written = write_defaults_file(
            &path,
            "# Custom overview\n".into(),
            "# Custom decisions\n".into(),
        )
        .unwrap();
        assert_eq!(written, path.to_string_lossy());
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("# Custom overview"));
        assert!(text.contains("# Custom decisions"));
    }

    #[test]
    fn write_defaults_file_accepts_empty_strings() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("memory-defaults.json");
        write_defaults_file(&path, String::new(), String::new()).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"overview_skeleton\": \"\""));
        assert!(text.contains("\"decisions_header\": \"\""));
    }
}
