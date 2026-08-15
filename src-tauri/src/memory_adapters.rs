use crate::config::{ConfigManager, MemoryCliAdapter, MemoryConfig};
use crate::error::{Error, Result};
use crate::memory::{expand_home, home_dir, install_shim, sidecar_path};
use serde::Serialize;
use std::path::Path;
use tauri::State;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct RegistrationState {
    pub id: String,
    pub detected: bool,
    pub state: &'static str,
    pub config_path: String,
}

#[derive(Serialize)]
pub struct Preview {
    pub config_path: String,
    pub before: String,
    pub after: String,
    pub diff: String,
}

fn shim_value(v: &serde_json::Value, shim: &str) -> serde_json::Value {
    match v {
        serde_json::Value::String(s) => serde_json::Value::String(s.replace("{shim}", shim)),
        serde_json::Value::Array(a) => {
            serde_json::Value::Array(a.iter().map(|x| shim_value(x, shim)).collect())
        }
        serde_json::Value::Object(o) => serde_json::Value::Object(
            o.iter()
                .map(|(k, x)| (k.clone(), shim_value(x, shim)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn json_doc(text: &str) -> Result<serde_json::Value> {
    if text.trim().is_empty() {
        return Ok(serde_json::json!({}));
    }
    serde_json::from_str(text)
        .map_err(|e| Error::Memory(format!("existing config is not valid JSON: {e}")))
}

fn pointer_parts(pointer: &str) -> Vec<String> {
    pointer
        .trim_start_matches('/')
        .split('/')
        .map(|s| s.replace("~1", "/").replace("~0", "~"))
        .collect()
}

fn json_parent_mut<'a>(
    root: &'a mut serde_json::Value,
    parts: &[String],
) -> &'a mut serde_json::Map<String, serde_json::Value> {
    let mut cur = root;
    for p in &parts[..parts.len() - 1] {
        if !cur.is_object() {
            *cur = serde_json::json!({});
        }
        cur = cur
            .as_object_mut()
            .unwrap()
            .entry(p.clone())
            .or_insert_with(|| serde_json::json!({}));
    }
    if !cur.is_object() {
        *cur = serde_json::json!({});
    }
    cur.as_object_mut().unwrap()
}

fn json_string(doc: &serde_json::Value) -> Result<String> {
    serde_json::to_string_pretty(doc)
        .map(|s| format!("{s}\n"))
        .map_err(|e| Error::Memory(e.to_string()))
}

fn toml_doc(text: &str) -> Result<toml_edit::DocumentMut> {
    text.parse::<toml_edit::DocumentMut>()
        .map_err(|e| Error::Memory(format!("existing config is not valid TOML: {e}")))
}

fn toml_table_from_json(v: &serde_json::Value) -> toml_edit::Table {
    let mut t = toml_edit::Table::new();
    let Some(o) = v.as_object() else { return t };
    for (k, x) in o {
        let item = match x {
            serde_json::Value::String(s) => toml_edit::value(s.as_str()),
            serde_json::Value::Bool(b) => toml_edit::value(*b),
            serde_json::Value::Number(n) => match n.as_i64() {
                Some(i) => toml_edit::value(i),
                None => toml_edit::value(n.as_f64().unwrap_or(0.0)),
            },
            serde_json::Value::Array(a) => {
                let mut arr = toml_edit::Array::new();
                for e in a.iter().filter_map(|e| e.as_str()) {
                    arr.push(e);
                }
                toml_edit::value(arr)
            }
            _ => continue,
        };
        t.insert(k, item);
    }
    t
}

fn toml_walk_mut<'a>(
    doc: &'a mut toml_edit::DocumentMut,
    path: &[&str],
    create: bool,
) -> Option<&'a mut toml_edit::Table> {
    let mut cur = doc.as_table_mut();
    for seg in path {
        let entry = if create {
            cur.entry(seg).or_insert(toml_edit::table())
        } else {
            cur.get_mut(seg)?
        };
        cur = entry.as_table_mut()?;
    }
    Some(cur)
}

pub fn apply(text: &str, adapter: &MemoryCliAdapter, shim: &str) -> Result<String> {
    let snippet = shim_value(&adapter.snippet, shim);
    match adapter.format.as_str() {
        "json" => {
            let mut doc = json_doc(text)?;
            let parts = pointer_parts(&adapter.insertion);
            let leaf = parts
                .last()
                .cloned()
                .ok_or_else(|| Error::Memory("empty insertion".into()))?;
            json_parent_mut(&mut doc, &parts).insert(leaf, snippet);
            json_string(&doc)
        }
        "toml" => {
            let mut doc = toml_doc(text)?;
            let segs: Vec<&str> = adapter.insertion.split('.').collect();
            let (leaf, parents) = segs
                .split_last()
                .ok_or_else(|| Error::Memory("empty insertion".into()))?;
            let parent = toml_walk_mut(&mut doc, parents, true)
                .ok_or_else(|| Error::Memory("insertion path is not a table".into()))?;
            parent.insert(leaf, toml_edit::Item::Table(toml_table_from_json(&snippet)));
            Ok(doc.to_string())
        }
        other => Err(Error::Memory(format!("unsupported adapter format {other}"))),
    }
}

pub fn remove(text: &str, adapter: &MemoryCliAdapter) -> Result<String> {
    match adapter.format.as_str() {
        "json" => {
            let mut doc = json_doc(text)?;
            let parts = pointer_parts(&adapter.insertion);
            let (leaf, parents) = parts
                .split_last()
                .ok_or_else(|| Error::Memory("empty insertion".into()))?;
            let parent_ptr = if parents.is_empty() {
                String::new()
            } else {
                format!("/{}", parents.join("/"))
            };
            if let Some(obj) = doc.pointer_mut(&parent_ptr).and_then(|p| p.as_object_mut()) {
                obj.remove(leaf);
            }
            json_string(&doc)
        }
        "toml" => {
            let mut doc = toml_doc(text)?;
            let segs: Vec<&str> = adapter.insertion.split('.').collect();
            let (leaf, parents) = segs
                .split_last()
                .ok_or_else(|| Error::Memory("empty insertion".into()))?;
            if let Some(parent) = toml_walk_mut(&mut doc, parents, false) {
                parent.remove(leaf);
            }
            Ok(doc.to_string())
        }
        other => Err(Error::Memory(format!("unsupported adapter format {other}"))),
    }
}

fn toml_entry_as_json(text: &str, insertion: &str) -> Option<serde_json::Value> {
    let doc = toml_doc(text).ok()?;
    let mut table = doc.as_table();
    let segs: Vec<&str> = insertion.split('.').collect();
    let (leaf, parents) = segs.split_last()?;
    for seg in parents {
        table = table.get(seg)?.as_table()?;
    }
    let entry = table.get(leaf)?.as_table()?;
    let parsed: toml::Value = entry.to_string().parse().ok()?;
    serde_json::to_value(parsed).ok()
}

pub fn inspect(text: &str, adapter: &MemoryCliAdapter, shim: &str) -> &'static str {
    let want = shim_value(&adapter.snippet, shim);
    let have = match adapter.format.as_str() {
        "json" => json_doc(text)
            .ok()
            .and_then(|d| d.pointer(&adapter.insertion).cloned()),
        "toml" => toml_entry_as_json(text, &adapter.insertion),
        _ => None,
    };
    match have {
        None => "missing",
        Some(h) if h == want => "registered",
        Some(_) => "drifted",
    }
}

pub fn preview_diff(before: &str, after: &str) -> String {
    let b: Vec<&str> = before.lines().collect();
    let a: Vec<&str> = after.lines().collect();
    let mut out = String::new();
    for l in &b {
        if !a.contains(l) {
            out.push_str(&format!("- {l}\n"));
        }
    }
    for l in &a {
        if !b.contains(l) {
            out.push_str(&format!("+ {l}\n"));
        }
    }
    out
}

fn adapter_by_id(cfg: &MemoryConfig, id: &str) -> Result<MemoryCliAdapter> {
    cfg.cli_adapters
        .iter()
        .find(|a| a.id == id)
        .cloned()
        .ok_or_else(|| Error::Memory(format!("unknown adapter {id}")))
}

fn detected(binary: &str) -> bool {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join(binary).is_file()))
        .unwrap_or(false)
}

fn read_or_empty(path: &Path) -> Result<String> {
    match std::fs::read_to_string(path) {
        Ok(t) => Ok(t),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.into()),
    }
}

fn shim_string(cfg: &MemoryConfig, home: &Path) -> String {
    expand_home(&cfg.shim_path, home)
        .to_string_lossy()
        .into_owned()
}

fn state_of(a: &MemoryCliAdapter, shim: &str, home: &Path) -> Result<RegistrationState> {
    let path = expand_home(&a.config_path, home);
    let text = read_or_empty(&path)?;
    Ok(RegistrationState {
        id: a.id.clone(),
        detected: detected(&a.binary),
        state: inspect(&text, a, shim),
        config_path: path.to_string_lossy().into_owned(),
    })
}

fn write_with_backup(path: &Path, text: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let bak = path.with_file_name(format!(
        "{}.bak",
        path.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    ));
    if path.exists() && !bak.exists() {
        std::fs::copy(path, &bak)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[tauri::command]
pub fn memory_adapters_status(manager: State<'_, ConfigManager>) -> Result<Vec<RegistrationState>> {
    let cfg = manager.memory();
    let home = home_dir();
    let shim = shim_string(&cfg, &home);
    cfg.cli_adapters
        .iter()
        .map(|a| state_of(a, &shim, &home))
        .collect()
}

#[tauri::command]
pub fn memory_adapter_preview(manager: State<'_, ConfigManager>, id: String) -> Result<Preview> {
    let cfg = manager.memory();
    let home = home_dir();
    let a = adapter_by_id(&cfg, &id)?;
    let path = expand_home(&a.config_path, &home);
    let before = read_or_empty(&path)?;
    let after = apply(&before, &a, &shim_string(&cfg, &home))?;
    Ok(Preview {
        config_path: path.to_string_lossy().into_owned(),
        diff: preview_diff(&before, &after),
        before,
        after,
    })
}

#[tauri::command]
pub fn memory_adapter_register(
    manager: State<'_, ConfigManager>,
    id: String,
) -> Result<RegistrationState> {
    let cfg = manager.memory();
    let home = home_dir();
    let a = adapter_by_id(&cfg, &id)?;
    let shim = shim_string(&cfg, &home);
    install_shim(Path::new(&shim), &sidecar_path()?)?;
    let path = expand_home(&a.config_path, &home);
    let after = apply(&read_or_empty(&path)?, &a, &shim)?;
    write_with_backup(&path, &after)?;
    state_of(&a, &shim, &home)
}

#[tauri::command]
pub fn memory_adapter_unregister(
    manager: State<'_, ConfigManager>,
    id: String,
) -> Result<RegistrationState> {
    let cfg = manager.memory();
    let home = home_dir();
    let a = adapter_by_id(&cfg, &id)?;
    let path = expand_home(&a.config_path, &home);
    let after = remove(&read_or_empty(&path)?, &a)?;
    write_with_backup(&path, &after)?;
    state_of(&a, &shim_string(&cfg, &home), &home)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::default_cli_adapters;

    fn adapter(id: &str) -> MemoryCliAdapter {
        default_cli_adapters()
            .into_iter()
            .find(|a| a.id == id)
            .unwrap()
    }
    const SHIM: &str = "/Users/me/.shirei/bin/shirei-memory";

    #[test]
    fn claude_json_register_unregister_round_trip() {
        let a = adapter("claude");
        let before = "{\n  \"theme\": \"dark\",\n  \"mcpServers\": {\n    \"other\": { \"command\": \"x\" }\n  }\n}\n";
        assert_eq!(inspect(before, &a, SHIM), "missing");
        let after = apply(before, &a, SHIM).unwrap();
        let v: serde_json::Value = serde_json::from_str(&after).unwrap();
        assert_eq!(v["mcpServers"]["shirei-memory"]["command"], SHIM);
        assert_eq!(v["mcpServers"]["other"]["command"], "x");
        assert!(
            after.find("\"theme\"").unwrap() < after.find("\"mcpServers\"").unwrap(),
            "key order preserved"
        );
        assert_eq!(inspect(&after, &a, SHIM), "registered");
        let drifted = after.replace(SHIM, "/elsewhere");
        assert_eq!(inspect(&drifted, &a, SHIM), "drifted");
        let back = remove(&after, &a).unwrap();
        let v: serde_json::Value = serde_json::from_str(&back).unwrap();
        assert!(v["mcpServers"].get("shirei-memory").is_none());
        assert_eq!(v["mcpServers"]["other"]["command"], "x");
    }

    #[test]
    fn empty_or_missing_json_file_is_created() {
        let a = adapter("gemini");
        let after = apply("", &a, SHIM).unwrap();
        let v: serde_json::Value = serde_json::from_str(&after).unwrap();
        assert_eq!(v["mcpServers"]["shirei-memory"]["command"], SHIM);
    }

    #[test]
    fn opencode_uses_array_command_and_mcp_key() {
        let a = adapter("opencode");
        let after = apply("{}", &a, SHIM).unwrap();
        let v: serde_json::Value = serde_json::from_str(&after).unwrap();
        assert_eq!(v["mcp"]["shirei-memory"]["type"], "local");
        assert_eq!(v["mcp"]["shirei-memory"]["command"][0], SHIM);
    }

    #[test]
    fn amp_dotted_key_is_one_segment() {
        let a = adapter("amp");
        let after = apply("{}", &a, SHIM).unwrap();
        let v: serde_json::Value = serde_json::from_str(&after).unwrap();
        assert_eq!(v["amp.mcpServers"]["shirei-memory"]["command"], SHIM);
    }

    #[test]
    fn codex_toml_register_unregister_round_trip_preserves_comments() {
        let a = adapter("codex");
        let before = "# my codex config\nmodel = \"o3\"\n\n[mcp_servers.other]\ncommand = \"x\"\n";
        assert_eq!(inspect(before, &a, SHIM), "missing");
        let after = apply(before, &a, SHIM).unwrap();
        assert!(after.contains("# my codex config"), "{after}");
        assert!(after.contains("[mcp_servers.shirei-memory]"), "{after}");
        assert!(after.contains(&format!("command = \"{SHIM}\"")), "{after}");
        assert_eq!(inspect(&after, &a, SHIM), "registered");
        assert_eq!(
            inspect(&after.replace(SHIM, "/elsewhere"), &a, SHIM),
            "drifted"
        );
        let back = remove(&after, &a).unwrap();
        assert!(
            !back.contains("shirei-memory") && back.contains("[mcp_servers.other]"),
            "{back}"
        );
    }

    #[test]
    fn invalid_existing_config_is_an_error_not_a_clobber() {
        assert!(apply("{ not json", &adapter("claude"), SHIM).is_err());
        assert!(apply("[broken", &adapter("codex"), SHIM).is_err());
    }
}
