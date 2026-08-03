import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Locale } from "./i18n";
import type { Keystroke } from "./keys";
import type { PaneNode } from "./panetree";

export type FontKind = "builtin" | "download";

export interface FontCatalogEntry {
  id: string;
  label: string;
  kind: FontKind;
  asset?: string;
  glyph_pattern?: string;
  sha256?: string;
}

export interface FontsConfig {
  release_tag: string;
  catalog: FontCatalogEntry[];
}

export type CursorStyle = "block" | "bar" | "underline";
export type CursorInactiveStyle =
  | "none"
  | "outline"
  | "block"
  | "bar"
  | "underline";
export type FontSmoothing = "antialiased" | "subpixel";

export interface RenderConfig {
  webgl: boolean;
  kitty_keyboard: boolean;
  shift_enter_newline: boolean;
  line_height: number;
  letter_spacing: number;
  min_contrast: number;
  scrollback: number;
  cursor_style: CursorStyle;
  cursor_inactive_style: CursorInactiveStyle;
  cursor_blink: boolean;
  font_smoothing: FontSmoothing;
  padding: number;
  diagnostics: boolean;
  webgl_pool_cap: number;
  scrollbar: boolean;
}

export type LogLevel = "off" | "error" | "warn" | "info" | "debug" | "trace";

export interface LoggingConfig {
  level: LogLevel;
  max_file_mb: number;
  keep_files: number;
  capture_session: boolean;
}

export type ConfirmPolicy = "running-only" | "always" | "never";
export type RestoreCommands = "all" | "templates" | "never";

export interface StatusColors {
  reconnecting: string;
  exited: string;
}

export interface SessionConfig {
  keep_alive: boolean;
  confirm_kill: ConfirmPolicy;
  confirm_close: ConfirmPolicy;
  safe_processes: string[];
  autostart_daemon: boolean;
  launch_agent: boolean;
  orphan_ttl_secs: number;
  status_colors: StatusColors;
  restore_commands: RestoreCommands;
  snapshot_interval_secs: number;
}

export interface TerminalColors {
  bg: string;
  fg: string;
  cursor: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface TabsConfig {
  show_age: boolean;
  age_refresh_secs: number;
  activity_throttle_secs: number;
}

export interface ChromeConfig {
  dim_inactive: boolean;
  pane_accent: boolean;
  tab_accent_line: boolean;
  active_tab_highlight: boolean;
  context_hints: boolean;
}

export interface PerformanceConfig {
  enabled: boolean;
  refresh_secs: number;
  sparklines: boolean;
  metrics: {
    cpu_tab: boolean;
    mem_tab: boolean;
    disk_tab: boolean;
    net_tab: boolean;
    cpu_app: boolean;
    mem_app: boolean;
    disk_app: boolean;
    net_app: boolean;
  };
  thresholds: { warn: number; crit: number };
}

export interface LayoutTemplate {
  name: string;
  tree: PaneNode;
}
export interface Project {
  id: string;
  name: string;
  path: string;
  color: string;
  tree: PaneNode;
}

export interface MotionConfig {
  enabled: boolean;
  task_sink_ms: number;
  modal_in_ms: number;
  modal_out_ms: number;
  reveal_ms: number;
  reveal_stagger_ms: number;
  divider_snap_ms: number;
  fast_ms: number;
  base_ms: number;
  slow_ms: number;
  respect_reduced_motion: boolean;
}

export type RecordFormat = "mp4" | "gif";
export type FinishAction = "ask" | "copy" | "reveal" | "share" | "none";

export interface RecorderConfig {
  dir: string;
  format: RecordFormat;
  fps: number;
  gif_fps: number;
  gif_max_width: number;
  show_cursor: boolean;
  countdown_secs: number;
  max_duration_secs: number;
  on_finish: FinishAction;
  filename_template: string;
  highlight_color: string;
  highlight_frame: boolean;
}

export type BrowserColorSchemeMode = "dark" | "light" | "auto" | "theme";

export interface BrowserConfig {
  home_url: string;
  enabled: boolean;
  color_scheme: BrowserColorSchemeMode;
  auto_hide_chrome: boolean;
  auto_hide_delay_ms: number;
}

export interface DetectionConfig {
  idle_threshold_ms: number;
  tentative_threshold_ms: number;
  hysteresis_samples: number;
  poll_interval_ms: number;
  term_program: string;
}

export interface MetricsConfig {
  enabled: boolean;
  retention_days: number;
  flush_interval_ms: number;
  activity_ping_ms: number;
  idle_after_ms: number;
  dormant_after_ms: number;
}

export type NotifyChannel = "os" | "in-app" | "off";

export interface NotificationChannels {
  waiting: NotifyChannel;
  done: NotifyChannel;
  errored: NotifyChannel;
}

export type SoundTimbre = "soft" | "deep";

export interface SoundConfig {
  enabled: boolean;
  waiting_timbre: SoundTimbre;
  error_timbre: SoundTimbre;
}

export interface QuietHours {
  enabled: boolean;
  start: string;
  end: string;
}

export type PayloadVerbosity = "full" | "redacted" | "identity-only";

export interface IdentityConfig {
  append_cli: boolean;
  append_branch: boolean;
}

export interface NotificationsConfig {
  channels: NotificationChannels;
  sound: SoundConfig;
  coalescing_ms: number;
  quiet_hours: QuietHours;
  payload_verbosity: PayloadVerbosity;
  identity: IdentityConfig;
  truncation_length: number;
}

export interface SearchConfig {
  walk_entries_ceiling: number;
  walk_budget_ms: number;
  walker_threads: number;
  watch_debounce_ms: number;
  frecency_enabled: boolean;
  frecency_max_multiplier: number;
  home_exclude_extra: string[];
  home_hidden: boolean;
}

export interface FocusPreset {
  id: string;
  label: string;
  focus_min: number;
  break_min: number;
  long_break_min: number;
  cycles_before_long: number;
  auto_advance: boolean;
}

export interface FocusConfig {
  presets: FocusPreset[];
  default_preset: string;
  theme: string;
  role_overrides: Record<string, string>;
  // Shape strategy for the timer viz: ring | liquid | coffee | hourglass | bar.
  timer_shape: string;
  // Scoped to timer_shape === "ring"; other shapes ignore it.
  ring_style: string;
  ring_width: number;
  glow_intensity: number;
  motion: string;
  numeric_emphasis: string;
  overflow_enabled: boolean;
  overflow_cap_min: number;
  start_on_open: boolean;
  pause_on_idle: boolean;
  session_note: boolean;
  alert_channel: NotifyChannel;
  alert_sound: boolean;
  alert_timbre: SoundTimbre;
  ring_min_px: number;
  ring_max_px: number;
  quick_focus_steps: number[];
  focus_step_min: number;
  focus_min_floor: number;
  focus_min_ceil: number;
}

export interface CliRegistryEntry {
  id: string;
  label: string;
  process_match: string;
  profile?: string;
  enabled: boolean;
  ready: boolean;
  custom: boolean;
}

export interface Config {
  locale: Locale;
  font: { family: string; size: number };
  fonts: FontsConfig;
  render: RenderConfig;
  session: SessionConfig;
  editor: {
    vim: boolean;
    autosave: boolean;
    autosave_delay_ms: number;
    live_preview: boolean;
    line_numbers: boolean;
    active_line: boolean;
    bracket_matching: boolean;
    indent_guides: boolean;
    folding: boolean;
    close_brackets: boolean;
    highlight_matches: boolean;
    search_case: boolean;
    search_regex: boolean;
    search_whole_word: boolean;
    prose_width: string;
    wrap_prose: boolean;
    code_width: string;
    wrap_code: boolean;
  };
  git: {
    blame: { enabled: boolean; delay_ms: number };
    history: { default_view: "diff" | "working" | "full" };
  };
  logging: LoggingConfig;
  theme: {
    preset: "dark" | "light";
    terminal: TerminalColors;
    editor: { syntax: "one-dark"; bg: string };
    tabs: string[];
  };
  limits: {
    max_file_bytes: number;
    max_image_bytes: number;
    quickopen_results: number;
    dir_entries_cap: number;
    font_size_min: number;
    font_size_max: number;
  };
  files: { exclude_dirs: string[]; respect_gitignore: boolean };
  quickopen: {
    default_scope: "project" | "home";
    toggle_scope: string;
  };
  search: SearchConfig;
  layout: {
    sidebar_width: number;
    sidebar_min_width: number;
    sidebar_max_fraction: number;
    todo_min_rows: number;
    todo_region_ratio: number;
    todo_collapsed: boolean;
    default_template: string;
    new_tab_dir: string;
    pane_content_cap: number;
    pin_width_fraction: number;
    pin_min_fraction: number;
    pin_max_fraction: number;
    pin_split_fraction: number;
  };
  motion: MotionConfig;
  tabs: TabsConfig;
  chrome: ChromeConfig;
  updates: { auto_check: boolean; last_seen: string };
  performance: PerformanceConfig;
  recorder: RecorderConfig;
  browser: BrowserConfig;
  focus: FocusConfig;
  detection: DetectionConfig;
  metrics: MetricsConfig;
  notifications: NotificationsConfig;
  cli_registry: CliRegistryEntry[];
  projects: Project[];
  templates: LayoutTemplate[];
  user_templates: LayoutTemplate[];
  keybindings: Record<string, Keystroke[] | null>;
}

export const allTemplates = (config: Config): LayoutTemplate[] => [
  ...(config.templates ?? []),
  ...(config.user_templates ?? []),
];

// Mirror of FontConfig::default().size in src-tauri/src/config.rs; keep in sync.
export const DEFAULT_FONT_SIZE = 13;
export const configGet = () => invoke<Config>("config_get");
export const binaryOnPath = (name: string) =>
  invoke<boolean>("binary_on_path", { name });
export const configSet = (config: Config) =>
  invoke<void>("config_set", { config });
export const onConfigChanged = (cb: (c: Config) => void) =>
  listen<Config>("config-changed", (e) => cb(e.payload));

export const openConfigFile = () => invoke<void>("open_config_file");
export const pickProjectDir = () => invoke<string | null>("pick_project_dir");
export const pathIsGitRepo = (path: string) =>
  invoke<boolean>("path_is_git_repo", { path });
