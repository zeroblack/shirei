use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::error::{Error, Result};

pub fn is_git_repo(path: &str) -> bool {
    std::path::Path::new(path).join(".git").exists()
}

#[tauri::command]
pub fn path_is_git_repo(path: String) -> bool {
    is_git_repo(&path)
}

/// Whether `name` resolves to an executable the way a pane would see it. Runs
/// `command -v` through an interactive login shell (`$SHELL -ilc`) so it inherits
/// the user's real `PATH` from their rc files — a GUI launch otherwise gets a
/// stripped launchd `PATH` that misses Homebrew, `~/go/bin`, etc. `stdin` is
/// redirected from `/dev/null`: an interactive shell with an inherited,
/// non-tty stdin can otherwise stall or bail out before resolving the command.
#[tauri::command]
pub fn binary_on_path(name: String) -> bool {
    if name.is_empty()
        || name.starts_with('-')
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return false;
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    std::process::Command::new(shell)
        .args(["-ilc", &format!("command -v {name}")])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[tauri::command]
pub async fn pick_project_dir(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .set_title("Choose project folder")
        .blocking_pick_folder()
        .and_then(|fp| fp.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn open_config_file(app: AppHandle) -> Result<()> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| Error::Config(e.to_string()))?;
    let path = dir.join("config.json");
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| Error::Os(e.to_string()))
}

#[tauri::command]
pub fn reveal_in_finder(app: AppHandle, path: String) -> Result<()> {
    let opener = app.opener();
    let resolved = crate::fs::expand_tilde(&path)
        .to_string_lossy()
        .into_owned();
    if std::path::Path::new(&resolved).is_dir() {
        opener.open_path(resolved, None::<&str>)
    } else {
        opener.reveal_item_in_dir(resolved)
    }
    .map_err(|e| Error::Os(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::is_git_repo;

    #[test]
    fn detects_git_repo() {
        let cwd = std::env::current_dir().unwrap();
        let repo_root = cwd.parent().unwrap();
        assert!(is_git_repo(repo_root.to_str().unwrap()));
        assert!(!is_git_repo("/tmp"));
    }
}
