use rmcp::model::{
    CallToolRequestParams, CallToolResult, Implementation, ReadResourceRequestParams,
};
use rmcp::service::{RoleClient, RunningService, ServiceExt};
use rmcp::transport::TokioChildProcess;
use serde_json::json;
use tempfile::TempDir;
use tokio::process::Command;

async fn client(cwd: &std::path::Path) -> RunningService<RoleClient, ()> {
    client_with_defaults(cwd, None).await
}

async fn client_with_defaults(
    cwd: &std::path::Path,
    defaults_path: Option<&std::path::Path>,
) -> RunningService<RoleClient, ()> {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_shirei-memory"));
    cmd.env("SHIREI_MEMORY_CWD", cwd);
    cmd.env_remove("SHIREI_MEMORY_DEFAULTS");
    if let Some(p) = defaults_path {
        cmd.env("SHIREI_MEMORY_DEFAULTS", p);
    }
    ().serve(TokioChildProcess::new(cmd).unwrap())
        .await
        .unwrap()
}

fn args(v: serde_json::Value) -> Option<serde_json::Map<String, serde_json::Value>> {
    v.as_object().cloned()
}

fn text(r: &CallToolResult) -> String {
    r.content
        .iter()
        .filter_map(|c| c.as_text().map(|t| t.text.clone()))
        .collect::<Vec<_>>()
        .join("")
}

async fn call(
    c: &RunningService<RoleClient, ()>,
    name: &str,
    a: Option<serde_json::Value>,
) -> CallToolResult {
    let mut params = CallToolRequestParams::new(name.to_string());
    if let Some(arguments) = a.and_then(args) {
        params = params.with_arguments(arguments);
    }
    c.call_tool(params).await.unwrap()
}

#[tokio::test]
async fn lists_all_tools() {
    let tmp = TempDir::new().unwrap();
    let c = client(tmp.path()).await;
    let names: Vec<String> = c
        .list_tools(Default::default())
        .await
        .unwrap()
        .tools
        .into_iter()
        .map(|t| t.name.to_string())
        .collect();
    for expected in [
        "memory_overview",
        "memory_resume",
        "memory_decisions",
        "memory_sessions",
        "memory_session",
        "memory_init",
        "memory_update_overview",
        "memory_record_decision",
        "memory_set_resume",
        "memory_save_session",
    ] {
        assert!(names.contains(&expected.to_string()), "missing {expected}");
    }
    c.cancel().await.unwrap();
}

#[tokio::test]
async fn full_cycle_from_empty_project() {
    let tmp = TempDir::new().unwrap();
    let c = client(tmp.path()).await;
    assert!(text(&call(&c, "memory_overview", None).await).contains("memory_init"));

    call(&c, "memory_init", None).await;
    assert!(tmp.path().join(".shirei/memory/overview.md").is_file());

    let big = "x".repeat(5000);
    let update_result =
        text(&call(&c, "memory_update_overview", Some(json!({ "body": big }))).await);
    assert!(update_result.contains("cap"));
    assert!(
        !update_result.contains("Reminder:"),
        "write-tool result should not carry the read-tool nudge: {update_result}"
    );

    call(
        &c,
        "memory_record_decision",
        Some(json!({ "title": "Use rmcp", "body": "official" })),
    )
    .await;
    assert!(
        text(&call(&c, "memory_decisions", Some(json!({ "query": "rmcp" }))).await)
            .contains("Use rmcp")
    );

    call(&c, "memory_set_resume", Some(json!({ "body": "mid-task" }))).await;
    let id = text(
        &call(
            &c,
            "memory_save_session",
            Some(json!({ "title": "Wire server", "summary": "done", "changes": ["main.rs"] })),
        )
        .await,
    );
    assert!(id.contains("wire-server"), "{id}");
    assert!(
        text(&call(&c, "memory_session", Some(json!({ "id": id.trim() }))).await)
            .contains("main.rs")
    );
    let resume = text(&call(&c, "memory_resume", None).await);
    assert!(
        resume.contains("mid-task") && resume.contains("Wire server"),
        "{resume}"
    );
    assert!(resume.contains("Reminder:"), "{resume}");

    let overview = text(&call(&c, "memory_overview", None).await);
    assert!(overview.contains("Reminder:"), "{overview}");

    let res = c
        .read_resource(ReadResourceRequestParams::new("shirei://memory/overview"))
        .await
        .unwrap();
    assert!(!res.contents.is_empty());
    c.cancel().await.unwrap();
}

#[tokio::test]
async fn stamps_by_from_client_info() {
    let tmp = TempDir::new().unwrap();
    let c = client(tmp.path()).await;
    call(&c, "memory_init", None).await;
    let head = std::fs::read_to_string(tmp.path().join(".shirei/memory/overview.md")).unwrap();
    let expected = shirei_memory_core::store::slug(&Implementation::default().name);
    assert!(head.contains(&format!("by: {expected}")), "{head}");
    c.cancel().await.unwrap();
}

#[tokio::test]
async fn invalid_args_surface_as_tool_error() {
    let tmp = TempDir::new().unwrap();
    let c = client(tmp.path()).await;
    call(&c, "memory_init", None).await;
    let r = call(
        &c,
        "memory_save_session",
        Some(json!({ "title": "  ", "summary": "" })),
    )
    .await;
    assert_eq!(r.is_error, Some(true));
    assert!(text(&r).contains("memory/invalid-args"));
    c.cancel().await.unwrap();
}

#[tokio::test]
async fn memory_init_uses_custom_skeleton_from_defaults_file() {
    let tmp = TempDir::new().unwrap();
    let defaults = TempDir::new().unwrap();
    let defaults_path = defaults.path().join("memory-defaults.json");
    std::fs::write(
        &defaults_path,
        json!({
            "overview_skeleton": "# Custom overview\n\nCustom body\n",
            "decisions_header": "# Custom decisions\n"
        })
        .to_string(),
    )
    .unwrap();
    let c = client_with_defaults(tmp.path(), Some(&defaults_path)).await;
    call(&c, "memory_init", None).await;
    let overview = std::fs::read_to_string(tmp.path().join(".shirei/memory/overview.md")).unwrap();
    assert!(overview.contains("Custom body"), "{overview}");
    c.cancel().await.unwrap();
}

#[tokio::test]
async fn memory_init_falls_back_to_builtin_skeleton_when_defaults_file_is_absent() {
    let tmp = TempDir::new().unwrap();
    let missing = TempDir::new().unwrap().path().join("memory-defaults.json");
    let c = client_with_defaults(tmp.path(), Some(&missing)).await;
    call(&c, "memory_init", None).await;
    let overview = std::fs::read_to_string(tmp.path().join(".shirei/memory/overview.md")).unwrap();
    assert!(overview.contains("# Project overview"), "{overview}");
    c.cancel().await.unwrap();
}
