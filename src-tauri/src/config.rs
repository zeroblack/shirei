use std::collections::BTreeMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use shirei_mux::lock::MutexExt;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{Error, Result};

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct FontConfig {
    pub family: String,
    pub size: u16,
}

impl Default for FontConfig {
    fn default() -> Self {
        FontConfig {
            family: "meslo".into(),
            size: 13,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum FontKind {
    #[default]
    Builtin,
    Download,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(default)]
pub struct FontCatalogEntry {
    pub id: String,
    pub label: String,
    pub kind: FontKind,
    pub asset: Option<String>,
    pub glyph_pattern: Option<String>,
    /// SHA-256 of the extracted font file, pinned per release. Verified before a
    /// downloaded font is written to disk so a tampered release or a MITM'd CDN
    /// can't slip arbitrary bytes into the OS font stack.
    pub sha256: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct FontsConfig {
    pub release_tag: String,
    pub catalog: Vec<FontCatalogEntry>,
}

impl Default for FontsConfig {
    fn default() -> Self {
        let builtin = |id: &str, label: &str| FontCatalogEntry {
            id: id.into(),
            label: label.into(),
            kind: FontKind::Builtin,
            asset: None,
            glyph_pattern: None,
            sha256: None,
        };
        let download = |id: &str, label: &str, asset: &str, sha256: &str| FontCatalogEntry {
            id: id.into(),
            label: label.into(),
            kind: FontKind::Download,
            asset: Some(asset.into()),
            glyph_pattern: Some("*NerdFontMono-Regular.ttf".into()),
            sha256: Some(sha256.into()),
        };
        FontsConfig {
            release_tag: "v3.4.0".into(),
            catalog: vec![
                builtin("meslo", "Meslo"),
                builtin("jetbrains", "JetBrains Mono"),
                builtin("hack", "Hack"),
                download(
                    "cascadia",
                    "Cascadia Code",
                    "CascadiaCode",
                    "32aa528c1d9be2240ceac90aa05f4e554679cabeb11b93684eb24ec4930bd0ea",
                ),
                download(
                    "firacode",
                    "Fira Code",
                    "FiraCode",
                    "ad88c69cb6a497db9f2714e4b414817aabbee621484a1560bfdb3fd73abdd564",
                ),
                download(
                    "geistmono",
                    "Geist Mono",
                    "GeistMono",
                    "58659ba839f49dbd0867dce44ea692a21e5a54fb145d17b066165fdd7699ca2c",
                ),
                download(
                    "commitmono",
                    "Commit Mono",
                    "CommitMono",
                    "a126774b8756e383df4f94849e59808c089361c8171cc3820d10ee5a6a561c82",
                ),
                download(
                    "0xproto",
                    "0xProto",
                    "0xProto",
                    "e98bf52027a5895c1cad6101b8ef5905e8acc5309bb264eaff9063bf94d99848",
                ),
            ],
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Preset {
    #[default]
    Dark,
    Light,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(rename_all = "kebab-case")]
pub enum SyntaxTheme {
    #[default]
    OneDark,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum CursorStyle {
    #[default]
    Block,
    Bar,
    Underline,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum FontSmoothing {
    #[default]
    Antialiased,
    Subpixel,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct RenderConfig {
    pub webgl: bool,
    pub kitty_keyboard: bool,
    pub shift_enter_newline: bool,
    pub line_height: f32,
    pub letter_spacing: i16,
    pub min_contrast: f32,
    pub scrollback: u32,
    pub cursor_style: CursorStyle,
    pub cursor_blink: bool,
    pub font_smoothing: FontSmoothing,
    pub padding: u16,
    pub diagnostics: bool,
    pub webgl_pool_cap: u16,
}

impl Default for RenderConfig {
    fn default() -> Self {
        RenderConfig {
            webgl: true,
            kitty_keyboard: true,
            shift_enter_newline: true,
            line_height: 1.0,
            letter_spacing: 0,
            min_contrast: 1.0,
            scrollback: 5000,
            cursor_style: CursorStyle::default(),
            cursor_blink: true,
            font_smoothing: FontSmoothing::default(),
            padding: 8,
            diagnostics: true,
            webgl_pool_cap: 12,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct TerminalColors {
    pub bg: String,
    pub fg: String,
    pub cursor: String,
    pub black: String,
    pub red: String,
    pub green: String,
    pub yellow: String,
    pub blue: String,
    pub magenta: String,
    pub cyan: String,
    pub white: String,
    pub bright_black: String,
    pub bright_red: String,
    pub bright_green: String,
    pub bright_yellow: String,
    pub bright_blue: String,
    pub bright_magenta: String,
    pub bright_cyan: String,
    pub bright_white: String,
}

impl Default for TerminalColors {
    fn default() -> Self {
        TerminalColors {
            bg: "#000000".into(),
            fg: "#ffffff".into(),
            cursor: "#ffffff".into(),
            black: "#15161a".into(),
            red: "#ef4444".into(),
            green: "#22c55e".into(),
            yellow: "#eab308".into(),
            blue: "#3b82f6".into(),
            magenta: "#d946ef".into(),
            cyan: "#06b6d4".into(),
            white: "#d4d4d8".into(),
            bright_black: "#52525b".into(),
            bright_red: "#f87171".into(),
            bright_green: "#4ade80".into(),
            bright_yellow: "#facc15".into(),
            bright_blue: "#60a5fa".into(),
            bright_magenta: "#e879f9".into(),
            bright_cyan: "#22d3ee".into(),
            bright_white: "#ffffff".into(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct EditorTheme {
    pub syntax: SyntaxTheme,
    pub bg: String,
}

impl Default for EditorTheme {
    fn default() -> Self {
        EditorTheme {
            syntax: SyntaxTheme::OneDark,
            bg: "#000000".into(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct EditorConfig {
    pub vim: bool,
    pub live_preview: bool,
    pub line_numbers: bool,
    pub active_line: bool,
    pub bracket_matching: bool,
    pub indent_guides: bool,
    pub folding: bool,
    pub close_brackets: bool,
    pub highlight_matches: bool,
    pub search_case: bool,
    pub search_regex: bool,
    pub search_whole_word: bool,
    // Reading width caps long lines for legibility. Prose (markdown/txt) wraps to
    // a measure; code keeps no-wrap horizontal scroll. Values are CSS max-width
    // lengths, so they may be fluid: the default `min(90%, 80ch)` grows with the
    // pane up to a readable ~80 columns. Empty = no cap.
    pub prose_width: String,
    pub wrap_prose: bool,
    pub code_width: String,
    pub wrap_code: bool,
}

impl Default for EditorConfig {
    fn default() -> Self {
        EditorConfig {
            vim: false,
            live_preview: true,
            line_numbers: true,
            active_line: true,
            bracket_matching: true,
            indent_guides: true,
            folding: true,
            close_brackets: true,
            highlight_matches: true,
            search_case: false,
            search_regex: false,
            search_whole_word: false,
            prose_width: "min(90%, 80ch)".into(),
            wrap_prose: true,
            code_width: String::new(),
            wrap_code: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum GitHistoryView {
    #[default]
    Diff,
    Full,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct GitBlameConfig {
    pub enabled: bool,
    pub delay_ms: u32,
}

impl Default for GitBlameConfig {
    fn default() -> Self {
        GitBlameConfig {
            enabled: false,
            delay_ms: 380,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(default)]
pub struct GitHistoryConfig {
    pub default_view: GitHistoryView,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(default)]
pub struct GitConfig {
    pub blame: GitBlameConfig,
    pub history: GitHistoryConfig,
}

fn default_tabs() -> Vec<String> {
    [
        "#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct ThemeConfig {
    pub preset: Preset,
    pub terminal: TerminalColors,
    pub editor: EditorTheme,
    pub tabs: Vec<String>,
}

impl Default for ThemeConfig {
    fn default() -> Self {
        ThemeConfig {
            preset: Preset::default(),
            terminal: TerminalColors::default(),
            editor: EditorTheme::default(),
            tabs: default_tabs(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct LayoutConfig {
    pub sidebar_width: u16,
    pub sidebar_min_width: u16,
    pub sidebar_max_fraction: f32,
    pub todo_min_rows: u16,
    pub todo_region_ratio: f32,
    pub todo_collapsed: bool,
    pub default_template: String,
    pub new_tab_dir: String,
}

impl Default for LayoutConfig {
    fn default() -> Self {
        LayoutConfig {
            sidebar_width: 240,
            sidebar_min_width: 160,
            sidebar_max_fraction: 0.6,
            todo_min_rows: 3,
            todo_region_ratio: 0.5,
            todo_collapsed: false,
            default_template: String::new(),
            new_tab_dir: String::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct MotionConfig {
    pub enabled: bool,
    pub task_sink_ms: u16,
    pub modal_in_ms: u16,
    pub modal_out_ms: u16,
    pub reveal_ms: u16,
    pub reveal_stagger_ms: u16,
    pub divider_snap_ms: u16,
    pub respect_reduced_motion: bool,
}

impl Default for MotionConfig {
    fn default() -> Self {
        MotionConfig {
            enabled: true,
            task_sink_ms: 220,
            modal_in_ms: 200,
            modal_out_ms: 130,
            reveal_ms: 160,
            reveal_stagger_ms: 40,
            divider_snap_ms: 180,
            respect_reduced_motion: true,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct TabsConfig {
    pub show_age: bool,
    pub age_refresh_secs: u32,
    pub activity_throttle_secs: u32,
}

impl Default for TabsConfig {
    fn default() -> Self {
        TabsConfig {
            show_age: false,
            age_refresh_secs: 30,
            activity_throttle_secs: 5,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct ChromeConfig {
    pub dim_inactive: bool,
    pub pane_accent: bool,
    pub tab_accent_line: bool,
    pub active_tab_highlight: bool,
}

impl Default for ChromeConfig {
    fn default() -> Self {
        ChromeConfig {
            dim_inactive: true,
            pane_accent: true,
            tab_accent_line: true,
            active_tab_highlight: true,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct PerfMetrics {
    pub cpu_tab: bool,
    pub mem_tab: bool,
    pub disk_tab: bool,
    pub net_tab: bool,
    pub cpu_app: bool,
    pub mem_app: bool,
    pub disk_app: bool,
    pub net_app: bool,
}

impl Default for PerfMetrics {
    fn default() -> Self {
        PerfMetrics {
            cpu_tab: true,
            mem_tab: true,
            disk_tab: false,
            net_tab: false,
            cpu_app: true,
            mem_app: true,
            disk_app: false,
            net_app: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct PerfThresholds {
    pub warn: u8,
    pub crit: u8,
}

impl Default for PerfThresholds {
    fn default() -> Self {
        PerfThresholds { warn: 70, crit: 90 }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct PerformanceConfig {
    pub enabled: bool,
    pub refresh_secs: u32,
    pub sparklines: bool,
    pub metrics: PerfMetrics,
    pub thresholds: PerfThresholds,
}

impl Default for PerformanceConfig {
    fn default() -> Self {
        PerformanceConfig {
            enabled: false,
            refresh_secs: 2,
            sparklines: true,
            metrics: PerfMetrics::default(),
            thresholds: PerfThresholds::default(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct LimitsConfig {
    pub max_file_bytes: u64,
    pub index_cap: usize,
    pub max_image_bytes: u64,
    pub quickopen_results: usize,
    pub dir_entries_cap: usize,
    pub font_size_min: u16,
    pub font_size_max: u16,
}

impl Default for LimitsConfig {
    fn default() -> Self {
        LimitsConfig {
            max_file_bytes: 5 * 1024 * 1024,
            index_cap: 50_000,
            max_image_bytes: 25 * 1024 * 1024,
            quickopen_results: 50,
            dir_entries_cap: 2000,
            font_size_min: 8,
            font_size_max: 36,
        }
    }
}

fn default_exclude_dirs() -> Vec<String> {
    [
        "node_modules",
        ".git",
        "target",
        "dist",
        "build",
        "out",
        ".next",
        ".nuxt",
        ".svelte-kit",
        ".turbo",
        ".cache",
        "coverage",
        ".venv",
        "__pycache__",
        "vendor",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct FilesConfig {
    pub exclude_dirs: Vec<String>,
    pub respect_gitignore: bool,
}

impl Default for FilesConfig {
    fn default() -> Self {
        FilesConfig {
            exclude_dirs: default_exclude_dirs(),
            respect_gitignore: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum RecordFormat {
    #[default]
    Mp4,
    Gif,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum FinishAction {
    #[default]
    Ask,
    Copy,
    Reveal,
    Share,
    None,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct RecorderConfig {
    pub dir: String,
    pub format: RecordFormat,
    pub fps: u16,
    pub gif_fps: u16,
    pub gif_max_width: u32,
    pub show_cursor: bool,
    pub countdown_secs: u16,
    pub max_duration_secs: u32,
    pub on_finish: FinishAction,
    pub filename_template: String,
}

impl Default for RecorderConfig {
    fn default() -> Self {
        RecorderConfig {
            dir: "~/Movies/Shirei".to_string(),
            format: RecordFormat::Mp4,
            fps: 30,
            gif_fps: 15,
            gif_max_width: 1000,
            show_cursor: true,
            countdown_secs: 0,
            max_duration_secs: 0,
            on_finish: FinishAction::Ask,
            filename_template: "{tab}-{date}".to_string(),
        }
    }
}

fn tpl_leaf(command: Option<&str>) -> serde_json::Value {
    match command {
        Some(c) => serde_json::json!({ "kind": "leaf", "id": "", "command": c }),
        None => serde_json::json!({ "kind": "leaf", "id": "" }),
    }
}

fn tpl_split(
    dir: &str,
    ratio: f64,
    a: serde_json::Value,
    b: serde_json::Value,
) -> serde_json::Value {
    serde_json::json!({ "kind": "split", "dir": dir, "ratio": ratio, "a": a, "b": b })
}

fn tpl_sidebar() -> serde_json::Value {
    tpl_split("v", 0.5, tpl_leaf(None), tpl_leaf(None))
}

fn tpl_terms4() -> serde_json::Value {
    tpl_split(
        "v",
        0.25,
        tpl_leaf(None),
        tpl_split(
            "v",
            0.333,
            tpl_leaf(None),
            tpl_split("v", 0.5, tpl_leaf(None), tpl_leaf(None)),
        ),
    )
}

fn claude_grid() -> serde_json::Value {
    tpl_split(
        "h",
        0.5,
        tpl_split("v", 0.5, tpl_leaf(Some("claude")), tpl_leaf(Some("claude"))),
        tpl_split("v", 0.5, tpl_leaf(Some("claude")), tpl_leaf(Some("claude"))),
    )
}

fn wt_right() -> serde_json::Value {
    tpl_split(
        "v",
        0.6,
        tpl_leaf(None),
        tpl_split("v", 0.5, tpl_leaf(None), tpl_leaf(None)),
    )
}

fn default_templates() -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({
            "name": "s1",
            "tree": tpl_split("h", 0.5, tpl_sidebar(),
                tpl_split("h", 0.5, tpl_leaf(Some("claude")), tpl_terms4())),
        }),
        serde_json::json!({
            "name": "s2",
            "tree": tpl_split("h", 0.4, tpl_sidebar(),
                tpl_split("h", 0.667,
                    tpl_split("h", 0.5, tpl_leaf(Some("claude")), tpl_leaf(Some("claude"))),
                    tpl_terms4())),
        }),
        serde_json::json!({
            "name": "s4",
            "tree": tpl_split("h", 0.4, tpl_sidebar(),
                tpl_split("h", 0.667, claude_grid(), tpl_terms4())),
        }),
        serde_json::json!({
            "name": "w1",
            "tree": tpl_split("h", 0.65, tpl_leaf(Some("claude")), wt_right()),
        }),
        serde_json::json!({
            "name": "w2",
            "tree": tpl_split("h", 0.65,
                tpl_split("h", 0.5, tpl_leaf(Some("claude")), tpl_leaf(Some("claude"))),
                wt_right()),
        }),
        serde_json::json!({
            "name": "w4",
            "tree": tpl_split("h", 0.65, claude_grid(), wt_right()),
        }),
        serde_json::json!({
            "name": "Yagura",
            "tree": tpl_split("h", 0.5, tpl_leaf(None),
                tpl_split("v", 0.62, tpl_leaf(Some("yagura")), tpl_leaf(None))),
        }),
    ]
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ConfirmPolicy {
    #[default]
    RunningOnly,
    Always,
    Never,
}

/// Which pane commands re-run automatically when a saved session is restored.
/// `All` includes commands observed in live panes (snapshot), `Templates`
/// only those declared in project/layout templates, `Never` none.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(rename_all = "kebab-case")]
pub enum RestoreCommands {
    #[default]
    All,
    Templates,
    Never,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct StatusColors {
    pub reconnecting: String,
    pub exited: String,
}

impl Default for StatusColors {
    fn default() -> Self {
        StatusColors {
            reconnecting: "#f59e0b".into(),
            exited: "#6b7280".into(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct SessionConfig {
    pub keep_alive: bool,
    pub confirm_kill: ConfirmPolicy,
    pub confirm_close: ConfirmPolicy,
    pub safe_processes: Vec<String>,
    pub autostart_daemon: bool,
    pub launch_agent: bool,
    pub orphan_ttl_secs: u32,
    pub status_colors: StatusColors,
    pub restore_commands: RestoreCommands,
    pub snapshot_interval_secs: u32,
}

impl Default for SessionConfig {
    fn default() -> Self {
        SessionConfig {
            keep_alive: false,
            confirm_kill: ConfirmPolicy::default(),
            confirm_close: ConfirmPolicy::Always,
            safe_processes: ["zsh", "bash", "fish", "sh", "tmux"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            autostart_daemon: true,
            launch_agent: false,
            orphan_ttl_secs: 0,
            status_colors: StatusColors::default(),
            restore_commands: RestoreCommands::default(),
            snapshot_interval_secs: 20,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Off,
    Error,
    Warn,
    #[default]
    Info,
    Debug,
    Trace,
}

impl From<LogLevel> for log::LevelFilter {
    fn from(level: LogLevel) -> Self {
        match level {
            LogLevel::Off => log::LevelFilter::Off,
            LogLevel::Error => log::LevelFilter::Error,
            LogLevel::Warn => log::LevelFilter::Warn,
            LogLevel::Info => log::LevelFilter::Info,
            LogLevel::Debug => log::LevelFilter::Debug,
            LogLevel::Trace => log::LevelFilter::Trace,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct LoggingConfig {
    pub level: LogLevel,
    pub max_file_mb: u16,
    pub keep_files: u16,
    // Off by default: the raw PTY stream and AI-session content routinely carry
    // secrets (tokens, `cat .env`), so capturing it is an explicit opt-in.
    pub capture_session: bool,
}

impl Default for LoggingConfig {
    fn default() -> Self {
        LoggingConfig {
            level: LogLevel::Info,
            max_file_mb: 5,
            keep_files: 5,
            capture_session: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Locale {
    #[default]
    En,
    Es,
}

// Mirrors the frontend `Keystroke` (src/keys.ts): modifiers are present only
// when set, so a cleared binding round-trips without sprouting `false` flags.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
pub struct Keystroke {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shift: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alt: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ctrl: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct Config {
    pub locale: Locale,
    pub font: FontConfig,
    pub fonts: FontsConfig,
    pub theme: ThemeConfig,
    pub render: RenderConfig,
    pub session: SessionConfig,
    pub editor: EditorConfig,
    #[serde(default)]
    pub git: GitConfig,
    pub logging: LoggingConfig,
    pub limits: LimitsConfig,
    pub layout: LayoutConfig,
    pub motion: MotionConfig,
    pub tabs: TabsConfig,
    pub chrome: ChromeConfig,
    pub performance: PerformanceConfig,
    pub files: FilesConfig,
    pub recorder: RecorderConfig,
    #[serde(default)]
    pub projects: Vec<serde_json::Value>,
    #[serde(skip_deserializing, default = "default_templates")]
    pub templates: Vec<serde_json::Value>,
    #[serde(default)]
    pub user_templates: Vec<serde_json::Value>,
    // A `None` value is a deliberately-cleared binding (the action has no key),
    // distinct from an absent key (the action keeps its default).
    #[serde(default)]
    pub keybindings: BTreeMap<String, Option<Vec<Keystroke>>>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            locale: Locale::default(),
            font: FontConfig::default(),
            fonts: FontsConfig::default(),
            theme: ThemeConfig::default(),
            render: RenderConfig::default(),
            session: SessionConfig::default(),
            editor: EditorConfig::default(),
            git: GitConfig::default(),
            logging: LoggingConfig::default(),
            limits: LimitsConfig::default(),
            layout: LayoutConfig::default(),
            motion: MotionConfig::default(),
            tabs: TabsConfig::default(),
            chrome: ChromeConfig::default(),
            performance: PerformanceConfig::default(),
            files: FilesConfig::default(),
            recorder: RecorderConfig::default(),
            projects: Vec::new(),
            templates: default_templates(),
            user_templates: Vec::new(),
            keybindings: BTreeMap::new(),
        }
    }
}

impl Config {
    pub fn from_json_or_default(text: &str) -> Config {
        serde_json::from_str(text).unwrap_or_default()
    }
}

#[derive(Default)]
pub struct ConfigManager {
    inner: Mutex<Config>,
}

// The log plugin is registered before the app handle (and its path resolver)
// exists, so the logging settings are read straight from disk at the location
// `app_config_dir()` resolves to on macOS: ~/Library/Application Support/{id}.
// Changing them needs a restart, which matches a build-time logger anyway.
pub fn load_logging(identifier: &str) -> LoggingConfig {
    std::env::var_os("HOME")
        .map(|home| {
            std::path::PathBuf::from(home)
                .join("Library/Application Support")
                .join(identifier)
                .join("config.json")
        })
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|text| Config::from_json_or_default(&text).logging)
        .unwrap_or_default()
}

fn config_path(app: &AppHandle) -> Result<std::path::PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| Error::Config(e.to_string()))?;
    std::fs::create_dir_all(&dir).map_err(Error::Io)?;
    Ok(dir.join("config.json"))
}

impl ConfigManager {
    fn lock(&self) -> std::sync::MutexGuard<'_, Config> {
        self.inner.lock_ignore_poison()
    }

    pub fn load(&self, app: &AppHandle) {
        if let Ok(path) = config_path(app)
            && let Ok(text) = std::fs::read_to_string(&path)
        {
            *self.lock() = Config::from_json_or_default(&text);
        }
    }

    pub fn current(&self) -> Config {
        self.lock().clone()
    }

    pub fn replace(&self, config: Config) {
        *self.lock() = config;
    }

    pub fn limits(&self) -> LimitsConfig {
        self.lock().limits.clone()
    }

    pub fn files(&self) -> FilesConfig {
        self.lock().files.clone()
    }

    pub fn performance(&self) -> PerformanceConfig {
        self.lock().performance.clone()
    }
}

#[tauri::command]
pub fn config_get(manager: State<'_, ConfigManager>) -> Config {
    manager.current()
}

#[tauri::command]
pub fn config_set(app: AppHandle, manager: State<'_, ConfigManager>, config: Config) -> Result<()> {
    let path = config_path(&app)?;
    let text = serde_json::to_string_pretty(&config).map_err(|e| Error::Config(e.to_string()))?;
    // Atomic replace: a crash mid-save must never corrupt config.json, since a
    // corrupt file silently resets every setting to defaults on next launch.
    crate::fs::write_atomic(&path, text.as_bytes()).map_err(Error::Io)?;
    *manager.lock() = config.clone();
    app.emit("config-changed", config)
        .map_err(|e| Error::Config(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_defaults_are_sane() {
        let s = Config::default().session;
        assert!(!s.keep_alive);
        assert_eq!(s.confirm_kill, ConfirmPolicy::RunningOnly);
        assert_eq!(s.confirm_close, ConfirmPolicy::Always);
        assert!(s.autostart_daemon);
        assert!(s.safe_processes.contains(&"zsh".to_string()));
        assert_eq!(s.status_colors.exited, "#6b7280");
        assert_eq!(s.restore_commands, RestoreCommands::All);
        assert_eq!(s.snapshot_interval_secs, 20);
    }

    #[test]
    fn performance_defaults_are_sane() {
        let p = Config::default().performance;
        assert!(!p.enabled);
        assert_eq!(p.refresh_secs, 2);
        assert!(p.metrics.cpu_tab);
        assert!(p.metrics.mem_tab);
        assert!(p.metrics.cpu_app);
        assert!(p.metrics.mem_app);
        assert!(!p.metrics.disk_tab);
        assert!(!p.metrics.net_tab);
        assert!(!p.metrics.disk_app);
        assert!(!p.metrics.net_app);
        assert!(p.sparklines);
        assert_eq!(p.thresholds.warn, 70);
        assert_eq!(p.thresholds.crit, 90);
    }

    #[test]
    fn default_matches_current_values() {
        let c = Config::default();
        assert_eq!(c.font.size, 13);
        assert_eq!(c.font.family, "meslo");
        assert_eq!(c.limits.max_file_bytes, 5 * 1024 * 1024);
        assert_eq!(c.limits.index_cap, 50_000);
        assert_eq!(c.limits.quickopen_results, 50);
        assert_eq!(c.limits.dir_entries_cap, 2000);
        assert_eq!(c.limits.font_size_min, 8);
        assert_eq!(c.limits.font_size_max, 36);
        assert!(c.files.exclude_dirs.contains(&"node_modules".to_string()));
        assert_eq!(c.theme.tabs.len(), 8);
        assert_eq!(c.layout.sidebar_width, 240);
        assert_eq!(c.layout.sidebar_min_width, 160);
        assert!((c.layout.sidebar_max_fraction - 0.6).abs() < f32::EPSILON);
        assert_eq!(c.tabs.age_refresh_secs, 30);
        assert_eq!(c.tabs.activity_throttle_secs, 5);
        assert!(c.keybindings.is_empty());
    }

    #[test]
    fn keybindings_overrides_persist_without_breaking_old_json() {
        let c = Config::from_json_or_default(r#"{"font":{"size":20}}"#);
        assert!(c.keybindings.is_empty());
        let c = Config::from_json_or_default(
            r#"{"keybindings":{"tab.new":[{"key":"n","meta":true}],"tab.close":null}}"#,
        );
        let binding = c.keybindings.get("tab.new").unwrap().as_ref().unwrap();
        assert_eq!(binding[0].key, "n");
        assert_eq!(binding[0].meta, Some(true));
        assert_eq!(binding[0].shift, None);
        assert!(c.keybindings.get("tab.close").unwrap().is_none());
    }

    #[test]
    fn keybindings_survive_a_serialize_deserialize_cycle() {
        let mut original = Config::default();
        original.keybindings.insert(
            "tab.new".into(),
            Some(vec![Keystroke {
                key: "n".into(),
                meta: Some(true),
                ..Default::default()
            }]),
        );
        original.keybindings.insert("palette.open".into(), None);
        let json = serde_json::to_string(&original).unwrap();
        let restored = Config::from_json_or_default(&json);
        assert_eq!(original.keybindings, restored.keybindings);
    }

    #[test]
    fn partial_json_fills_layout_default() {
        let c = Config::from_json_or_default(r#"{"font":{"size":20}}"#);
        assert_eq!(c.layout.sidebar_width, 240);
        let c = Config::from_json_or_default(r#"{"layout":{"sidebar_width":320}}"#);
        assert_eq!(c.layout.sidebar_width, 320);
    }

    #[test]
    fn partial_json_fills_quickopen_default() {
        let c = Config::from_json_or_default(r#"{"limits":{"index_cap":1000}}"#);
        assert_eq!(c.limits.quickopen_results, 50);
        let c = Config::from_json_or_default(r#"{"limits":{"quickopen_results":120}}"#);
        assert_eq!(c.limits.quickopen_results, 120);
    }

    #[test]
    fn editor_vim_defaults_off_and_persists() {
        assert!(!Config::default().editor.vim);
        let c = Config::from_json_or_default(r#"{"editor":{"vim":true}}"#);
        assert!(c.editor.vim);
        let c = Config::from_json_or_default(r#"{"font":{"size":20}}"#);
        assert!(!c.editor.vim);
    }

    #[test]
    fn serde_round_trip() {
        let c = Config::default();
        let json = serde_json::to_string(&c).unwrap();
        let back: Config = serde_json::from_str(&json).unwrap();
        assert_eq!(c, back);
    }

    #[test]
    fn partial_json_fills_defaults() {
        let c = Config::from_json_or_default(r#"{"font":{"size":20}}"#);
        assert_eq!(c.font.size, 20);
        assert_eq!(c.font.family, "meslo");
        assert_eq!(c.limits.index_cap, 50_000);
    }

    #[test]
    fn default_seeds_layout_templates() {
        let names: Vec<String> = Config::default()
            .templates
            .iter()
            .filter_map(|t| t["name"].as_str().map(str::to_string))
            .collect();
        assert_eq!(names, ["s1", "s2", "s4", "w1", "w2", "w4", "Yagura"]);
    }

    #[test]
    fn partial_json_seeds_templates() {
        let c = Config::from_json_or_default(r#"{"font":{"size":20}}"#);
        assert_eq!(c.templates.len(), 7);
    }

    #[test]
    fn config_serializes_templates_for_frontend() {
        let json = serde_json::to_value(Config::default()).unwrap();
        let templates = json["templates"]
            .as_array()
            .expect("templates missing from serialized config");
        assert_eq!(templates.len(), 7);
    }

    // `yagura` is an intentional first-class companion template; only ad-hoc
    // personal aliases (e.g. `y`) must stay out of the shipped defaults.
    #[test]
    fn default_templates_carry_no_personal_commands() {
        let json = serde_json::to_string(&default_templates()).unwrap();
        assert!(!json.contains("\"command\":\"y\""));
    }

    #[test]
    fn corrupt_json_falls_back_to_default() {
        let c = Config::from_json_or_default("not json {");
        assert_eq!(c, Config::default());
    }

    #[test]
    fn render_defaults_are_sane() {
        let r = Config::default().render;
        assert!(r.webgl);
        assert!(r.kitty_keyboard);
        assert!(r.shift_enter_newline);
        assert_eq!(r.line_height, 1.0);
        assert_eq!(r.min_contrast, 1.0);
        assert_eq!(r.scrollback, 5000);
        assert_eq!(r.cursor_style, CursorStyle::Block);
        assert_eq!(r.font_smoothing, FontSmoothing::Antialiased);
        assert_eq!(r.padding, 8);
        assert_eq!(r.webgl_pool_cap, 12);
    }

    #[test]
    fn partial_json_fills_render_defaults() {
        let c = Config::from_json_or_default(r#"{"render":{"webgl":false}}"#);
        assert!(!c.render.webgl);
        assert_eq!(c.render.scrollback, 5000);
        assert_eq!(c.render.min_contrast, 1.0);
    }

    #[test]
    fn terminal_palette_has_vivid_defaults() {
        let t = Config::default().theme.terminal;
        assert_eq!(t.bg, "#000000");
        assert_eq!(t.red, "#ef4444");
        assert_eq!(t.bright_white, "#ffffff");
    }

    #[test]
    fn terminal_palette_serializes_camel_case() {
        let json = serde_json::to_value(TerminalColors::default()).unwrap();
        assert!(json.get("brightBlack").is_some());
        assert!(json.get("bright_black").is_none());
    }

    #[test]
    fn partial_json_fills_palette_defaults() {
        let c = Config::from_json_or_default(r##"{"theme":{"terminal":{"bg":"#101010"}}}"##);
        assert_eq!(c.theme.terminal.bg, "#101010");
        assert_eq!(c.theme.terminal.red, "#ef4444");
    }

    #[test]
    fn cursor_style_serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&CursorStyle::Underline).unwrap(),
            "\"underline\""
        );
    }

    #[test]
    fn recorder_defaults_are_sane() {
        let r = RecorderConfig::default();
        assert_eq!(r.fps, 30);
        assert_eq!(r.dir, "~/Movies/Shirei");
        assert!(matches!(r.format, RecordFormat::Mp4));
        assert!(matches!(r.on_finish, FinishAction::Ask));
    }

    #[test]
    fn recorder_enums_serialize_lowercase() {
        assert_eq!(
            serde_json::to_string(&RecordFormat::Mp4).unwrap(),
            "\"mp4\""
        );
        assert_eq!(
            serde_json::to_string(&RecordFormat::Gif).unwrap(),
            "\"gif\""
        );
        assert_eq!(
            serde_json::to_string(&FinishAction::Ask).unwrap(),
            "\"ask\""
        );
        assert_eq!(
            serde_json::to_string(&FinishAction::None).unwrap(),
            "\"none\""
        );
    }

    #[test]
    fn todo_layout_and_motion_defaults() {
        let c = Config::default();
        assert_eq!(c.layout.todo_min_rows, 3);
        assert_eq!(c.layout.todo_region_ratio, 0.5);
        assert!(!c.layout.todo_collapsed);
        assert!(c.motion.enabled);
        assert_eq!(c.motion.task_sink_ms, 220);
    }

    #[test]
    fn default_catalog_has_builtins_and_downloads() {
        let cfg = Config::default();
        assert_eq!(cfg.font.family, "meslo");
        let ids: Vec<&str> = cfg.fonts.catalog.iter().map(|e| e.id.as_str()).collect();
        for id in [
            "meslo",
            "jetbrains",
            "hack",
            "cascadia",
            "firacode",
            "geistmono",
            "commitmono",
            "0xproto",
        ] {
            assert!(ids.contains(&id), "catalog missing {id}");
        }
        let fira = cfg
            .fonts
            .catalog
            .iter()
            .find(|e| e.id == "firacode")
            .unwrap();
        assert_eq!(fira.kind, FontKind::Download);
        assert_eq!(fira.asset.as_deref(), Some("FiraCode"));
    }
}
