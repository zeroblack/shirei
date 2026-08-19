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
    pub shim_path: String,
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
) -> Result<&'a mut serde_json::Map<String, serde_json::Value>> {
    let mut cur = root;
    let mut label = "root".to_string();
    for p in &parts[..parts.len() - 1] {
        if !cur.is_object() {
            return Err(Error::Memory(format!("{label} is not an object")));
        }
        cur = cur
            .as_object_mut()
            .unwrap()
            .entry(p.clone())
            .or_insert_with(|| serde_json::json!({}));
        label = p.clone();
    }
    if !cur.is_object() {
        return Err(Error::Memory(format!("{label} is not an object")));
    }
    Ok(cur.as_object_mut().unwrap())
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

fn toml_array_from_json(a: &[serde_json::Value]) -> Result<toml_edit::Array> {
    let mut arr = toml_edit::Array::new();
    for e in a {
        match e {
            serde_json::Value::String(s) => arr.push(s.as_str()),
            serde_json::Value::Bool(b) => arr.push(*b),
            serde_json::Value::Number(n) => match n.as_i64() {
                Some(i) => arr.push(i),
                None => arr.push(n.as_f64().unwrap_or(0.0)),
            },
            other => {
                return Err(Error::Memory(format!(
                    "cannot represent array element {other} in TOML"
                )));
            }
        }
    }
    Ok(arr)
}

fn toml_table_from_json(v: &serde_json::Value) -> Result<toml_edit::Table> {
    let mut t = toml_edit::Table::new();
    let Some(o) = v.as_object() else {
        return Ok(t);
    };
    for (k, x) in o {
        let item = match x {
            serde_json::Value::String(s) => toml_edit::value(s.as_str()),
            serde_json::Value::Bool(b) => toml_edit::value(*b),
            serde_json::Value::Number(n) => match n.as_i64() {
                Some(i) => toml_edit::value(i),
                None => toml_edit::value(n.as_f64().unwrap_or(0.0)),
            },
            serde_json::Value::Array(a) => toml_edit::value(toml_array_from_json(a)?),
            serde_json::Value::Object(_) => toml_edit::Item::Table(toml_table_from_json(x)?),
            other => {
                return Err(Error::Memory(format!(
                    "cannot represent {k} ({other}) in TOML"
                )));
            }
        };
        t.insert(k, item);
    }
    Ok(t)
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
            json_parent_mut(&mut doc, &parts)?.insert(leaf, snippet);
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
            parent.insert(
                leaf,
                toml_edit::Item::Table(toml_table_from_json(&snippet)?),
            );
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

fn toml_value_to_json(v: &toml_edit::Value) -> Option<serde_json::Value> {
    match v {
        toml_edit::Value::String(s) => Some(serde_json::Value::String(s.value().clone())),
        toml_edit::Value::Integer(i) => Some(serde_json::json!(*i.value())),
        toml_edit::Value::Float(f) => Some(serde_json::json!(*f.value())),
        toml_edit::Value::Boolean(b) => Some(serde_json::json!(*b.value())),
        toml_edit::Value::Array(a) => Some(serde_json::Value::Array(
            a.iter().filter_map(toml_value_to_json).collect(),
        )),
        toml_edit::Value::InlineTable(t) => Some(serde_json::Value::Object(
            t.iter()
                .filter_map(|(k, v)| toml_value_to_json(v).map(|j| (k.to_string(), j)))
                .collect(),
        )),
        toml_edit::Value::Datetime(_) => None,
    }
}

fn toml_table_to_json(t: &toml_edit::Table) -> serde_json::Value {
    serde_json::Value::Object(
        t.iter()
            .filter_map(|(k, item)| toml_item_to_json(item).map(|j| (k.to_string(), j)))
            .collect(),
    )
}

fn toml_item_to_json(item: &toml_edit::Item) -> Option<serde_json::Value> {
    match item {
        toml_edit::Item::None => None,
        toml_edit::Item::Value(v) => toml_value_to_json(v),
        toml_edit::Item::Table(t) => Some(toml_table_to_json(t)),
        toml_edit::Item::ArrayOfTables(arr) => Some(serde_json::Value::Array(
            arr.iter().map(toml_table_to_json).collect(),
        )),
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
    Some(toml_table_to_json(entry))
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

fn needs_write(current_state: &str) -> bool {
    current_state != "missing"
}

fn state_of(a: &MemoryCliAdapter, shim: &str, home: &Path) -> Result<RegistrationState> {
    state_of_with(
        a,
        shim,
        home,
        crate::dialog::binary_on_path(a.binary.clone()),
    )
}

fn state_of_with(
    a: &MemoryCliAdapter,
    shim: &str,
    home: &Path,
    detected: bool,
) -> Result<RegistrationState> {
    let path = expand_home(&a.config_path, home);
    let text = read_or_empty(&path)?;
    Ok(RegistrationState {
        id: a.id.clone(),
        detected,
        state: inspect(&text, a, shim),
        config_path: path.to_string_lossy().into_owned(),
        shim_path: shim.to_string(),
    })
}

fn sibling(path: &Path, suffix: &str) -> std::path::PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    path.with_file_name(format!("{name}{suffix}"))
}

pub(crate) fn write_with_backup(path: &Path, text: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let bak = sibling(path, ".bak");
    if path.exists() && !bak.exists() {
        std::fs::copy(path, &bak)?;
    }
    let tmp = sibling(path, ".tmp");
    std::fs::write(&tmp, text)?;
    if let Ok(meta) = std::fs::metadata(path) {
        std::fs::set_permissions(&tmp, meta.permissions())?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[tauri::command]
pub async fn memory_adapters_status(
    manager: State<'_, ConfigManager>,
) -> Result<Vec<RegistrationState>> {
    let cfg = manager.memory();
    let home = home_dir();
    let shim = shim_string(&cfg, &home);
    let adapters = cfg.cli_adapters.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let detected: Vec<bool> = std::thread::scope(|scope| {
            adapters
                .iter()
                .map(|a| scope.spawn(|| crate::dialog::binary_on_path(a.binary.clone())))
                .collect::<Vec<_>>()
                .into_iter()
                .map(|h| h.join().unwrap_or(false))
                .collect()
        });
        adapters
            .iter()
            .zip(detected)
            .map(|(a, d)| state_of_with(a, &shim, &home, d))
            .collect()
    })
    .await
    .map_err(|e| Error::Os(e.to_string()))?
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
pub async fn memory_adapter_register(
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
    tauri::async_runtime::spawn_blocking(move || state_of(&a, &shim, &home))
        .await
        .map_err(|e| Error::Os(e.to_string()))?
}

#[tauri::command]
pub async fn memory_adapter_unregister(
    manager: State<'_, ConfigManager>,
    id: String,
) -> Result<RegistrationState> {
    let cfg = manager.memory();
    let home = home_dir();
    let a = adapter_by_id(&cfg, &id)?;
    let shim = shim_string(&cfg, &home);
    let path = expand_home(&a.config_path, &home);
    let text = read_or_empty(&path)?;
    if needs_write(inspect(&text, &a, &shim)) {
        let after = remove(&text, &a)?;
        write_with_backup(&path, &after)?;
    }
    tauri::async_runtime::spawn_blocking(move || state_of(&a, &shim, &home))
        .await
        .map_err(|e| Error::Os(e.to_string()))?
}

#[derive(Serialize)]
pub struct Handshake {
    pub ok: bool,
    pub shim_path: String,
    pub server: String,
    pub tools: Vec<String>,
    pub error: String,
}

const HANDSHAKE: &str = concat!(
    r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","#,
    r#""capabilities":{},"clientInfo":{"name":"shirei","version":"1"}}}"#,
    "\n",
    r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
    "\n",
    r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#,
    "\n",
);

fn kill_after(pid: u32, timeout: std::time::Duration) -> std::sync::mpsc::Sender<()> {
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        if rx.recv_timeout(timeout).is_err() {
            unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
        }
    });
    tx
}

fn tool_names(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .filter(|m| m.get("id").and_then(|i| i.as_u64()) == Some(2))
        .filter_map(|m| m.pointer("/result/tools").cloned())
        .filter_map(|t| t.as_array().cloned())
        .flatten()
        .filter_map(|t| t.get("name").and_then(|n| n.as_str()).map(String::from))
        .collect()
}

fn server_name(stdout: &str) -> String {
    stdout
        .lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .find_map(|m| {
            m.pointer("/result/serverInfo/name")
                .and_then(|n| n.as_str())
                .map(String::from)
        })
        .unwrap_or_default()
}

// The registry can only prove a config file was written. This spawns the shim and speaks
// MCP to it, so a broken binary or a stale shim target is caught here instead of surfacing
// as an agent that silently has no memory.
pub fn handshake(shim: &Path, timeout: std::time::Duration) -> Handshake {
    use std::io::{Read, Write};
    let mut out = Handshake {
        ok: false,
        shim_path: shim.to_string_lossy().into_owned(),
        server: String::new(),
        tools: Vec::new(),
        error: String::new(),
    };
    let spawned = std::process::Command::new(shim)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn();
    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => {
            out.error = e.to_string();
            return out;
        }
    };
    let done = kill_after(child.id(), timeout);
    if let Some(mut stdin) = child.stdin.take()
        && let Err(e) = stdin.write_all(HANDSHAKE.as_bytes())
    {
        out.error = e.to_string();
    }
    let mut text = String::new();
    if let Some(mut stdout) = child.stdout.take()
        && let Err(e) = stdout.read_to_string(&mut text)
        && out.error.is_empty()
    {
        out.error = e.to_string();
    }
    let _ = child.wait();
    let _ = done.send(());
    out.server = server_name(&text);
    out.tools = tool_names(&text);
    out.tools.sort();
    if out.tools.is_empty() && out.error.is_empty() {
        out.error = "the server started but listed no tools".into();
    }
    out.ok = !out.tools.is_empty();
    out
}

#[tauri::command]
pub async fn memory_handshake(manager: State<'_, ConfigManager>) -> Result<Handshake> {
    let cfg = manager.memory();
    let shim = expand_home(&cfg.shim_path, &home_dir());
    tauri::async_runtime::spawn_blocking(move || {
        handshake(&shim, std::time::Duration::from_secs(10))
    })
    .await
    .map_err(|e| Error::Os(e.to_string()))
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

    #[test]
    fn non_object_intermediate_json_key_is_an_error_not_a_clobber() {
        let a = adapter("claude");
        let before = "{\n  \"mcpServers\": \"not-an-object\"\n}\n";
        let err = apply(before, &a, SHIM).unwrap_err();
        assert!(err.to_string().contains("mcpServers"), "{err}");
    }

    #[test]
    fn toml_nested_object_round_trips_through_apply_and_inspect() {
        let mut a = adapter("codex");
        a.snippet = serde_json::json!({
            "command": "{shim}",
            "env": { "FOO": "bar", "COUNT": 2 }
        });
        let after = apply("", &a, SHIM).unwrap();
        assert!(after.contains("[mcp_servers.shirei-memory.env]"), "{after}");
        assert_eq!(inspect(&after, &a, SHIM), "registered");
    }

    #[test]
    fn toml_array_with_unrepresentable_element_is_an_error() {
        let mut a = adapter("codex");
        a.snippet = serde_json::json!({ "args": [{ "nested": true }] });
        assert!(apply("", &a, SHIM).is_err());
    }

    #[test]
    fn write_with_backup_preserves_existing_file_mode() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join("claude.json");
        std::fs::write(&path, "{}").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        write_with_backup(&path, "{}\n").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn unregister_skips_the_write_when_already_missing() {
        assert!(!needs_write("missing"));
        assert!(needs_write("registered"));
        assert!(needs_write("drifted"));
    }

    const TOOLS_REPLY: &str = concat!(
        r#"{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"rmcp","version":"3"}}}"#,
        "\n",
        r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"memory_overview"},"#,
        r#"{"name":"memory_init"}]}}"#,
        "\n",
    );

    #[test]
    fn handshake_parses_the_tool_list_and_server_name() {
        assert_eq!(tool_names(TOOLS_REPLY), ["memory_overview", "memory_init"]);
        assert_eq!(server_name(TOOLS_REPLY), "rmcp");
    }

    #[test]
    fn handshake_ignores_replies_to_other_requests() {
        let noise = r#"{"jsonrpc":"2.0","id":7,"result":{"tools":[{"name":"other"}]}}"#;
        assert!(tool_names(noise).is_empty());
    }

    #[test]
    fn handshake_survives_non_json_lines_on_stdout() {
        let dirty = format!("warning: something\n{TOOLS_REPLY}");
        assert_eq!(tool_names(&dirty).len(), 2);
    }

    #[test]
    fn handshake_reports_a_missing_binary_instead_of_panicking() {
        let out = handshake(
            Path::new("/nonexistent/shirei-memory"),
            std::time::Duration::from_secs(2),
        );
        assert!(!out.ok);
        assert!(!out.error.is_empty());
        assert!(out.tools.is_empty());
    }

    #[test]
    fn handshake_fails_when_the_binary_speaks_no_mcp() {
        let out = handshake(Path::new("/bin/echo"), std::time::Duration::from_secs(5));
        assert!(!out.ok);
        assert_eq!(out.error, "the server started but listed no tools");
    }
}
