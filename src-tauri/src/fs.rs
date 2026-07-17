use std::path::Path;

use serde::Serialize;
use tauri::State;

use crate::config::ConfigManager;
use crate::error::{Error, Result};

pub fn expand_tilde(path: &str) -> std::path::PathBuf {
    if let Some(rest) = path.strip_prefix("~/")
        && let Ok(home) = std::env::var("HOME")
    {
        return std::path::Path::new(&home).join(rest);
    }
    if path == "~"
        && let Ok(home) = std::env::var("HOME")
    {
        return std::path::PathBuf::from(home);
    }
    std::path::PathBuf::from(path)
}

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Serialize)]
pub struct DirListing {
    pub entries: Vec<DirEntry>,
    pub truncated: bool,
}

#[derive(Serialize)]
pub struct FileContent {
    pub content: String,
    pub mtime: u64,
}

#[derive(Serialize, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct IndexEntry {
    pub rel: String,
    pub name: String,
    pub is_dir: bool,
}

fn looks_binary(bytes: &[u8]) -> bool {
    let sample = &bytes[..bytes.len().min(8192)];
    sample.contains(&0) || std::str::from_utf8(sample).is_err()
}

fn is_too_large(len: u64, max: u64) -> bool {
    len > max
}

// ~/Library holds other apps' Containers, Group Containers, and Application
// Support; descending into it trips the macOS "access data from other apps" TCC
// prompt once per app. It is never source the user searches for, so the file
// tree and index skip it unconditionally — this is a system invariant, not a
// user-tunable exclude (which persisted configs could be missing).
pub(crate) fn home_library() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join("Library"))
}

fn mtime_secs(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn sort_entries(entries: &mut [DirEntry]) {
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

fn list_dir(path: &str, cap: usize, exclude: &[String]) -> Result<DirListing> {
    let mut entries = Vec::new();
    let mut truncated = false;
    let home_lib = home_library();
    let read = std::fs::read_dir(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => Error::NotFound(path.to_string()),
        _ => Error::Io(e),
    })?;
    for item in read.flatten() {
        let Ok(meta) = item.metadata() else { continue };
        let is_dir = meta.is_dir();
        let name = item.file_name().to_string_lossy().into_owned();
        if is_dir && exclude.contains(&name) {
            continue;
        }
        if is_dir && home_lib.as_deref() == Some(item.path().as_path()) {
            continue;
        }
        if entries.len() >= cap {
            truncated = true;
            break;
        }
        let full = item.path().to_string_lossy().into_owned();
        entries.push(DirEntry {
            name,
            path: full,
            is_dir,
        });
    }
    sort_entries(&mut entries);
    Ok(DirListing { entries, truncated })
}

#[tauri::command]
pub fn fs_read_dir(path: String, config: State<'_, ConfigManager>) -> Result<DirListing> {
    list_dir(
        &path,
        config.limits().dir_entries_cap,
        &config.files().exclude_dirs,
    )
}

#[tauri::command]
pub fn fs_read_file(path: String, config: State<'_, ConfigManager>) -> Result<FileContent> {
    let meta = std::fs::metadata(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => Error::NotFound(path.clone()),
        _ => Error::Io(e),
    })?;
    if is_too_large(meta.len(), config.limits().max_file_bytes) {
        return Err(Error::Unreadable(path));
    }
    let bytes = std::fs::read(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => Error::NotFound(path.clone()),
        _ => Error::Io(e),
    })?;
    if looks_binary(&bytes) {
        return Err(Error::Unreadable(path));
    }
    let content = String::from_utf8(bytes).map_err(|_| Error::Unreadable(path))?;
    Ok(FileContent {
        content,
        mtime: mtime_secs(&meta),
    })
}

/// Validates an image without reading it into memory. The frontend renders the
/// file through the `asset://` protocol (convertFileSrc), so the bytes never
/// cross the IPC boundary or land base64-encoded on the JS heap; this only
/// enforces the size cap and existence.
#[tauri::command]
pub fn fs_image_meta(path: String, config: State<'_, ConfigManager>) -> Result<u64> {
    let meta = std::fs::metadata(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => Error::NotFound(path.clone()),
        _ => Error::Io(e),
    })?;
    if meta.len() > config.limits().max_image_bytes {
        return Err(Error::Unreadable(path));
    }
    Ok(meta.len())
}

/// Writes via a same-directory temp file plus rename so a crash mid-write can
/// never leave the file truncated. Symlinks are resolved first (a rename onto
/// the link would silently replace it with a regular file) and the original
/// permissions are carried over to the replacement.
pub(crate) fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<u64> {
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let mut tmp = target.clone().into_os_string();
    tmp.push(".shirei.tmp");
    let tmp = std::path::PathBuf::from(tmp);
    std::fs::write(&tmp, data)?;
    if let Ok(meta) = std::fs::metadata(&target) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    std::fs::rename(&tmp, &target)?;
    Ok(mtime_secs(&std::fs::metadata(&target)?))
}

#[tauri::command]
pub fn fs_write_file(
    path: String,
    data: String,
    known_mtime: Option<u64>,
    config: State<'_, ConfigManager>,
) -> Result<u64> {
    if data.len() as u64 > config.limits().max_file_bytes {
        return Err(Error::TooLarge(path));
    }
    if let (Some(known), Ok(meta)) = (known_mtime, std::fs::metadata(&path))
        && mtime_secs(&meta) != known
    {
        return Err(Error::WriteConflict(path));
    }
    write_atomic(Path::new(&path), data.as_bytes()).map_err(Error::Io)
}

/// Creates an empty file, failing if one already exists at `path` so a new file
/// never clobbers existing content.
#[tauri::command]
pub fn fs_create_file(path: String) -> Result<()> {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map(|_| ())
        .map_err(Error::Io)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_file_is_not_binary() {
        assert!(!looks_binary(b""));
    }

    #[test]
    fn text_is_not_binary() {
        assert!(!looks_binary(b"hola mundo\n"));
    }

    #[test]
    fn null_byte_is_binary() {
        assert!(looks_binary(b"foo\0bar"));
    }

    #[test]
    fn size_limit() {
        const MAX: u64 = 5 * 1024 * 1024;
        assert!(!is_too_large(MAX, MAX));
        assert!(is_too_large(MAX + 1, MAX));
    }

    #[test]
    fn list_dir_caps_and_excludes() {
        let tmp = std::env::temp_dir().join(format!("shirei_listdir_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::create_dir(tmp.join("node_modules")).unwrap();
        std::fs::create_dir(tmp.join("keep")).unwrap();
        for i in 0..5 {
            std::fs::write(tmp.join(format!("f{i}.txt")), b"x").unwrap();
        }
        let p = tmp.to_string_lossy().into_owned();

        let listing = list_dir(&p, 100, &["node_modules".to_string()]).unwrap();
        assert!(!listing.truncated);
        assert_eq!(listing.entries.len(), 6);
        assert!(listing.entries.iter().all(|e| e.name != "node_modules"));

        let capped = list_dir(&p, 3, &[]).unwrap();
        assert!(capped.truncated);
        assert_eq!(capped.entries.len(), 3);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn write_atomic_replaces_content_and_reports_mtime() {
        let tmp = std::env::temp_dir().join(format!("shirei_atomic_{}", std::process::id()));
        std::fs::write(&tmp, b"old").unwrap();
        let mtime = write_atomic(&tmp, b"new content").unwrap();
        assert_eq!(std::fs::read(&tmp).unwrap(), b"new content");
        assert!(mtime > 0);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn write_atomic_preserves_symlinks() {
        let dir = std::env::temp_dir().join(format!("shirei_symlink_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("real.txt");
        let link = dir.join("link.txt");
        std::fs::write(&target, b"old").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        write_atomic(&link, b"through the link").unwrap();

        assert!(std::fs::symlink_metadata(&link).unwrap().is_symlink());
        assert_eq!(std::fs::read(&target).unwrap(), b"through the link");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dirs_first_then_alpha_ci() {
        let mut v = vec![
            DirEntry {
                name: "Zebra".into(),
                path: "Zebra".into(),
                is_dir: false,
            },
            DirEntry {
                name: "src".into(),
                path: "src".into(),
                is_dir: true,
            },
            DirEntry {
                name: "apple".into(),
                path: "apple".into(),
                is_dir: false,
            },
            DirEntry {
                name: "Build".into(),
                path: "Build".into(),
                is_dir: true,
            },
        ];
        sort_entries(&mut v);
        let order: Vec<_> = v.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(order, ["Build", "src", "apple", "Zebra"]);
    }
}
