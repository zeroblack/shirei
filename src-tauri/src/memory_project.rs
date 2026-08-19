use crate::config::{ConfigManager, MemoryCliAdapter, MemoryConfig};
use crate::error::Result;
use crate::memory::{expand_home, home_dir};
use crate::memory_adapters::{inspect, preview_diff, write_with_backup};
use serde::Serialize;
use shirei_memory_core::resolve_root_for_write;
use std::path::{Path, PathBuf};
use tauri::State;

pub const BEGIN: &str = "<!-- shirei:memory:begin -->";
pub const END: &str = "<!-- shirei:memory:end -->";

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ProjectDoc {
    pub doc_path: String,
    pub adapters: Vec<String>,
    pub state: &'static str,
    pub before: String,
    pub after: String,
    pub diff: String,
}

pub fn wrap(block: &str) -> String {
    format!("{BEGIN}\n{}\n{END}\n", block.trim_end())
}

fn bounds(text: &str) -> Option<(usize, usize)> {
    let start = text.find(BEGIN)?;
    let end = text[start..].find(END)? + start + END.len();
    Some((start, end))
}

pub fn upsert(text: &str, block: &str) -> String {
    let wrapped = wrap(block);
    let Some((start, end)) = bounds(text) else {
        let head = text.trim_end();
        if head.is_empty() {
            return wrapped;
        }
        return format!("{head}\n\n{wrapped}");
    };
    let tail = text[end..].trim_start_matches('\n');
    let joined = format!("{}{wrapped}{tail}", &text[..start]);
    if tail.is_empty() {
        joined
    } else {
        format!("{}{wrapped}\n{tail}", &text[..start])
    }
}

pub fn strip(text: &str) -> String {
    let Some((start, end)) = bounds(text) else {
        return text.to_string();
    };
    let head = text[..start].trim_end();
    let tail = text[end..].trim_start_matches('\n');
    match (head.is_empty(), tail.is_empty()) {
        (true, true) => String::new(),
        (true, false) => tail.to_string(),
        (false, true) => format!("{head}\n"),
        (false, false) => format!("{head}\n\n{tail}"),
    }
}

pub fn state_of(text: &str, block: &str) -> &'static str {
    match bounds(text) {
        None => "missing",
        Some((start, end)) if &text[start..end] == wrap(block).trim_end() => "current",
        Some(_) => "outdated",
    }
}

fn read_or_empty(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

fn is_registered(a: &MemoryCliAdapter, shim: &str, home: &Path) -> bool {
    let cfg_path = expand_home(&a.config_path, home);
    inspect(&read_or_empty(&cfg_path), a, shim) == "registered"
}

fn shim_string(cfg: &MemoryConfig, home: &Path) -> String {
    expand_home(&cfg.shim_path, home)
        .to_string_lossy()
        .into_owned()
}

// Several CLIs read the same AGENTS.md, so the same file is grouped once with every
// adapter that depends on it instead of being rewritten per adapter.
fn group_by_doc(
    cfg: &MemoryConfig,
    root: &Path,
    home: &Path,
    detected: &dyn Fn(&MemoryCliAdapter) -> bool,
) -> Vec<(PathBuf, Vec<String>)> {
    let shim = shim_string(cfg, home);
    let mut groups: Vec<(PathBuf, Vec<String>)> = Vec::new();
    for a in cfg.cli_adapters.iter() {
        if a.project_doc.is_empty() || !detected(a) || !is_registered(a, &shim, home) {
            continue;
        }
        let path = root.join(&a.project_doc);
        match groups.iter_mut().find(|(p, _)| *p == path) {
            Some((_, ids)) => ids.push(a.id.clone()),
            None => groups.push((path, vec![a.id.clone()])),
        }
    }
    groups
}

fn plan_with(
    cfg: &MemoryConfig,
    project: &str,
    block: &str,
    home: &Path,
    detected: &dyn Fn(&MemoryCliAdapter) -> bool,
) -> Vec<ProjectDoc> {
    let root = resolve_root_for_write(Path::new(project), &cfg.dir_name, home);
    group_by_doc(cfg, &root, home, detected)
        .into_iter()
        .map(|(path, adapters)| {
            let before = read_or_empty(&path);
            let after = upsert(&before, block);
            ProjectDoc {
                doc_path: path.to_string_lossy().into_owned(),
                adapters,
                state: state_of(&before, block),
                diff: preview_diff(&before, &after),
                before,
                after,
            }
        })
        .collect()
}

fn plan(cfg: &MemoryConfig, project: &str, block: &str, home: &Path) -> Vec<ProjectDoc> {
    plan_with(cfg, project, block, home, &|a: &MemoryCliAdapter| {
        crate::dialog::binary_on_path(a.binary.clone())
    })
}

#[tauri::command]
pub async fn memory_project_preview(
    manager: State<'_, ConfigManager>,
    path: String,
    block: String,
) -> Result<Vec<ProjectDoc>> {
    let cfg = manager.memory();
    tauri::async_runtime::spawn_blocking(move || plan(&cfg, &path, &block, &home_dir()))
        .await
        .map_err(|e| crate::error::Error::Os(e.to_string()))
}

#[tauri::command]
pub async fn memory_project_activate(
    manager: State<'_, ConfigManager>,
    path: String,
    block: String,
) -> Result<Vec<String>> {
    let cfg = manager.memory();
    let planned =
        tauri::async_runtime::spawn_blocking(move || plan(&cfg, &path, &block, &home_dir()))
            .await
            .map_err(|e| crate::error::Error::Os(e.to_string()))?;
    let mut written = Vec::new();
    for doc in planned {
        if doc.state == "current" {
            continue;
        }
        write_with_backup(Path::new(&doc.doc_path), &doc.after)?;
        written.push(doc.doc_path);
    }
    Ok(written)
}

#[tauri::command]
pub async fn memory_project_deactivate(
    manager: State<'_, ConfigManager>,
    path: String,
) -> Result<Vec<String>> {
    let cfg = manager.memory();
    let planned = tauri::async_runtime::spawn_blocking(move || plan(&cfg, &path, "", &home_dir()))
        .await
        .map_err(|e| crate::error::Error::Os(e.to_string()))?;
    let mut cleared = Vec::new();
    for doc in planned {
        if doc.state == "missing" {
            continue;
        }
        let stripped = strip(&doc.before);
        write_with_backup(Path::new(&doc.doc_path), &stripped)?;
        cleared.push(doc.doc_path);
    }
    Ok(cleared)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::default_cli_adapters;

    const BLOCK: &str = "Memoria del proyecto: llama memory_overview al arrancar.";

    #[test]
    fn upsert_creates_the_block_in_an_empty_file() {
        assert_eq!(upsert("", BLOCK), wrap(BLOCK));
    }

    #[test]
    fn upsert_appends_after_existing_content_with_one_blank_line() {
        let out = upsert("# Proyecto\n\nReglas.\n", BLOCK);
        assert_eq!(out, format!("# Proyecto\n\nReglas.\n\n{}", wrap(BLOCK)));
    }

    #[test]
    fn upsert_replaces_an_outdated_block_and_keeps_surrounding_text() {
        let original = upsert("# Proyecto\n", "texto viejo");
        let updated = upsert(&format!("{original}\nCola.\n"), BLOCK);
        assert!(updated.starts_with("# Proyecto\n"));
        assert!(updated.contains(BLOCK));
        assert!(!updated.contains("texto viejo"));
        assert!(updated.ends_with("Cola.\n"));
        assert_eq!(updated.matches(BEGIN).count(), 1);
    }

    #[test]
    fn upsert_is_idempotent() {
        let once = upsert("# Proyecto\n", BLOCK);
        assert_eq!(upsert(&once, BLOCK), once);
    }

    #[test]
    fn strip_removes_the_block_and_leaves_the_rest_intact() {
        let text = upsert("# Proyecto\n\nReglas.\n", BLOCK);
        assert_eq!(strip(&text), "# Proyecto\n\nReglas.\n");
    }

    #[test]
    fn strip_empties_a_file_that_only_held_the_block() {
        assert_eq!(strip(&wrap(BLOCK)), "");
    }

    #[test]
    fn strip_is_a_noop_without_markers() {
        assert_eq!(strip("# Proyecto\n"), "# Proyecto\n");
    }

    #[test]
    fn state_tracks_missing_current_and_outdated() {
        assert_eq!(state_of("# Proyecto\n", BLOCK), "missing");
        assert_eq!(state_of(&upsert("", BLOCK), BLOCK), "current");
        assert_eq!(state_of(&upsert("", "otro"), BLOCK), "outdated");
    }

    #[test]
    fn every_shipped_adapter_declares_an_instructions_file() {
        for a in default_cli_adapters() {
            assert!(!a.project_doc.is_empty(), "{} has no project_doc", a.id);
        }
    }

    // Builds a HOME where the given adapters are genuinely registered, by writing each
    // one's config through the same `apply` the register button uses.
    fn home_with_registered(ids: &[&str]) -> (tempfile::TempDir, MemoryConfig) {
        let home = tempfile::TempDir::new().unwrap();
        let cfg = MemoryConfig {
            shim_path: home
                .path()
                .join("bin/shirei-memory")
                .to_string_lossy()
                .into_owned(),
            ..MemoryConfig::default()
        };
        for a in cfg
            .cli_adapters
            .iter()
            .filter(|a| ids.contains(&a.id.as_str()))
        {
            let path = expand_home(&a.config_path, home.path());
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            let text = crate::memory_adapters::apply("", a, &cfg.shim_path).unwrap();
            std::fs::write(&path, text).unwrap();
        }
        (home, cfg)
    }

    #[test]
    fn unregistered_adapters_never_produce_a_write() {
        let (home, cfg) = home_with_registered(&[]);
        let groups = group_by_doc(&cfg, Path::new("/p"), home.path(), &|_| true);
        assert!(groups.is_empty());
    }

    #[test]
    fn an_undetected_cli_is_skipped_even_when_registered() {
        let (home, cfg) = home_with_registered(&["codex"]);
        let groups = group_by_doc(&cfg, Path::new("/p"), home.path(), &|_| false);
        assert!(groups.is_empty());
    }

    #[test]
    fn adapters_sharing_an_instructions_file_are_grouped_once() {
        let (home, cfg) = home_with_registered(&["codex", "opencode", "claude"]);
        let groups = group_by_doc(&cfg, Path::new("/p"), home.path(), &|_| true);
        let agents = groups
            .iter()
            .find(|(p, _)| p.ends_with("AGENTS.md"))
            .expect("AGENTS.md group");
        assert_eq!(agents.1, ["codex", "opencode"]);
        assert!(groups.iter().any(|(p, _)| p.ends_with("CLAUDE.md")));
        assert_eq!(groups.len(), 2, "one entry per file, not per adapter");
    }

    #[test]
    fn activating_writes_the_block_once_per_file_and_reports_current_after() {
        let (home, cfg) = home_with_registered(&["codex", "opencode"]);
        let project = tempfile::TempDir::new().unwrap();
        let path = project.path().to_string_lossy().into_owned();
        let detected = |_: &MemoryCliAdapter| true;

        let planned = plan_with(&cfg, &path, BLOCK, home.path(), &detected);
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].state, "missing");
        write_with_backup(Path::new(&planned[0].doc_path), &planned[0].after).unwrap();

        let written = std::fs::read_to_string(&planned[0].doc_path).unwrap();
        assert!(written.contains(BLOCK));
        assert_eq!(written.matches(BEGIN).count(), 1);

        let again = plan_with(&cfg, &path, BLOCK, home.path(), &detected);
        assert_eq!(again[0].state, "current");
    }

    #[test]
    fn activating_preserves_an_existing_instructions_file() {
        let (home, cfg) = home_with_registered(&["codex"]);
        let project = tempfile::TempDir::new().unwrap();
        let doc = project.path().join("AGENTS.md");
        std::fs::write(&doc, "# Reglas\n\nNo tocar la BD.\n").unwrap();
        let path = project.path().to_string_lossy().into_owned();

        let planned = plan_with(&cfg, &path, BLOCK, home.path(), &|_| true);
        write_with_backup(&doc, &planned[0].after).unwrap();

        let written = std::fs::read_to_string(&doc).unwrap();
        assert!(written.starts_with("# Reglas\n\nNo tocar la BD.\n"));
        assert!(written.contains(BLOCK));
        assert_eq!(strip(&written), "# Reglas\n\nNo tocar la BD.\n");
    }
}
