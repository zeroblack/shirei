use rmcp::handler::server::{router::tool::ToolRouter, wrapper::Parameters};
use rmcp::model::*;
use rmcp::service::RequestContext;
use rmcp::{
    schemars, tool, tool_handler, tool_router, ErrorData as McpError, RoleServer, ServerHandler,
};
use shirei_memory_core::gitinfo::current_branch;
use shirei_memory_core::store::{slug, SessionInput, Skeleton, Store, StoreError};
use shirei_memory_core::{
    find_root, overview_status_line, resolve_root_for_write, status, Thresholds, DEFAULT_DIR_NAME,
};
use std::path::PathBuf;
use time::OffsetDateTime;

const OVERVIEW_URI: &str = "shirei://memory/overview";
const NO_PROJECT: &str = "no project memory found from this directory";
const NOT_INIT: &str = "call memory_init first";
const NUDGE: &str = "\n\n---\nReminder: call memory_record_decision the moment you make a non-obvious choice, reject an alternative, or hit a constraint worth remembering, not in a batch at the end. Before this session ends, call memory_save_session and refresh the resume note with memory_set_resume.";

#[derive(Clone, Debug)]
pub struct Settings {
    pub cwd: PathBuf,
    pub home: PathBuf,
    pub dir_name: String,
    pub max_bytes: usize,
    pub thresholds: Thresholds,
    pub skeleton: Skeleton,
}

#[derive(serde::Deserialize, Default)]
struct SkeletonDefaultsFile {
    overview_skeleton: Option<String>,
    decisions_header: Option<String>,
}

fn load_skeleton(home: &std::path::Path) -> Skeleton {
    let path = std::env::var_os("SHIREI_MEMORY_DEFAULTS")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".shirei/memory-defaults.json"));
    let builtin = Skeleton::builtin();
    let Ok(text) = std::fs::read_to_string(&path) else {
        return builtin;
    };
    let Ok(file) = serde_json::from_str::<SkeletonDefaultsFile>(&text) else {
        return builtin;
    };
    Skeleton {
        overview: file
            .overview_skeleton
            .filter(|s| !s.is_empty())
            .unwrap_or(builtin.overview),
        decisions: file
            .decisions_header
            .filter(|s| !s.is_empty())
            .unwrap_or(builtin.decisions),
    }
}

impl Settings {
    pub fn from_env() -> Self {
        let env = |k: &str| std::env::var(k).ok();
        let num = |k: &str, d: u64| env(k).and_then(|v| v.parse().ok()).unwrap_or(d);
        let home = env("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/"));
        Self {
            cwd: env("SHIREI_MEMORY_CWD")
                .map(PathBuf::from)
                .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"))),
            skeleton: load_skeleton(&home),
            home,
            dir_name: env("SHIREI_MEMORY_DIR_NAME").unwrap_or_else(|| DEFAULT_DIR_NAME.to_string()),
            max_bytes: num("SHIREI_MEMORY_MAX_BYTES", 4096) as usize,
            thresholds: Thresholds {
                stale_after_days: num("SHIREI_MEMORY_STALE_DAYS", 14),
                stale_after_commits: num("SHIREI_MEMORY_STALE_COMMITS", 20) as usize,
                resume_stale_hours: num("SHIREI_MEMORY_RESUME_HOURS", 72),
            },
        }
    }
}

#[derive(Clone)]
pub struct MemoryServer {
    settings: Settings,
    tool_router: ToolRouter<Self>,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct BodyArgs {
    pub body: String,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct DecisionsArgs {
    #[schemars(description = "Only entries on or after this date, YYYY-MM-DD")]
    pub since: Option<String>,
    #[schemars(description = "Case-insensitive substring filter")]
    pub query: Option<String>,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct RecordDecisionArgs {
    pub title: String,
    pub body: String,
    pub alternatives: Option<String>,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct SessionsArgs {
    pub limit: Option<usize>,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct SessionArgs {
    pub id: String,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct SaveSessionArgs {
    pub title: String,
    pub summary: String,
    #[serde(default)]
    pub changes: Vec<String>,
    #[serde(default)]
    pub decisions: Vec<String>,
    #[serde(default)]
    pub dead_ends: Vec<String>,
    #[serde(default)]
    pub next: Vec<String>,
}

type ToolResult = Result<CallToolResult, McpError>;

fn ok(text: impl Into<String>) -> ToolResult {
    Ok(CallToolResult::success(vec![ContentBlock::text(
        text.into(),
    )]))
}

fn ok_with_nudge(text: impl Into<String>) -> ToolResult {
    ok(format!("{}{NUDGE}", text.into()))
}

fn fail(code: &str, msg: impl std::fmt::Display) -> ToolResult {
    Ok(CallToolResult::error(vec![ContentBlock::text(format!(
        "{code}: {msg}"
    ))]))
}

fn store_err(e: StoreError) -> ToolResult {
    match e {
        StoreError::NotInitialised => fail("memory/not-initialised", NOT_INIT),
        StoreError::InvalidArgs(m) => fail("memory/invalid-args", m),
        StoreError::Io(io) => fail("memory/io", io),
    }
}

fn client_name(ctx: &RequestContext<RoleServer>) -> String {
    let raw = ctx.client_info().map(|i| i.name).unwrap_or_default();
    let s = slug(&raw);
    if s.is_empty() {
        "unknown-cli".to_string()
    } else {
        s
    }
}

#[tool_router]
impl MemoryServer {
    pub fn new(settings: Settings) -> Self {
        Self {
            settings,
            tool_router: Self::tool_router(),
        }
    }

    fn read_store(&self) -> Option<(PathBuf, Store)> {
        find_root(
            &self.settings.cwd,
            &self.settings.dir_name,
            &self.settings.home,
        )
        .map(|r| (r.clone(), Store::new(&r, &self.settings.dir_name)))
    }

    fn write_store(&self) -> Store {
        let root = resolve_root_for_write(
            &self.settings.cwd,
            &self.settings.dir_name,
            &self.settings.home,
        );
        Store::new(&root, &self.settings.dir_name)
    }

    fn overview_text(&self) -> Result<String, StoreError> {
        let Some((root, store)) = self.read_store() else {
            return Err(StoreError::NotInitialised);
        };
        let doc = store.overview()?;
        let st = status(
            &store,
            &root,
            &self.settings.thresholds,
            OffsetDateTime::now_utc(),
        );
        Ok(format!("{}\n\n{}", overview_status_line(&st), doc.body))
    }

    #[tool(
        description = "Call this at the start of any task in this project, before you touch code. Reads the project overview (purpose, stack, run/test, conventions, gotchas), prefixed with a freshness note."
    )]
    async fn memory_overview(&self) -> ToolResult {
        match self.overview_text() {
            Ok(t) => ok_with_nudge(t),
            Err(StoreError::NotInitialised) => ok("No project memory yet. Call memory_init to create it, then fill the overview with memory_update_overview."),
            Err(e) => store_err(e),
        }
    }

    #[tool(
        description = "Call this when continuing previous work in this project. Reads 'where I left off' (resume note) plus the newest session summary."
    )]
    async fn memory_resume(&self) -> ToolResult {
        let Some((_, store)) = self.read_store() else {
            return fail("memory/no-project", NO_PROJECT);
        };
        let doc = match store.resume() {
            Ok(d) => d,
            Err(e) => return store_err(e),
        };
        let mut out = String::new();
        if let Some(fm) = &doc.front {
            out.push_str(&format!("Resume note by {} at {}:\n", fm.by, fm.updated));
        }
        out.push_str(&doc.body);
        if let Some(s) = store.sessions(1).unwrap_or_default().into_iter().next() {
            out.push_str(&format!(
                "\n\nLatest session: {} ({}, {}) id={}",
                s.title, s.cli, s.updated, s.id
            ));
        }
        ok_with_nudge(out)
    }

    #[tool(
        description = "Read the decisions log, optionally filtered by date (since) or substring (query)."
    )]
    async fn memory_decisions(&self, Parameters(a): Parameters<DecisionsArgs>) -> ToolResult {
        let Some((_, store)) = self.read_store() else {
            return fail("memory/no-project", NO_PROJECT);
        };
        let since = match a.since.as_deref() {
            None => None,
            Some(s) => {
                let fmt = time::macros::format_description!("[year]-[month]-[day]");
                match time::Date::parse(s, &fmt) {
                    Ok(d) => Some(d),
                    Err(_) => return fail("memory/invalid-args", "since must be YYYY-MM-DD"),
                }
            }
        };
        match store.decisions(since, a.query.as_deref()) {
            Ok(t) => ok(t),
            Err(e) => store_err(e),
        }
    }

    #[tool(description = "List saved session summaries, newest first (front-matter only).")]
    async fn memory_sessions(&self, Parameters(a): Parameters<SessionsArgs>) -> ToolResult {
        let Some((_, store)) = self.read_store() else {
            return fail("memory/no-project", NO_PROJECT);
        };
        match store.sessions(a.limit.unwrap_or(20)) {
            Ok(list) => ok(serde_json::to_string_pretty(&list).unwrap_or_default()),
            Err(e) => store_err(e),
        }
    }

    #[tool(description = "Read one saved session summary by id (from memory_sessions).")]
    async fn memory_session(&self, Parameters(a): Parameters<SessionArgs>) -> ToolResult {
        let Some((_, store)) = self.read_store() else {
            return fail("memory/no-project", NO_PROJECT);
        };
        match store.session(&a.id) {
            Ok(d) => ok(d.body),
            Err(e) => store_err(e),
        }
    }

    #[tool(
        description = "Create the project memory (.shirei/memory) with an overview skeleton. Call this once, the first time a project has no memory. Idempotent."
    )]
    async fn memory_init(&self, ctx: RequestContext<RoleServer>) -> ToolResult {
        let store = self.write_store();
        match store.init(&client_name(&ctx), &self.settings.skeleton) {
            Ok(()) => ok(format!(
                "Project memory ready at {}. Next: fill the overview now with memory_update_overview (purpose, stack, run/test commands, conventions).",
                store.dir().display()
            )),
            Err(e) => store_err(e),
        }
    }

    #[tool(
        description = "Call this whenever the stack, commands, or conventions change, to keep overview.md current. Replaces the project overview body (markdown). Keep it to one screen; a warning is returned above the size cap."
    )]
    async fn memory_update_overview(
        &self,
        Parameters(a): Parameters<BodyArgs>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        let Some((_, store)) = self.read_store() else {
            return fail("memory/not-initialised", NOT_INIT);
        };
        match store.write_overview(&a.body, &client_name(&ctx), self.settings.max_bytes) {
            Ok(out) => ok(out
                .warning
                .map(|w| format!("Saved. Warning: {w}"))
                .unwrap_or_else(|| "Saved.".into())),
            Err(e) => store_err(e),
        }
    }

    #[tool(
        description = "Call this the moment you make a non-obvious choice, reject an alternative, or hit a constraint worth remembering, while you work, not batched at the end. Appends a decision (title, why, optional alternatives rejected) to the decisions log."
    )]
    async fn memory_record_decision(
        &self,
        Parameters(a): Parameters<RecordDecisionArgs>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        let Some((_, store)) = self.read_store() else {
            return fail("memory/not-initialised", NOT_INIT);
        };
        match store.record_decision(
            &a.title,
            &a.body,
            a.alternatives.as_deref(),
            &client_name(&ctx),
        ) {
            Ok(()) => ok("Recorded."),
            Err(e) => store_err(e),
        }
    }

    #[tool(
        description = "Call this whenever you pause mid-task, not only at the end of a session. Overwrites the resume note: what you were doing, current state, next step."
    )]
    async fn memory_set_resume(
        &self,
        Parameters(a): Parameters<BodyArgs>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        let Some((_, store)) = self.read_store() else {
            return fail("memory/not-initialised", NOT_INIT);
        };
        match store.set_resume(&a.body, &client_name(&ctx)) {
            Ok(()) => ok("Saved."),
            Err(e) => store_err(e),
        }
    }

    #[tool(
        description = "Call this before the session ends or the task is done, not only when asked. Saves a distilled summary of this session (title, summary, changes, decisions, dead_ends, next). Returns the session id."
    )]
    async fn memory_save_session(
        &self,
        Parameters(a): Parameters<SaveSessionArgs>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        let Some((root, store)) = self.read_store() else {
            return fail("memory/not-initialised", NOT_INIT);
        };
        let input = SessionInput {
            title: a.title,
            summary: a.summary,
            changes: a.changes,
            decisions: a.decisions,
            dead_ends: a.dead_ends,
            next: a.next,
        };
        let cli = client_name(&ctx);
        match store.save_session(
            &input,
            &cli,
            &cli,
            current_branch(&root).as_deref(),
            &self.settings.cwd,
        ) {
            Ok(id) => ok(id),
            Err(e) => store_err(e),
        }
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for MemoryServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().enable_resources().build())
            .with_server_info(Implementation::from_build_env())
            .with_instructions(
                "Project memory for this repository. Follow these rules without waiting to be asked:\n\
                 1. Call memory_overview at the start of any task in this project, and memory_resume \
                 when continuing previous work.\n\
                 2. Call memory_record_decision at the moment you make a non-obvious choice, reject an \
                 alternative, or hit a constraint worth remembering. Do this as you work, not batched at \
                 the end.\n\
                 3. Call memory_set_resume whenever you pause mid-task, and memory_save_session before the \
                 session ends or the task is done.\n\
                 4. Call memory_update_overview to keep overview.md current whenever the stack, commands, \
                 or conventions change."
                    .to_string(),
            )
    }

    async fn list_resources(
        &self,
        _r: Option<PaginatedRequestParams>,
        _c: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, McpError> {
        Ok(ListResourcesResult {
            resources: vec![Resource::new(OVERVIEW_URI, "project overview")],
            ..Default::default()
        })
    }

    async fn read_resource(
        &self,
        r: ReadResourceRequestParams,
        _c: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, McpError> {
        if r.uri != OVERVIEW_URI {
            return Err(McpError::resource_not_found(
                "unknown resource",
                Some(serde_json::json!({ "uri": r.uri })),
            ));
        }
        let text = self
            .overview_text()
            .unwrap_or_else(|_| "No project memory yet.".to_string());
        Ok(ReadResourceResult::new(vec![ResourceContents::text(text, r.uri)]).into())
    }
}
