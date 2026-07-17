use std::collections::{BTreeMap, HashMap};
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
pub enum CursorInactiveStyle {
    // Unfocused panes draw no cursor: in a multi-pane cockpit a TUI that drops
    // its hide-cursor mode would otherwise leave a stray block on every idle pane.
    #[default]
    None,
    Outline,
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
    pub cursor_inactive_style: CursorInactiveStyle,
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
            cursor_inactive_style: CursorInactiveStyle::default(),
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
    pub autosave: bool,
    pub autosave_delay_ms: u32,
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
            autosave: true,
            autosave_delay_ms: 1000,
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
    Working,
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
    pub pane_content_cap: u8,
    pub pin_width_fraction: f32,
    pub pin_min_fraction: f32,
    pub pin_max_fraction: f32,
    pub pin_split_fraction: f32,
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
            pane_content_cap: 3,
            pin_width_fraction: 0.28,
            pin_min_fraction: 0.15,
            pin_max_fraction: 0.55,
            pin_split_fraction: 0.5,
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
    pub context_hints: bool,
}

impl Default for ChromeConfig {
    fn default() -> Self {
        ChromeConfig {
            dim_inactive: true,
            pane_accent: true,
            tab_accent_line: true,
            active_tab_highlight: true,
            context_hints: true,
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
        ".worktrees",
        ".superpowers",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

fn default_home_exclude_extra() -> Vec<String> {
    [".cache", ".local/share", ".Trash"]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct SearchConfig {
    pub walk_entries_ceiling: u32,
    pub walk_budget_ms: u32,
    pub walker_threads: u16,
    pub watch_debounce_ms: u32,
    pub frecency_enabled: bool,
    pub frecency_max_multiplier: f32,
    pub home_exclude_extra: Vec<String>,
    pub home_hidden: bool,
}

impl Default for SearchConfig {
    fn default() -> Self {
        SearchConfig {
            walk_entries_ceiling: 200_000,
            walk_budget_ms: 400,
            walker_threads: 0,
            watch_debounce_ms: 100,
            frecency_enabled: true,
            frecency_max_multiplier: 4.0,
            home_exclude_extra: default_home_exclude_extra(),
            home_hidden: true,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct QuickOpenConfig {
    pub default_scope: String,
    pub toggle_scope: String,
}

impl Default for QuickOpenConfig {
    fn default() -> Self {
        QuickOpenConfig {
            default_scope: "project".to_string(),
            toggle_scope: "Tab".to_string(),
        }
    }
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
    pub highlight_color: String,
    pub highlight_frame: bool,
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
            highlight_color: "#ff453a".to_string(),
            highlight_frame: true,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct BrowserConfig {
    pub home_url: String,
    pub enabled: bool,
    /// "dark" | "light" | "auto" (follow the OS) | "theme" (follow
    /// theme.preset). Resolved to a concrete "dark"/"light" on the frontend
    /// before it reaches the backend, which only ever sets what it is told.
    pub color_scheme: String,
    pub auto_hide_chrome: bool,
    pub auto_hide_delay_ms: u32,
}

impl Default for BrowserConfig {
    fn default() -> Self {
        BrowserConfig {
            home_url: "https://www.youtube.com".to_string(),
            enabled: true,
            color_scheme: "dark".to_string(),
            auto_hide_chrome: true,
            auto_hide_delay_ms: 2000,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct DetectionConfig {
    pub idle_threshold_ms: u32,
    /// After this much unbroken silence a calm session becomes a *tentative*
    /// hint (a soft "maybe waiting" mark), distinct from and never as loud as a
    /// confirmed needs-you. Longer than `idle_threshold_ms`.
    pub tentative_threshold_ms: u32,
    pub hysteresis_samples: u8,
    pub poll_interval_ms: u32,
    /// Advertised to child CLIs via `TERM_PROGRAM`. Some emitters (Qwen
    /// confirmed) route their OSC notifications based on this value, so
    /// changing it is a lever over how much Layer 2 signal Shirei receives.
    pub term_program: String,
}

impl Default for DetectionConfig {
    fn default() -> Self {
        DetectionConfig {
            // How long after the last output a session still reads as "working"
            // (Atom moving). Long enough to bridge the short gaps within an active
            // turn (observed 1-3s), short enough that a genuinely idle agent goes
            // calm quickly instead of trailing the Atom for many seconds. Real
            // "needs you" is caught instantly by the prompt classifier, not here.
            idle_threshold_ms: 5000,
            // ~45s of silence with no prompt on screen: long enough that a busy
            // agent bridging tool calls never trips it, short enough to surface a
            // plausibly-stuck session as a soft hint the eye can find.
            tentative_threshold_ms: 45000,
            hysteresis_samples: 2,
            poll_interval_ms: 250,
            term_program: "shirei".into(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct MetricsConfig {
    pub enabled: bool,
    pub retention_days: u32,
    pub flush_interval_ms: u32,
    pub activity_ping_ms: u32,
    pub idle_after_ms: u32,
    pub dormant_after_ms: u32,
}

impl Default for MetricsConfig {
    fn default() -> Self {
        MetricsConfig {
            enabled: true,
            retention_days: 0,
            flush_interval_ms: 5000,
            activity_ping_ms: 30000,
            idle_after_ms: 120000,
            dormant_after_ms: 900000,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(rename_all = "kebab-case")]
pub enum NotifyChannel {
    #[default]
    Os,
    InApp,
    Off,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct NotificationChannels {
    pub waiting: NotifyChannel,
    pub done: NotifyChannel,
    pub errored: NotifyChannel,
}

impl Default for NotificationChannels {
    fn default() -> Self {
        NotificationChannels {
            // The only default interruption is a session blocked on the user's
            // input to advance (a waiting session, gated to high confidence in the
            // notification layer). Finishing and erroring are opt-in — a user who
            // wants a done/failed ping turns it on in Settings.
            waiting: NotifyChannel::Os,
            done: NotifyChannel::Off,
            errored: NotifyChannel::Off,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum SoundTimbre {
    #[default]
    Soft,
    Deep,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct SoundConfig {
    pub enabled: bool,
    pub waiting_timbre: SoundTimbre,
    pub error_timbre: SoundTimbre,
}

impl Default for SoundConfig {
    fn default() -> Self {
        SoundConfig {
            enabled: true,
            waiting_timbre: SoundTimbre::Soft,
            error_timbre: SoundTimbre::Deep,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct QuietHours {
    pub enabled: bool,
    pub start: String,
    pub end: String,
}

impl Default for QuietHours {
    fn default() -> Self {
        QuietHours {
            enabled: false,
            start: "22:00".into(),
            end: "08:00".into(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(rename_all = "kebab-case")]
pub enum PayloadVerbosity {
    #[default]
    Full,
    Redacted,
    IdentityOnly,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct IdentityConfig {
    pub append_cli: bool,
    pub append_branch: bool,
}

impl Default for IdentityConfig {
    fn default() -> Self {
        IdentityConfig {
            append_cli: true,
            append_branch: true,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default)]
pub struct NotificationsConfig {
    pub channels: NotificationChannels,
    pub sound: SoundConfig,
    pub coalescing_ms: u32,
    pub quiet_hours: QuietHours,
    pub payload_verbosity: PayloadVerbosity,
    pub identity: IdentityConfig,
    pub truncation_length: u16,
}

impl Default for NotificationsConfig {
    fn default() -> Self {
        NotificationsConfig {
            channels: NotificationChannels::default(),
            sound: SoundConfig::default(),
            coalescing_ms: 3000,
            quiet_hours: QuietHours::default(),
            payload_verbosity: PayloadVerbosity::Full,
            identity: IdentityConfig::default(),
            truncation_length: 140,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(default)]
pub struct CliRegistryEntry {
    pub id: String,
    pub label: String,
    /// Substring matched against the pty's foreground process name (Layer 0).
    pub process_match: String,
    /// Seeds Layer 2 (which OSC an emitter uses) for entries with a known
    /// shape; unset entries fall back to the fully generic layers.
    pub profile: Option<String>,
    pub enabled: bool,
    /// Whether state detection is verified for this CLI. Only ready entries can
    /// be enabled from the UI; the rest render as "Soon" and stay locked off, so
    /// Shirei never claims to track a CLI whose behavior it hasn't validated.
    pub ready: bool,
    /// True for entries the user added; only those can be removed from the
    /// registry, the shipped catalog is toggle-only.
    pub custom: bool,
}

fn cli_entry(
    id: &str,
    label: &str,
    process_match: &str,
    profile: Option<&str>,
    ready: bool,
) -> CliRegistryEntry {
    CliRegistryEntry {
        id: id.into(),
        label: label.into(),
        process_match: process_match.into(),
        profile: profile.map(Into::into),
        // Only a ready CLI ships enabled; unverified ones are off until validated.
        enabled: ready,
        ready,
        custom: false,
    }
}

fn default_cli_registry() -> Vec<CliRegistryEntry> {
    // Only Claude Code has had its state detection validated end to end, so it is
    // the only CLI tracked by default. The rest are declared so the catalog shows
    // what is coming, but stay off and locked ("Soon") until each is verified.
    vec![
        cli_entry("claude-code", "Claude Code", "claude", None, true),
        cli_entry("codex", "Codex", "codex", Some("codex"), false),
        cli_entry("opencode", "OpenCode", "opencode", None, false),
        cli_entry("gemini", "Gemini CLI", "gemini", Some("gemini"), false),
        cli_entry("aider", "Aider", "aider", None, false),
        cli_entry("goose", "Goose", "goose", None, false),
        cli_entry("qwen", "Qwen", "qwen", Some("qwen"), false),
        cli_entry("crush", "Crush", "crush", Some("crush"), false),
        cli_entry("cursor", "Cursor", "cursor-agent", None, false),
        cli_entry("amp", "Amp", "amp", None, false),
        cli_entry("continue", "Continue", "continue", None, false),
        cli_entry("amazon-q", "Amazon Q", "q", None, false),
    ]
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

fn tpl_file() -> serde_json::Value {
    serde_json::json!({ "kind": "leaf", "id": "", "file": true })
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
        serde_json::json!({
            "name": "Shirei Template",
            "tree": tpl_split("h", 0.34, tpl_leaf(Some("claude")),
                tpl_split("h", 0.5,
                    tpl_split("v", 0.8, tpl_file(), tpl_leaf(None)),
                    tpl_leaf(Some("yagura")))),
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
pub struct UpdatesConfig {
    pub auto_check: bool,
    // Version last announced through the one-time toast; empty until the first
    // update is found, so the toast never fires twice for the same release.
    pub last_seen: String,
}

impl Default for UpdatesConfig {
    fn default() -> Self {
        Self {
            auto_check: true,
            last_seen: String::new(),
        }
    }
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
    #[serde(default)]
    pub updates: UpdatesConfig,
    pub performance: PerformanceConfig,
    pub files: FilesConfig,
    pub quickopen: QuickOpenConfig,
    #[serde(default)]
    pub search: SearchConfig,
    pub recorder: RecorderConfig,
    #[serde(default)]
    pub browser: BrowserConfig,
    #[serde(default)]
    pub detection: DetectionConfig,
    #[serde(default)]
    pub metrics: MetricsConfig,
    #[serde(default)]
    pub notifications: NotificationsConfig,
    #[serde(default = "default_cli_registry")]
    pub cli_registry: Vec<CliRegistryEntry>,
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
            updates: UpdatesConfig::default(),
            performance: PerformanceConfig::default(),
            files: FilesConfig::default(),
            quickopen: QuickOpenConfig::default(),
            search: SearchConfig::default(),
            recorder: RecorderConfig::default(),
            browser: BrowserConfig::default(),
            detection: DetectionConfig::default(),
            metrics: MetricsConfig::default(),
            notifications: NotificationsConfig::default(),
            cli_registry: default_cli_registry(),
            projects: Vec::new(),
            templates: default_templates(),
            user_templates: Vec::new(),
            keybindings: BTreeMap::new(),
        }
    }
}

impl Config {
    pub fn from_json_or_default(text: &str) -> Config {
        let mut cfg: Config = serde_json::from_str(text).unwrap_or_default();
        cfg.reconcile_cli_registry();
        cfg
    }

    /// The shipped CLI catalog is code-owned: its label, process match, profile,
    /// readiness, and order always come from `default_cli_registry`, never from a
    /// persisted config. Only the user's `enabled` choice is carried over (and a
    /// CLI can never be enabled before it's ready). Custom entries the user added
    /// are preserved. Without this, a config saved before the `ready` field
    /// existed would deserialize every entry as not-ready and hide Claude behind
    /// "Soon".
    fn reconcile_cli_registry(&mut self) {
        let persisted_enabled: HashMap<String, bool> = self
            .cli_registry
            .iter()
            .filter(|e| !e.custom)
            .map(|e| (e.id.clone(), e.enabled))
            .collect();
        let customs: Vec<CliRegistryEntry> = self
            .cli_registry
            .iter()
            .filter(|e| e.custom)
            .cloned()
            .map(|e| CliRegistryEntry { ready: true, ..e })
            .collect();
        let mut merged: Vec<CliRegistryEntry> = default_cli_registry()
            .into_iter()
            .map(|mut d| {
                if let Some(&enabled) = persisted_enabled.get(&d.id) {
                    d.enabled = enabled;
                }
                d.enabled = d.enabled && d.ready;
                d
            })
            .collect();
        merged.extend(customs);
        self.cli_registry = merged;
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
        let c = Config::from_json_or_default(r#"{"limits":{"max_file_bytes":1000}}"#);
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
    }

    #[test]
    fn detection_defaults_are_sane() {
        let d = Config::default().detection;
        assert_eq!(d.idle_threshold_ms, 5000);
        assert_eq!(d.tentative_threshold_ms, 45000);
        assert!(d.tentative_threshold_ms > d.idle_threshold_ms);
        assert_eq!(d.hysteresis_samples, 2);
        assert_eq!(d.poll_interval_ms, 250);
        assert_eq!(d.term_program, "shirei");
    }

    #[test]
    fn notifications_defaults_are_sane() {
        let n = Config::default().notifications;
        assert_eq!(n.channels.waiting, NotifyChannel::Os);
        assert_eq!(n.channels.done, NotifyChannel::Off);
        assert_eq!(n.channels.errored, NotifyChannel::Off);
        assert!(n.sound.enabled);
        assert_eq!(n.sound.waiting_timbre, SoundTimbre::Soft);
        assert_eq!(n.sound.error_timbre, SoundTimbre::Deep);
        assert_eq!(n.coalescing_ms, 3000);
        assert!(!n.quiet_hours.enabled);
        assert_eq!(n.payload_verbosity, PayloadVerbosity::Full);
        assert!(n.identity.append_cli);
        assert!(n.identity.append_branch);
        assert_eq!(n.truncation_length, 140);
    }

    #[test]
    fn notify_channel_serializes_kebab_case() {
        assert_eq!(
            serde_json::to_string(&NotifyChannel::InApp).unwrap(),
            "\"in-app\""
        );
        assert_eq!(
            serde_json::to_string(&PayloadVerbosity::IdentityOnly).unwrap(),
            "\"identity-only\""
        );
    }

    #[test]
    fn cli_registry_defaults_enable_only_validated_claude() {
        let reg = Config::default().cli_registry;
        let enabled: Vec<&str> = reg
            .iter()
            .filter(|e| e.enabled)
            .map(|e| e.id.as_str())
            .collect();
        assert_eq!(enabled, ["claude-code"]);
        // Only the validated CLI is ready; enabled never outruns ready.
        assert!(reg.iter().all(|e| e.enabled == (e.enabled && e.ready)));
        assert!(
            reg.iter()
                .filter(|e| e.ready)
                .all(|e| e.id == "claude-code")
        );
        // The others still ship in the catalog, off and not custom, as "Soon".
        assert!(
            reg.iter()
                .any(|e| e.id == "codex" && !e.enabled && !e.ready)
        );
        assert!(reg.iter().all(|e| !e.custom));
    }

    #[test]
    fn stale_registry_without_ready_reconciles_to_the_code_catalog() {
        // A config saved before `ready` existed: every entry enabled, no readiness.
        let stale = r#"{"cli_registry":[
            {"id":"claude-code","label":"Claude Code","process_match":"claude","enabled":true,"custom":false},
            {"id":"codex","label":"Codex","process_match":"codex","enabled":true,"custom":false},
            {"id":"mine","label":"Mine","process_match":"mycli","enabled":true,"custom":true}
        ]}"#;
        let reg = Config::from_json_or_default(stale).cli_registry;
        let claude = reg.iter().find(|e| e.id == "claude-code").unwrap();
        assert!(claude.ready && claude.enabled);
        let codex = reg.iter().find(|e| e.id == "codex").unwrap();
        assert!(!codex.ready && !codex.enabled);
        let custom = reg.iter().find(|e| e.id == "mine").unwrap();
        assert!(custom.custom && custom.ready && custom.enabled);
    }

    #[test]
    fn partial_json_fills_detection_and_notifications_defaults() {
        let c = Config::from_json_or_default(r#"{"detection":{"idle_threshold_ms":900}}"#);
        assert_eq!(c.detection.idle_threshold_ms, 900);
        assert_eq!(c.detection.poll_interval_ms, 250);
        let c = Config::from_json_or_default(r#"{"notifications":{"coalescing_ms":5000}}"#);
        assert_eq!(c.notifications.coalescing_ms, 5000);
        assert_eq!(c.notifications.truncation_length, 140);
    }

    #[test]
    fn metrics_defaults_are_sane() {
        let m = MetricsConfig::default();
        assert!(m.enabled);
        assert_eq!(m.retention_days, 0);
        assert_eq!(m.flush_interval_ms, 5000);
        assert_eq!(m.activity_ping_ms, 30000);
        assert_eq!(m.idle_after_ms, 120000);
        assert_eq!(m.dormant_after_ms, 900000);
        // idle must trip before a tab is considered dormant
        assert!(m.idle_after_ms < m.dormant_after_ms);
        assert_eq!(Config::default().metrics, m);
    }

    #[test]
    fn browser_defaults_are_sane() {
        let b = Config::default().browser;
        assert_eq!(b.home_url, "https://www.youtube.com");
        assert!(b.enabled);
        assert_eq!(b.color_scheme, "dark");
        assert!(b.auto_hide_chrome);
        assert_eq!(b.auto_hide_delay_ms, 2000);
    }

    #[test]
    fn default_seeds_layout_templates() {
        let names: Vec<String> = Config::default()
            .templates
            .iter()
            .filter_map(|t| t["name"].as_str().map(str::to_string))
            .collect();
        assert_eq!(
            names,
            [
                "s1",
                "s2",
                "s4",
                "w1",
                "w2",
                "w4",
                "Yagura",
                "Shirei Template"
            ]
        );
    }

    #[test]
    fn partial_json_seeds_templates() {
        let c = Config::from_json_or_default(r#"{"font":{"size":20}}"#);
        assert_eq!(c.templates.len(), 8);
    }

    #[test]
    fn config_serializes_templates_for_frontend() {
        let json = serde_json::to_value(Config::default()).unwrap();
        let templates = json["templates"]
            .as_array()
            .expect("templates missing from serialized config");
        assert_eq!(templates.len(), 8);
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

    #[test]
    fn search_config_defaults() {
        let s = SearchConfig::default();
        assert_eq!(s.walk_entries_ceiling, 200_000);
        assert_eq!(s.walk_budget_ms, 400);
        assert_eq!(s.walker_threads, 0);
        assert_eq!(s.watch_debounce_ms, 100);
        assert!(s.frecency_enabled);
        assert_eq!(s.frecency_max_multiplier, 4.0);
        assert!(s.home_hidden);
        assert_eq!(
            s.home_exclude_extra,
            vec![".cache", ".local/share", ".Trash"]
        );
    }
}
