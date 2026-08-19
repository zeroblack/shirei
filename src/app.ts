import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { BrowserSession } from "./browser";
import { resolveColorScheme, shouldShowBrowser } from "./browser-core";
import { isClaudeCommand, withClaudeResume } from "./claude-cmd";
import { alpha, deriveGitColors, deriveStatusColors, mix } from "./colors";
import {
  browserBack,
  browserForward,
  browserReleaseFocus,
  browserReload,
  metricsLog,
  notifyFire,
  ptyCwd,
  ptySnapshot,
  recordOpen,
  revealInFinder,
  revealLogs,
  treeWatch,
} from "./commands";
import {
  allTemplates,
  binaryOnPath,
  type Config,
  type ConfirmPolicy,
  configSet,
  DEFAULT_FONT_SIZE,
  gitStatuses,
  type MemoryProjectDoc,
  type MemoryStatus,
  memoryInit,
  memoryProjectActivate,
  memoryProjectPreview,
  memoryStatus,
  memoryWriteDefaults,
  type Project,
  type TerminalColors,
} from "./config";
import { choiceDialog, confirmDialog, messageDialog } from "./confirm";
import { attachDrag } from "./drag";
import type { EditorSession as EditorSessionType } from "./editor";
import { errorMessage } from "./errors";
import { FileTree } from "./filetree";
import { FocusCell, type FocusCellShortcuts } from "./focus/cell";
import type { Phase } from "./focus/machine";
import { fontStack, isFontLoaded, registerFont } from "./fonts";
import { GitHistory } from "./githistory";
import { gitRefreshDecision } from "./gitstatus";
import { setLocale, t } from "./i18n";
import { isImage, mediaKind, PANEL_RIGHT, SEARCH, SIDEBAR } from "./icons";
import { ImageSession } from "./image";
import { Keymap } from "./keymap";
import { eventToKeystroke, formatKeystroke, resolveBindings } from "./keys";
import { MediaSession } from "./media";
import {
  memoryBadgeState,
  promptLine,
  resolveTemplate,
  shouldAutosave,
  shouldBootstrapMemory,
} from "./memory-actions";
import {
  type DormancyInput,
  type DormancyState,
  dormancyTransition,
  MetricsLogger,
  makeEvent,
} from "./metrics";
import { applyMotionVars } from "./motion";
import {
  isTrackedAgent,
  NotificationCenter,
  playTimbre,
  resolveCliId,
  withinQuietHours,
} from "./notifications";
import {
  type BoardHints,
  type BoardRow,
  OrchestrationBoard,
} from "./orchestration";
import { createOverlay, overlaysOpen, setOverlayObserver } from "./overlay";
import {
  type PaneContentKind,
  type PaneContentSession,
  pickFileTarget,
} from "./panecontent";
import { PaneFileChooser } from "./panefilechooser";
import { type FocusDir, type LeafSpawn, PaneGrid } from "./panegrid";
import {
  declaredCommands,
  instantiate,
  leaves,
  type PaneNode,
  readLeafContents,
  resolveDefaultTemplate,
} from "./panetree";
import { basename, parentDir } from "./path";
import { promptText } from "./prompt";
import { QuickOpen } from "./quickopen";
import type { Screencast } from "./screencast";
import type { CssRect } from "./screencast-core";
import { resolveSearchRoot, type ScopeRoots } from "./searchscope";
import {
  type Confidence,
  cycleWaitingId,
  getSessionState,
  initSessionState,
  needsAttentionId,
  needsYou,
  onSessionStateChange,
  pickPrimaryState,
  type SessionState,
  type SessionStateEntry,
  sameKind,
} from "./sessionstate";
import { StatusBar } from "./statusbar";
import {
  clearSession,
  loadPinDock,
  loadSession,
  type SavedTab,
  savePinDock,
  saveSession,
} from "./store";
import { TabBar } from "./tabbar";
import { TerminalSession } from "./terminal";
import { showToast } from "./toast";
import { openTodoModal } from "./todomodal";
import {
  decideTodoFocusAction,
  type TodoFocusDecision,
  TodoPanel,
} from "./todopanel";
import type { Todo } from "./todos";
import type { EditorTab, TabState } from "./types";
import { UpdateIndicator } from "./updateindicator";
import { openUpdateModal, type UpdateModalHandle } from "./updatemodal";
import { UpdateController } from "./updates";
import type { UpdateState } from "./updatestate";
import { webglPool } from "./webgl-pool";

let EditorSession: typeof EditorSessionType | null = null;

async function loadEditor(): Promise<typeof EditorSessionType> {
  if (!EditorSession) {
    const mod = await import("./editor");
    EditorSession = mod.EditorSession;
  }
  return EditorSession;
}

// A filled pinned cell. Closing it (the × button) always disposes the session —
// the source pane, if any, was already collapsed when the content was pinned.
interface PinnedCell {
  session: PaneContentSession | TerminalSession | FocusCell;
  container: HTMLElement;
  kind: PaneContentKind | "timer";
  path?: string;
  title: string;
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return `t${Date.now().toString(36)}${seq}`;
}

// A mouse press on a titlebar button doesn't steal focus from the terminal
// underneath and never surfaces the platform focus ring.
function keepFocusOffClick(el: HTMLElement): void {
  el.addEventListener("mousedown", (e) => e.preventDefault());
}

// Hidden longer than this on return is treated as a GPU sleep (rebuild renderers)
// rather than a quick app switch (light repaint).
const LONG_HIDDEN_MS = 5000;

// A flaky daemon can drop and reconnect in quick succession; collapsing
// "connection-lost" events within this window keeps one bad stretch from
// resetting every pane's terminal in a loop.
const MUX_RECONNECT_DEBOUNCE_MS = 1000;

// Pane keystrokes that operate on the terminal and must defer to a focused file
// editor when one is layered over it, so copy/paste/scroll work in the editor.
const TERMINAL_CONTENT_ACTIONS = new Set([
  "terminal.copy-line",
  "terminal.paste",
  "scroll.up",
  "scroll.down",
]);

// The inverse of TERMINAL_CONTENT_ACTIONS: these belong to a browser pane
// content and must fire only when one is frontmost, otherwise fall through
// unhandled (no preventDefault) so the terminal/editor underneath gets the
// keystroke. Also dead while the native page itself holds focus — there is
// no DOM event to intercept in that case.
const BROWSER_CONTENT_ACTIONS = new Set([
  "browser.focus-url",
  "browser.back",
  "browser.forward",
  "browser.reload",
]);

// Row height of the TODO panel, used to convert `todo_min_rows` to pixels when
// clamping the divider position. Matches the CSS row height; not user-configurable.
const TODO_ROW_HEIGHT_PX = 24;

const CHROME: Record<"dark" | "light", Record<string, string>> = {
  dark: {
    "--bg": "#000000",
    "--bg-bar": "#0c0d0f",
    "--fg": "#f4f5f7",
    "--fg-dim": "#6e727b",
    "--border": "#26282e",
    "--surface-0": "#0c0d0f",
    "--surface-1": "#121316",
    "--surface-2": "#17191d",
    "--surface-3": "#1d1f24",
    "--border-soft": "rgba(255, 255, 255, 0.06)",
    "--border-strong": "rgba(255, 255, 255, 0.12)",
    "--text": "#f4f5f7",
    "--text-muted": "#a0a4ad",
    "--text-subtle": "#6e727b",
    "--accent": "#5e8bff",
    "--accent-soft": "rgba(94, 139, 255, 0.5)",
    "--success": "#3fb950",
    "--warning": "#d29922",
    "--danger": "#3f1414",
    "--danger-hover": "#5b1a1a",
    "--danger-border": "#7f1d1d",
    "--danger-fg": "#fca5a5",
    "--perf-ok": "#5fcf8a",
    "--perf-warn": "#d9a441",
    "--perf-crit": "#e5534b",
    "--perf-mem": "#5fa8e0",
    "--todo-overdue": "#c2603f",
    "--todo-due-today": "#ffffff",
    "--todo-done": "#525252",
    "--todo-prio-high": "#ffffff",
    "--todo-prio-mid": "#8a8a8a",
  },
  light: {
    "--bg": "#ffffff",
    "--bg-bar": "#f3f4f6",
    "--fg": "#16181d",
    "--fg-dim": "#8a8f98",
    "--border": "#dcdfe4",
    "--surface-0": "#f3f4f6",
    "--surface-1": "#fafbfc",
    "--surface-2": "#ffffff",
    "--surface-3": "#ffffff",
    "--border-soft": "rgba(0, 0, 0, 0.06)",
    "--border-strong": "rgba(0, 0, 0, 0.12)",
    "--text": "#16181d",
    "--text-muted": "#5c616b",
    "--text-subtle": "#8a8f98",
    "--accent": "#3b6fe0",
    "--accent-soft": "rgba(59, 111, 224, 0.45)",
    "--success": "#2e9e5b",
    "--warning": "#b8860b",
    "--danger": "#fee2e2",
    "--danger-hover": "#fecaca",
    "--danger-border": "#fca5a5",
    "--danger-fg": "#b91c1c",
    "--perf-ok": "#2e9e5b",
    "--perf-warn": "#b8860b",
    "--perf-crit": "#c0392b",
    "--perf-mem": "#2b7fd0",
    "--todo-overdue": "#9a3d1f",
    "--todo-due-today": "#1a1a1a",
    "--todo-done": "#a3a3a3",
    "--todo-prio-high": "#1a1a1a",
    "--todo-prio-mid": "#6f6f6f",
  },
};

// Derives the app-chrome variables from the active terminal palette so the
// whole window wears the theme, not just the terminal. Surfaces and text are
// blended relative to bg/fg, which works for both dark and light palettes;
// semantic colors (success/danger/perf) stay from the preset base.
function chromeFromTheme(c: TerminalColors): Record<string, string> {
  const { bg, fg } = c;
  // Chrome text sits 4% toward bg: full-strength fg belongs to the terminal
  // alone, and the offset keeps the surrounding chrome from compounding its
  // halation on pure-black themes.
  const text = mix(fg, bg, 0.04);
  return {
    "--bg": bg,
    "--bg-bar": mix(bg, fg, 0.05),
    "--surface-0": mix(bg, fg, 0.03),
    "--surface-1": mix(bg, fg, 0.06),
    "--surface-2": mix(bg, fg, 0.1),
    "--surface-3": mix(bg, fg, 0.14),
    "--fg": text,
    "--text": text,
    "--fg-dim": mix(fg, bg, 0.5),
    "--text-muted": mix(fg, bg, 0.32),
    "--text-subtle": mix(fg, bg, 0.52),
    "--border": mix(bg, fg, 0.16),
    "--border-soft": alpha(fg, 0.06),
    "--border-strong": alpha(fg, 0.14),
    "--accent": c.blue,
    "--accent-soft": alpha(c.blue, 0.5),
  };
}

function applyChrome(
  preset: "dark" | "light",
  terminal?: TerminalColors,
): void {
  const vars = {
    ...CHROME[preset],
    ...(terminal ? chromeFromTheme(terminal) : {}),
  };
  for (const [k, v] of Object.entries(vars))
    document.documentElement.style.setProperty(k, v);
  for (const [k, v] of Object.entries(deriveStatusColors(vars["--bg"])))
    document.documentElement.style.setProperty(k, v);
  for (const [k, v] of Object.entries(deriveGitColors(vars["--surface-1"])))
    document.documentElement.style.setProperty(k, v);
  document.documentElement.style.colorScheme = preset;
  // WebKit's native PDF viewer lives in a cross-origin iframe (asset://),
  // out of reach of CSS color-scheme; it follows the window appearance.
  void getCurrentWindow()
    .setTheme(preset)
    .catch(() => {});
}

function applyRenderCss(render: Config["render"]): void {
  const root = document.documentElement;
  root.style.setProperty("--term-padding", `${render.padding}px`);
  root.dataset.termSmoothing = render.font_smoothing;
  root.classList.toggle("no-term-scrollbar", !render.scrollbar);
}

function applyRecColor(color: string): void {
  const root = document.documentElement.style;
  root.setProperty("--rec", color);
  root.setProperty("--rec-soft", alpha(color, 0.55));
  root.setProperty("--rec-dim", alpha(color, 0.16));
}

export class App {
  private tabs: TabState[] = [];
  private readonly sessions = new Map<
    string,
    PaneGrid | EditorSessionType | ImageSession | MediaSession
  >();
  private activeId: string | null = null;
  private readonly acknowledgedState = new Map<string, SessionState>();
  private readonly tabbar: TabBar;
  private readonly statusbar: StatusBar;
  private readonly host: HTMLElement;
  private fontSize: number;
  private config: Config;
  private keymap: Keymap;
  private projects: Project[];
  private readonly tree: FileTree;
  private searchKbd: HTMLElement | null = null;
  private sidebarBtn: HTMLElement | null = null;
  private dockBtn: HTMLElement | null = null;
  private dockKbd: HTMLElement | null = null;
  private readonly mainEl: HTMLElement;
  private readonly panelEl: HTMLElement;
  private readonly dividerEl: HTMLElement;
  private readonly treeRegionEl: HTMLElement;
  private readonly todoPanelEl: HTMLElement;
  private readonly todoPanel: TodoPanel;
  private readonly todoDividerEl: HTMLElement;
  private readonly pinSlotEl: HTMLElement;
  private readonly pinDividerEl: HTMLElement;
  private readonly pinSplitDividerEl: HTMLElement;
  private readonly pinCellEls: HTMLElement[];
  private readonly pinCells: (PinnedCell | null)[] = [null, null];
  // Which pinned cell holds keyboard focus, or null when focus is in the main
  // grid/tree. Drives dock navigation and lets the close key unpin the cell.
  private focusedPin: number | null = null;
  // Guards against the tab-restore persist storm wiping the saved dock before
  // restorePinDock has read it back.
  private pinDockRestored = false;
  // True only while init() is recreating tabs from the saved session. Each
  // openTerminalTab/openFile would otherwise persist mid-restore, marking the
  // last-created tab active and clobbering which tab the user actually left
  // focused. Persist is suppressed until the restore settles on the real one.
  private restoring = false;
  private todoFocused = false;
  private todoCollapsed = false;
  private todoProjectId: string | null = null;
  private panelVisible = false;
  private lastRoot: string | null = null;
  private treeRoot: string | null = null;
  private watchedRoot: string | null = null;
  private gitStatusInFlight = false;
  private gitStatusPending = false;
  private gitStatusTimer: number | null = null;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private ageTimer: ReturnType<typeof setInterval> | null = null;
  private lastSessionJson: string | null = null;
  private lastMuxReconnectAt = 0;
  private fitQueued = false;
  private hiddenAt: number | null = null;
  // Tab mutations interleave awaits (IPC, dialogs) with edits to this.tabs and
  // this.activeId; serializing them removes that whole class of races.
  private tabOps: Promise<void> = Promise.resolve();
  // Availability of commands declared by layout templates, keyed by binary name.
  // Cleared on window focus so installing a tool mid-session takes effect.
  private readonly cmdAvailable = new Map<string, boolean>();
  private screencast?: Screencast;
  private readonly quickopen = new QuickOpen({
    onOpenFile: (path, newTab) => void this.openFile(path, { newTab }),
    onRevealDir: (path) => void this.revealDir(path),
    onOpenProject: (id) => void this.openProject(id),
    commands: () => this.paletteCommands(),
  });
  private readonly orchestration = new OrchestrationBoard({
    onActivate: (id) => this.focusSession(id),
  });
  private readonly notifications = new NotificationCenter();
  private readonly gitHistory = new GitHistory();
  private readonly updates: UpdateController;
  private readonly updateIndicator: UpdateIndicator;
  private updateModal: UpdateModalHandle | null = null;
  private appVersion = "";
  private readonly metrics: MetricsLogger;
  private readonly metricsSessionId = crypto.randomUUID();
  private readonly tabDormancy = new Map<string, DormancyState>();
  private readonly agentMetricsState = new Map<string, SessionState>();
  private readonly autosaveState = new Map<string, SessionState>();
  private readonly autosaveLastFiredAt = new Map<string, number>();
  private readonly bootstrapState = new Map<string, SessionState>();
  private readonly bootstrappedProjects = new Set<string>();
  private readonly seenProjectIds = new Set<string>();
  private activeProjectId: string | null = null;
  private metricsTimer: ReturnType<typeof setInterval> | null = null;
  private lastActivityAt = Date.now();
  private lastActivityPingAt = 0;
  private systemIdle = false;
  private disposed = false;

  constructor(tabbarEl: HTMLElement, host: HTMLElement, config: Config) {
    this.host = host;
    this.config = config;
    this.metrics = new MetricsLogger(config.metrics, metricsLog);
    this.notifications.setConfig(config.notifications, config.cli_registry);
    this.keymap = new Keymap(config.keybindings ?? {});
    this.projects = config.projects ?? [];
    this.fontSize = config.font.size;
    this.mainEl = document.querySelector<HTMLElement>("#main") as HTMLElement;
    this.panelEl = document.querySelector<HTMLElement>(
      "#sidepanel",
    ) as HTMLElement;
    this.dividerEl = document.querySelector<HTMLElement>(
      "#sidebar-divider",
    ) as HTMLElement;
    this.panelEl.tabIndex = -1;
    this.panelEl.style.width = `${config.layout.sidebar_width}px`;
    this.treeRegionEl = document.querySelector<HTMLElement>(
      "#tree-region",
    ) as HTMLElement;
    if (!this.treeRegionEl) throw new Error("missing #tree-region");
    this.todoPanelEl = document.querySelector<HTMLElement>(
      "#todopanel",
    ) as HTMLElement;
    if (!this.todoPanelEl) throw new Error("missing #todopanel");
    this.tree = new FileTree(this.treeRegionEl, {
      onOpenFile: (path, newTab) => {
        void recordOpen(path).catch(() => {});
        void this.openFile(path, { newTab });
      },
      onOpenGhost: (path, content) => void this.openGhostFile(path, content),
      onEscape: () => this.sessions.get(this.activeId ?? "")?.focus(),
    });
    this.tree.setShowDeleted(config.git.status.show_deleted);
    this.todoDividerEl = document.querySelector<HTMLElement>(
      "#todo-divider",
    ) as HTMLElement;
    this.todoPanel = new TodoPanel(this.todoPanelEl, {
      onRequestModal: () => this.openTodoCapture(),
      onRequestDetail: (todo) => this.openTodoEdit(todo),
      onToggleCollapsed: () => this.setTodoCollapsed(!this.todoCollapsed),
    });
    this.todoDividerEl.addEventListener("dblclick", () =>
      this.setTodoCollapsed(true),
    );
    this.todoPanelEl.addEventListener("focusout", (e) => {
      if (this.todoPanelEl.contains(e.relatedTarget as Node | null)) return;
      if (this.todoFocused) this.blurTodoPanel();
    });
    this.pinSlotEl = document.querySelector<HTMLElement>(
      "#pinslot",
    ) as HTMLElement;
    this.pinDividerEl = document.querySelector<HTMLElement>(
      "#pin-divider",
    ) as HTMLElement;
    this.pinSplitDividerEl = document.querySelector<HTMLElement>(
      "#pin-split-divider",
    ) as HTMLElement;
    this.pinCellEls = [
      ...this.pinSlotEl.querySelectorAll<HTMLElement>(".pin-cell"),
    ];
    // Clicking into a filled cell makes it the dock's focused cell, so the
    // arrow-key dock navigation and the close/unpin key follow the mouse.
    this.pinCellEls.forEach((host, index) => {
      host.addEventListener(
        "pointerdown",
        () => {
          if (this.pinCells[index]) this.focusPinCell(index);
        },
        true,
      );
    });
    this.mainEl.style.setProperty(
      "--pin-width",
      `${(config.layout.pin_width_fraction * 100).toFixed(2)}%`,
    );
    this.pinSlotEl.style.setProperty(
      "--pin-split",
      `${(config.layout.pin_split_fraction * 100).toFixed(2)}%`,
    );
    this.attachPinResize();
    this.attachPinSplitResize();
    this.renderPinCells();
    this.setActiveProject(null);
    setOverlayObserver(() => this.syncNativeVisibility());
    window
      .matchMedia?.("(prefers-color-scheme: dark)")
      .addEventListener("change", () => this.applyBrowserSessionsConfig());
    this.panelEl.classList.add("hidden");
    applyMotionVars(document.documentElement, config.motion);
    this.applyTodoRatio(config.layout.todo_region_ratio);
    this.attachSidebarResize();
    this.attachTodoDividerResize();
    this.tabbar = new TabBar(
      tabbarEl,
      {
        onActivate: (id) => this.activate(id),
        onClose: (id) => void this.closeTab(id),
        onRename: (id, title) => this.rename(id, title),
        onRecolor: (id, color) => this.recolor(id, color),
        onReorder: (ids) => this.reorderTabs(ids),
        onReconnect: (id) => this.reconnectActiveFor(id),
        onKill: (id) => this.killActiveFor(id),
        onPin: (id) => this.togglePin(id),
        onNew: () => void this.newTab(),
        onMemoryOpen: () => void this.openProjectMemory("overview.md"),
      },
      config.theme.tabs,
    );
    this.tabbar.setShowAge(config.tabs.show_age);
    this.statusbar = new StatusBar(
      document.querySelector("#statusbar") as HTMLElement,
    );
    this.statusbar.setConfig(config.performance);
    void this.statusbar.start();
    applyChrome(config.theme.preset, config.theme.terminal);
    applyRenderCss(config.render);
    applyRecColor(config.recorder.highlight_color);
    webglPool.setCap(config.render.webgl_pool_cap);
    window.addEventListener("resize", () => this.queueFit());
    window.addEventListener("keydown", (e) => this.onKey(e));
    // Best-effort only: a real Cmd+Q / Quit-menu terminate calls NSApplication
    // directly and skips both the window CloseRequested pipeline and this handler's
    // async work, so the visibilitychange/blur flushes below are the actual
    // mitigation, keeping the buffer near-empty before that can happen.
    window.addEventListener("beforeunload", () => this.dispose());
    document.addEventListener("visibilitychange", () => this.onVisibility());
    window.addEventListener("focus", () => {
      this.cmdAvailable.clear();
      this.current()?.recoverRenderers(false);
      // A file edited in place or `git add` from the terminal never touches
      // the tree's structural watch, so returning focus to the window is the
      // trigger that catches both.
      this.refreshGitStatuses();
    });
    window.addEventListener("pointerdown", () => this.noteActivity(), {
      capture: true,
    });
    window.addEventListener("contextmenu", (e) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, .cm-editor, .xterm, img, video")) return;
      e.preventDefault();
    });
    void getCurrentWindow().onFocusChanged(({ payload }) => {
      this.logMetric(payload ? "app_focus" : "app_blur");
      if (!payload && this.config.metrics.enabled) void this.metrics.flush();
    });
    this.setupTitlebarSearch();
    document.addEventListener("focusin", () => this.refreshFocusSurface());
    this.refreshFocusSurface();
    this.startTimers();
    void getVersion()
      .then((v) => {
        this.appVersion = v;
      })
      .catch(() => {});
    this.updateIndicator = new UpdateIndicator(() => this.openUpdatePrompt());
    this.updates = new UpdateController((s, manual) =>
      this.onUpdateState(s, manual),
    );
  }

  // Screen recording is a rare action, so its module (and screencast-core) is
  // pulled out of the startup bundle and loaded the first time you record.
  private async getScreencast(): Promise<Screencast> {
    if (!this.screencast) {
      const { createScreencast } = await import("./screencast");
      this.screencast = createScreencast({
        getConfig: () => this.config,
        focusedPaneRect: () => this.focusedPaneRect(),
        titlebarOffset: () => this.titlebarOffset(),
        activeTabName: () => this.tab(this.activeId)?.title ?? "shirei",
        notify: (msg, action) => showToast(msg, action),
      });
    }
    return this.screencast;
  }

  // The one surface that reads as active drives the dim/highlight chrome: the
  // terminal grid, the file tree, or the TODO panel. Derived from real DOM focus
  // so clicks, keyboard moves and programmatic focus all stay in sync.
  private refreshFocusSurface(): void {
    const el = document.activeElement;
    const surface = this.todoPanelEl.contains(el)
      ? "todo"
      : this.panelEl.contains(el)
        ? "tree"
        : "terminal";
    this.mainEl.dataset.focus = surface;
  }

  private setupTitlebarSearch(): void {
    const btn = document.querySelector<HTMLElement>("#titlebar-search");
    if (!btn) return;
    const icon = btn.querySelector<HTMLElement>(".ts-icon");
    if (icon) icon.innerHTML = SEARCH;
    this.searchKbd = btn.querySelector<HTMLElement>(".ts-key");
    // Suppress focus-on-click so the platform focus ring only shows for keyboard
    // navigation, not on a mouse press (the click handler still fires).
    keepFocusOffClick(btn);
    btn.addEventListener("click", () => void this.openQuickOpen());

    this.sidebarBtn = document.querySelector<HTMLElement>("#titlebar-sidebar");
    const sidebarIcon = this.sidebarBtn?.querySelector<HTMLElement>(".ts-icon");
    if (sidebarIcon) sidebarIcon.innerHTML = SIDEBAR;
    if (this.sidebarBtn) keepFocusOffClick(this.sidebarBtn);
    this.sidebarBtn?.addEventListener("click", () => this.togglePanel());
    this.syncSidebarButton();

    this.dockBtn = document.querySelector<HTMLElement>("#titlebar-dock");
    const dockIcon = this.dockBtn?.querySelector<HTMLElement>(".ts-icon");
    if (dockIcon) dockIcon.innerHTML = PANEL_RIGHT;
    this.dockKbd = this.dockBtn?.querySelector<HTMLElement>(".ts-key") ?? null;
    if (this.dockBtn) keepFocusOffClick(this.dockBtn);
    this.dockBtn?.addEventListener("click", () => this.togglePinDock());

    this.updateSearchHint();
    this.applyTitlebarLabels();
  }

  private applyTitlebarLabels(): void {
    const search = document.querySelector<HTMLElement>("#titlebar-search");
    search?.setAttribute("title", t("ui.titlebar.search"));
    const searchLabel = search?.querySelector<HTMLElement>(".ts-label");
    if (searchLabel) searchLabel.textContent = t("ui.titlebar.searchLabel");
    this.sidebarBtn?.setAttribute("title", t("ui.titlebar.toggleSidebar"));
    this.dockBtn?.setAttribute("title", t("ui.titlebar.toggleDock"));
    const dockLabel = this.dockBtn?.querySelector<HTMLElement>(".ts-label");
    if (dockLabel) dockLabel.textContent = t("ui.titlebar.dock");
  }

  private syncSidebarButton(): void {
    this.sidebarBtn?.classList.toggle("active", this.panelVisible);
  }

  private strokeFor(action: string): string {
    const stroke = resolveBindings(this.config.keybindings ?? {})[action]?.[0];
    return stroke ? formatKeystroke(stroke) : "";
  }

  private updateSearchHint(): void {
    if (this.searchKbd)
      this.searchKbd.textContent = this.strokeFor("palette.open");
    if (this.dockKbd) this.dockKbd.textContent = this.strokeFor("pane.pin");
    this.todoPanel.setFocusHint(this.strokeFor("todo.focus"));
    this.tree.setFocusHint(this.strokeFor("tree.focus"));
  }

  // Coming back from a long hidden span (likely a GPU sleep, where WKWebView can
  // leave the WebGL surface stale without firing webglcontextlost) rebuilds the
  // renderers; a quick refocus only nudges a repaint.
  private onVisibility(): void {
    if (document.hidden) {
      this.hiddenAt = Date.now();
      if (this.config.metrics.enabled) void this.metrics.flush();
      return;
    }
    const hard =
      this.hiddenAt !== null && Date.now() - this.hiddenAt > LONG_HIDDEN_MS;
    this.hiddenAt = null;
    this.current()?.recoverRenderers(hard);
  }

  /** Coalesces resize storms into one fit per frame. */
  private queueFit(): void {
    if (this.fitQueued) return;
    this.fitQueued = true;
    requestAnimationFrame(() => {
      this.fitQueued = false;
      this.current()?.fitAndResize();
    });
  }

  private startTimers(): void {
    this.stopTimers();
    this.snapshotTimer = setInterval(
      () => void this.snapshot(),
      Math.max(1, this.config.session.snapshot_interval_secs) * 1000,
    );
    this.ageTimer = setInterval(() => {
      this.tabbar.refreshAges();
      this.orchestration.refreshAges();
    }, Math.max(1, this.config.tabs.age_refresh_secs) * 1000);
    if (this.config.metrics.enabled) {
      this.metricsTimer = setInterval(
        () => this.tickMetrics(),
        Math.max(1000, this.config.metrics.activity_ping_ms),
      );
    }
  }

  private stopTimers(): void {
    if (this.snapshotTimer !== null) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    if (this.ageTimer !== null) {
      clearInterval(this.ageTimer);
      this.ageTimer = null;
    }
    if (this.metricsTimer !== null) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }
  }

  private logMetric(
    kind: string,
    fields: Omit<Parameters<typeof makeEvent>[1], never> = {},
  ): void {
    if (!this.config.metrics.enabled) return;
    this.metrics.log(
      makeEvent(kind, { sessionId: this.metricsSessionId, ...fields }),
    );
  }

  private trackNewTabDormancy(tabId: string): void {
    if (!this.config.metrics.enabled) return;
    this.tabDormancy.set(tabId, {
      state: "active",
      shown: true,
      lastActiveAt: Date.now(),
    });
  }

  private untrackTabMetrics(tabId: string): void {
    if (!this.config.metrics.enabled) return;
    this.tabDormancy.delete(tabId);
    this.agentMetricsState.delete(tabId);
  }

  private feedDormancy(tabId: string, input: DormancyInput): void {
    if (!this.config.metrics.enabled) return;
    const prev = this.tabDormancy.get(tabId);
    if (!prev) return;
    const { next, emit } = dormancyTransition(
      prev,
      input,
      Date.now(),
      this.config.metrics.dormant_after_ms,
    );
    this.tabDormancy.set(tabId, next);
    if (!emit) return;
    const tab = this.tab(tabId);
    const projectId = tab?.kind === "terminal" ? (tab.projectId ?? null) : null;
    this.logMetric(emit, { tabId, projectId });
  }

  // Coarse presence ping: throttled to the config cadence and carrying no
  // keystroke/click counts, only that the user is here. Also keeps the active
  // tab's dormancy alive and clears a running system-idle span.
  private noteActivity(): void {
    if (!this.config.metrics.enabled) return;
    const now = Date.now();
    if (now - this.lastActivityPingAt >= this.config.metrics.activity_ping_ms) {
      this.lastActivityPingAt = now;
      this.logMetric("input_activity");
    }
    if (this.activeId) this.feedDormancy(this.activeId, "activity");
    if (this.systemIdle) {
      this.systemIdle = false;
      this.logMetric("system_idle_end");
    }
    this.lastActivityAt = now;
  }

  private tickMetrics(): void {
    if (!this.config.metrics.enabled) return;
    const now = Date.now();
    const states = this.tabSessionStates();
    for (const [tabId, state] of this.tabDormancy) {
      const entry = states.get(tabId);
      const input: DormancyInput =
        entry &&
        (entry.state.kind === "working" || entry.state.kind === "waiting")
          ? "activity"
          : "tick";
      const { next, emit } = dormancyTransition(
        state,
        input,
        now,
        this.config.metrics.dormant_after_ms,
      );
      this.tabDormancy.set(tabId, next);
      if (!emit) continue;
      const tab = this.tab(tabId);
      const projectId =
        tab?.kind === "terminal" ? (tab.projectId ?? null) : null;
      this.logMetric(emit, { tabId, projectId });
    }
    if (
      !this.systemIdle &&
      now - this.lastActivityAt >= this.config.metrics.idle_after_ms
    ) {
      this.systemIdle = true;
      this.logMetric("system_idle_start");
      this.pauseFocusCellsOnIdle();
    }
  }

  // Reuses the app's own idle detector (config.metrics.idle_after_ms of no
  // keyboard/mouse activity) rather than standing up a second one — matching
  // the Settings copy ("pause the timer when the session goes idle") and
  // never auto-resuming, since coming back from idle is a deliberate action.
  private pauseFocusCellsOnIdle(): void {
    if (!this.config.focus.pause_on_idle) return;
    for (const cell of this.pinCells) {
      if (cell?.session instanceof FocusCell) cell.session.pauseIfRunning();
    }
  }

  // Session-state events arrive per pane leaf, but a tab surfaces only its most
  // urgent tracked session (tabSessionStates, shared with the tabbar/bell UI);
  // agent metrics follow that same per-tab primary state so the two never
  // disagree. Dormancy is kept alive here on every state-change poll while a
  // tab is working/waiting; tickMetrics reads that same primary state on its
  // own periodic timer so a hidden tab whose agent works silently between
  // state changes (e.g. a long build with no output) never crosses to dormant.
  private emitAgentMetrics(): void {
    if (!this.config.metrics.enabled) return;
    const states = this.tabSessionStates();
    for (const tab of this.tabs) {
      const entry = states.get(tab.id);
      if (
        entry &&
        (entry.state.kind === "working" || entry.state.kind === "waiting")
      ) {
        this.feedDormancy(tab.id, "activity");
      }
      const prev = this.agentMetricsState.get(tab.id);
      if (entry && prev && sameKind(prev, entry.state)) continue;
      if (prev) this.endAgentState(tab, prev);
      if (entry) {
        this.beginAgentState(tab, entry);
        this.agentMetricsState.set(tab.id, entry.state);
      } else {
        this.agentMetricsState.delete(tab.id);
      }
    }
  }

  private endAgentState(tab: TabState, state: SessionState): void {
    const projectId = tab.kind === "terminal" ? (tab.projectId ?? null) : null;
    if (state.kind === "working")
      this.logMetric("working_end", { tabId: tab.id, projectId });
    else if (state.kind === "waiting")
      this.logMetric("waiting_end", { tabId: tab.id, projectId });
  }

  private beginAgentState(tab: TabState, entry: SessionStateEntry): void {
    const projectId = tab.kind === "terminal" ? (tab.projectId ?? null) : null;
    const cliName = resolveCliId(entry.command, this.config.cli_registry);
    const command = entry.command ?? null;
    switch (entry.state.kind) {
      case "working":
        this.logMetric("working_start", {
          tabId: tab.id,
          projectId,
          cliName,
          payload: JSON.stringify({ command }),
        });
        break;
      case "waiting":
        this.logMetric("waiting_start", {
          tabId: tab.id,
          projectId,
          cliName,
          payload: JSON.stringify({ wait: entry.state.wait, command }),
        });
        break;
      case "done":
        this.logMetric("done", {
          tabId: tab.id,
          projectId,
          cliName,
          payload: JSON.stringify({ code: entry.state.code, command }),
        });
        break;
      case "errored":
        this.logMetric("errored", {
          tabId: tab.id,
          projectId,
          cliName,
          payload: JSON.stringify({ code: entry.state.code, command }),
        });
        break;
    }
  }

  // Single funnel for project focus: every path that changes which project is
  // active (opening/creating a project tab, switching tabs, opening a plain
  // file/terminal tab) routes through setActiveProject, so this is the one
  // place that needs to emit project_opened/focused/unfocused.
  private emitProjectFocusMetrics(projectId: string | null): void {
    if (!this.config.metrics.enabled) return;
    const previous = this.activeProjectId;
    if (previous === projectId) return;
    this.activeProjectId = projectId;
    if (previous !== null)
      this.logMetric("project_unfocused", { projectId: previous });
    if (projectId === null) return;
    if (!this.seenProjectIds.has(projectId)) {
      this.seenProjectIds.add(projectId);
      const project = this.projects.find((p) => p.id === projectId);
      this.logMetric("project_opened", {
        projectId,
        payload: JSON.stringify({
          name: project?.name,
          path: project?.path,
        }),
      });
    }
    this.logMetric("project_focused", { projectId });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.logMetric("session_end");
    this.stopTimers();
    if (getCurrentWindow().label === "main") this.persist();
    else clearSession();
    this.statusbar.dispose();
    for (const session of this.sessions.values()) void session.dispose();
    void this.metrics.dispose();
  }

  async init(): Promise<void> {
    this.logMetric("session_start");
    void this.syncMemoryDefaults();
    this.tree.setHome(await homeDir());
    const saved = loadSession();
    if (saved.length === 0) {
      await this.newTab();
    } else {
      this.restoring = true;
      // The tab the user left focused, captured by the id its restore actually
      // produced (openTerminalTab/openFile set activeId to the new tab), so it
      // survives any tab that fails to restore instead of drifting by index.
      let activeTabId: string | null = null;
      for (const t of saved) {
        if (t.kind === "terminal") {
          await this.openTerminalTab(t.tree, t.title, t.color, t.projectId);
        } else {
          await this.openFile(t.path, { silent: true });
        }
        if (t.active) activeTabId = this.activeId;
      }
      if (!this.tabs.some((x) => x.kind === "terminal")) await this.newTab();
      saved.forEach((s, i) => {
        const t = this.tabs[i];
        if (!t) return;
        if (typeof s.lastUsedAt === "number") t.lastUsedAt = s.lastUsedAt;
        if (typeof s.pinned === "boolean") t.pinned = s.pinned;
      });
      this.restoring = false;
      this.renderTabs();
      // Restoring the tabs in order leaves the last-created one active; return
      // focus to whichever tab the user actually had open when they quit.
      if (activeTabId && activeTabId !== this.activeId)
        this.activate(activeTabId);
      this.persist();
    }
    await this.restorePinDock();
    if (this.panelVisible) await this.openWorkspaceTree();
    if (this.config.updates.auto_check) {
      // Two rAFs so the check starts only after the boot frame has painted:
      // the first callback runs before paint, the second after.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => void this.updates.checkAuto());
      });
    }
  }

  async bindMenu(): Promise<void> {
    await listen("tree-changed", () => this.onTreeChanged());
    await listen("git-changed", () => this.refreshGitStatuses());
    await listen("menu-new-tab", () => void this.newTab());
    await listen("menu-close-tab", () => void this.closeActive());
    await listen("menu-palette", () => void this.openQuickOpen());
    await listen("menu-toggle-sidebar", () => this.togglePanel());
    await listen("menu-zoom-in", () => this.setFontSize(this.fontSize + 1));
    await listen("menu-zoom-out", () => this.setFontSize(this.fontSize - 1));
    await listen("menu-zoom-reset", () => this.setFontSize(DEFAULT_FONT_SIZE));
    await listen<number>("menu-goto-tab", (e) => this.gotoTab(e.payload));
    // Pane actions routed through the menu so they work over a focused browser
    // pane; they resolve through the same dispatch as their JS keybindings.
    const paneAction = (action: string) =>
      this.dispatch(action, this.sessions.get(this.activeId ?? ""));
    await listen("menu-pane-pin", () => paneAction("pane.pin"));
    await listen("menu-pane-focus-left", () => paneAction("focus.left"));
    await listen("menu-pane-focus-right", () => paneAction("focus.right"));
    await listen("menu-pane-focus-up", () => paneAction("focus.up"));
    await listen("menu-pane-focus-down", () => paneAction("focus.down"));
    await listen("menu-browser-reload", () => paneAction("browser.reload"));
    await listen("menu-browser-url", () => paneAction("browser.focus-url"));
    // Cmd+Q / the "Quit Shirei" menu item terminate via NSApplication directly,
    // skipping beforeunload's async dispose — the backend holds native exit for
    // a short grace period after this fires, giving dispose() (guarded by
    // `disposed`, so session_end never logs twice) its one guaranteed chance to
    // flush the metrics buffer before the process actually goes away.
    await listen("metrics://flush-on-exit", () => this.dispose());
  }

  // The daemon connection can die between any two keystrokes (idle-exit, a
  // rebuilt binary replacing it, a crash); the backend has no way to retry a
  // half-completed attach on its own, so it asks the frontend to redo it here
  // instead of leaving every pane silently unresponsive until ⌘⇧R.
  async bindMuxEvents(): Promise<void> {
    await listen("mux://connection-lost", () => {
      const now = Date.now();
      if (now - this.lastMuxReconnectAt < MUX_RECONNECT_DEBOUNCE_MS) return;
      this.lastMuxReconnectAt = now;
      for (const session of this.sessions.values()) {
        if (session instanceof PaneGrid) session.reconnectAll();
      }
    });
  }

  // Detection lives in shirei-mux keyed by PTY session (pane leaf) id; a tab
  // can hold several panes, so it surfaces the most urgent one on its tab.
  async bindSessionStateEvents(): Promise<void> {
    await initSessionState();
    await this.notifications.init();
    onSessionStateChange(() => {
      this.renderTabs();
      if (this.orchestration.isOpen()) {
        this.orchestration.refresh(this.boardRows());
      }
      const active = this.sessions.get(this.activeId ?? "");
      this.notifications.setActive(
        active instanceof PaneGrid ? active.leafIds() : [],
      );
      this.notifications.sync(this.notificationRows());
      this.emitAgentMetrics();
      this.maybeAutosaveMemory();
      this.maybeBootstrapMemory();
    });
  }

  // Update UI wiring lives in its own bucket: the native "Check for Updates…"
  // item and the cross-window bridge that lets the Settings → About row
  // mirror this window's pending state and ask it to open the modal.
  async bindUpdateEvents(): Promise<void> {
    await listen("menu://check-updates", () => void this.updates.checkManual());
    await listen("shirei://update-open-modal", () => this.openUpdatePrompt());
    await listen("shirei://update-state-request", () => {
      const pending = this.updates.pending();
      if (!pending) return;
      void emit("shirei://update-state", {
        kind: "available",
        version: pending.version,
        notes: pending.notes,
      } satisfies UpdateState);
    });
  }

  // Auto-detection stays quiet: available only lights the titlebar indicator
  // and, once per new version, a toast — it never opens the modal on its own.
  // A manual check ("Check for Updates…") is an explicit user action, so its
  // outcome is always visible: the modal opens directly when one is found.
  private onUpdateState(state: UpdateState, manual = false): void {
    void emit("shirei://update-state", state);
    switch (state.kind) {
      case "checking":
        showToast(t("ui.update.checking"));
        break;
      case "available":
        if (state.version) {
          this.updateIndicator.show(state.version);
          if (manual) {
            this.rememberSeen(state.version);
            this.openUpdatePrompt();
          } else {
            this.announceUpdate(state.version);
          }
        }
        break;
      case "uptodate":
        this.updateIndicator.hide();
        showToast(t("ui.update.upToDate"));
        break;
      case "downloading":
      case "ready":
        this.updateModal?.render(state);
        break;
      case "error":
        if (this.updateModal) {
          this.updateModal.render(state);
        } else {
          showToast(t("ui.update.checkFailed"), {
            label: t("ui.update.retry"),
            run: () => void this.updates.checkManual(),
          });
        }
        break;
      default:
        break;
    }
  }

  private announceUpdate(version: string): void {
    if (version === this.config.updates.last_seen) return;
    showToast(t("ui.update.available", { version }), {
      label: t("ui.update.view"),
      run: () => this.openUpdatePrompt(),
    });
    this.rememberSeen(version);
  }

  private rememberSeen(version: string): void {
    this.config = {
      ...this.config,
      updates: { ...this.config.updates, last_seen: version },
    };
    void configSet(this.config);
  }

  private openUpdatePrompt(): void {
    if (this.updateModal) return;
    const pending = this.updates.pending();
    if (!pending) return;
    void getCurrentWindow().setFocus();
    this.updateModal = openUpdateModal({
      version: pending.version,
      currentVersion: this.appVersion,
      notes: pending.notes,
      onInstall: () => void this.updates.install(),
      onDismiss: () => {
        this.updateModal = null;
      },
    });
  }

  applyConfig(c: Config): void {
    const previous = this.config;
    this.config = c;
    this.notifications.setConfig(c.notifications, c.cli_registry);
    this.metrics.setConfig(c.metrics);
    setLocale(c.locale);
    this.applyTitlebarLabels();
    this.keymap = new Keymap(c.keybindings ?? {});
    this.projects = c.projects ?? [];
    this.fontSize = c.font.size;
    this.panelEl.style.width = `${c.layout.sidebar_width}px`;
    this.updateSearchHint();
    this.applySessionLook(c);
    this.tabbar.setPalette(c.theme.tabs);
    this.tabbar.setShowAge(c.tabs.show_age);
    this.statusbar.setConfig(c.performance);
    this.renderTabs();
    applyChrome(c.theme.preset, c.theme.terminal);
    applyRenderCss(c.render);
    applyRecColor(c.recorder.highlight_color);
    this.applyFocusChrome(c.chrome);
    applyMotionVars(document.documentElement, c.motion);
    this.updateContextHint();
    webglPool.setCap(c.render.webgl_pool_cap);
    this.applyFocusCellsConfig(c);
    if (previous.git.status.show_deleted !== c.git.status.show_deleted) {
      this.tree.setShowDeleted(c.git.status.show_deleted);
      // Ghost rows are computed while listing a directory, not read live off
      // this flag, so toggling it needs a re-list to actually show/hide them.
      void this.tree.refresh();
    }
    if (previous.git.status.status_in_tree !== c.git.status.status_in_tree) {
      if (c.git.status.status_in_tree) this.refreshGitStatuses();
      else this.tree.clearStatuses();
    }
    if (previous.memory.enabled !== c.memory.enabled) {
      void this.refreshMemoryBadge();
    }
    if (
      previous.memory.overview_skeleton !== c.memory.overview_skeleton ||
      previous.memory.decisions_header !== c.memory.decisions_header ||
      previous.locale !== c.locale
    ) {
      void this.syncMemoryDefaults();
    }
    if (
      previous.session.snapshot_interval_secs !==
        c.session.snapshot_interval_secs ||
      previous.tabs.age_refresh_secs !== c.tabs.age_refresh_secs ||
      previous.metrics.enabled !== c.metrics.enabled ||
      previous.metrics.activity_ping_ms !== c.metrics.activity_ping_ms
    ) {
      this.startTimers();
    }
  }

  // Each focus/depth chrome treatment is opt-out: a "no-*" class on the root
  // disables it, so the CSS defaults to the full look and the toggles only ever
  // turn things off. Missing config (older payloads) keeps everything on.
  private applyFocusChrome(c: Config["chrome"] | undefined): void {
    const r = document.documentElement.classList;
    r.toggle("no-dim", c?.dim_inactive === false);
    r.toggle("no-pane-accent", c?.pane_accent === false);
    r.toggle("no-tab-line", c?.tab_accent_line === false);
    r.toggle("no-tab-hat", c?.active_tab_highlight === false);
  }

  // Pinned FocusCells outlive a single applyConfig call (the dock stays open
  // across a settings save), so a live cell must be re-themed/re-gated in
  // place instead of only picking up the new config on its next reopen.
  private applyFocusCellsConfig(c: Config): void {
    for (const cell of this.pinCells) {
      if (cell?.session instanceof FocusCell) {
        cell.session.setConfig(
          c.focus,
          c.theme.terminal.bg,
          c.metrics.enabled,
          this.focusCellShortcuts(),
        );
      }
    }
  }

  // Settings runs in a separate webview, so a font installed there is absent
  // from this window's FontFace set. Load the selected face before handing it
  // to xterm: applying a family whose face isn't ready yet bakes the fallback
  // glyphs into the WebGL atlas, and that atlas is keyed by the family string,
  // so it never re-rasterizes once the face arrives. Keep the previous font
  // until the new one is loaded, then apply it once against the real glyphs.
  private applySessionLook(c: Config): void {
    const entry = c.fonts.catalog.find((e) => e.id === c.font.family);
    if (entry?.kind === "download" && !isFontLoaded(c.font.family)) {
      void registerFont(c.font.family, c.fonts)
        .then(() => this.applySessionLook(c))
        .catch(() => {});
      return;
    }
    const family = fontStack(c.font.family, c.fonts);
    for (const s of this.sessions.values()) {
      if (s instanceof PaneGrid) {
        s.applyLook(family, c.font.size, c.render, c.theme.terminal);
        s.applyContentLook((session) => {
          if (EditorSession !== null && session instanceof EditorSession) {
            session.applyLook(
              family,
              c.font.size,
              c.theme.terminal,
              c.theme.preset,
            );
            session.applyEditorConfig(c.editor);
          } else if (
            session instanceof ImageSession ||
            session instanceof MediaSession
          ) {
            session.setBg(c.theme.editor.bg);
          } else if (session instanceof BrowserSession) {
            this.applyBrowserSessionConfig(session);
          }
        });
      } else if (EditorSession !== null && s instanceof EditorSession) {
        s.applyLook(family, c.font.size, c.theme.terminal, c.theme.preset);
        s.applyEditorConfig(c.editor);
      } else if (s instanceof ImageSession || s instanceof MediaSession) {
        s.setBg(c.theme.editor.bg);
      }
    }
  }

  private tab(id: string | null): TabState | undefined {
    return id ? this.tabs.find((t) => t.id === id) : undefined;
  }

  /** Serializes tab mutations; see `tabOps`. */
  private enqueue(op: () => Promise<void>): Promise<void> {
    this.tabOps = this.tabOps.then(op, op);
    return this.tabOps;
  }

  private current(): PaneGrid | undefined {
    const s = this.activeId ? this.sessions.get(this.activeId) : undefined;
    return s instanceof PaneGrid ? s : undefined;
  }

  private showActive(): void {
    for (const [sid, s] of this.sessions) {
      s.show(sid === this.activeId);
    }
    void this.updateActiveTab();
    this.updateContextHint();
  }

  private updateContextHint(): void {
    if (!this.config.chrome.context_hints) {
      this.statusbar.setContextHint("");
      return;
    }
    const active = this.sessions.get(this.activeId ?? "");
    if (!(active instanceof PaneGrid)) {
      this.statusbar.setContextHint("");
      return;
    }
    const paneId = active.activePaneId();
    if (active.activeContentIsChooser(paneId)) {
      this.statusbar.setContextHint(t("ui.statusbar.hintChooser"));
      return;
    }
    if (active.activeContentIsBrowser(paneId)) {
      this.statusbar.setContextHint(t("ui.statusbar.hintBrowser"));
      return;
    }
    if (active.activeContentIsFile(paneId)) {
      this.statusbar.setContextHint(t("ui.statusbar.hintFile"));
      return;
    }
    const focused = active.contentCandidates().find((c) => c.focused);
    this.statusbar.setContextHint(
      focused?.hasFile ? t("ui.statusbar.hintTerminal") : "",
    );
  }

  private async updateActiveTab(): Promise<void> {
    const active = this.sessions.get(this.activeId ?? "");
    if (!(active instanceof PaneGrid)) {
      await invoke("perf_set_active_tab", {
        pids: [],
        tabWeight: 0,
        totalWeight: 0,
      });
      return;
    }
    const pids = (
      await Promise.all(
        active
          .leafIds()
          .map((id) =>
            invoke<number | null>("session_pid", { id }).catch(() => null),
          ),
      )
    ).filter((p): p is number => p !== null);
    let totalWeight = 0;
    for (const s of this.sessions.values())
      if (s instanceof PaneGrid) totalWeight += s.scrollbackWeight();
    await invoke("perf_set_active_tab", {
      pids,
      tabWeight: active.scrollbackWeight(),
      totalWeight,
    });
  }

  private toggleStatusbar(): void {
    this.config = {
      ...this.config,
      performance: {
        ...this.config.performance,
        enabled: !this.config.performance.enabled,
      },
    };
    void configSet(this.config);
    this.statusbar.setConfig(this.config.performance);
  }

  private toggleVim(): void {
    this.config = {
      ...this.config,
      editor: { ...this.config.editor, vim: !this.config.editor.vim },
    };
    void configSet(this.config);
    for (const s of this.sessions.values())
      if (EditorSession !== null && s instanceof EditorSession)
        s.setVim(this.config.editor.vim);
  }

  private markTabActivity(id: string): void {
    const tab = this.tab(id);
    if (!tab) return;
    tab.lastUsedAt = Date.now();
    if (id !== this.activeId) this.tabbar.updateAge(id, tab.lastUsedAt);
  }

  private togglePin(id: string): void {
    const tab = this.tab(id);
    if (!tab) return;
    tab.pinned = !tab.pinned;
    this.tabs = this.tabs.filter((t) => t.id !== id);
    if (tab.pinned) {
      this.tabs.unshift(tab);
    } else {
      const firstUnpinned = this.tabs.findIndex((t) => !t.pinned);
      if (firstUnpinned < 0) this.tabs.push(tab);
      else this.tabs.splice(firstUnpinned, 0, tab);
    }
    this.renderTabs();
    this.persist();
  }

  private focusActive(): void {
    if (this.todoFocused) this.blurTodoPanel();
    this.blurPinDock();
    const s = this.sessions.get(this.activeId ?? "");
    if (s instanceof PaneGrid) s.fitAndResize();
    s?.focus();
  }

  newTab(title?: string, color: string | null = null): Promise<void> {
    return this.enqueue(() => this.doNewTab(title, color));
  }

  private async doNewTab(
    title?: string,
    color: string | null = null,
  ): Promise<void> {
    const cwd = await this.newTabCwd();
    await this.openTerminalTab(await this.defaultTabTree(cwd), title, color);
  }

  private async newTabCwd(): Promise<string> {
    return this.config.layout.new_tab_dir || (await homeDir());
  }

  private async ensureCommand(command: string): Promise<void> {
    if (this.cmdAvailable.has(command)) return;
    this.cmdAvailable.set(command, await binaryOnPath(command));
  }

  /**
   * The tree a new tab opens with. Honors `layout.default_template`, but only if
   * every command the template declares is installed — otherwise a plain shell,
   * so a template using `yagura` degrades to a normal tab when it is absent.
   */
  private async defaultTabTree(cwd: string | undefined): Promise<PaneNode> {
    const name = this.config.layout.default_template;
    const templates = allTemplates(this.config);
    const selected = name ? templates.find((t) => t.name === name) : undefined;
    if (selected)
      await Promise.all(
        declaredCommands(selected.tree).map((c) => this.ensureCommand(c)),
      );
    const tpl = resolveDefaultTemplate(
      templates,
      name,
      (c) => this.cmdAvailable.get(c) ?? false,
    );
    if (!tpl) return { kind: "leaf", id: nextId(), cwd };
    return instantiate(tpl, nextId, cwd ?? (await homeDir()));
  }

  /**
   * What a restored pane should run: declared template commands follow the
   * policy; commands captured from a live session (lastCommand) only re-run
   * under "all". `undefined` lastCommand means no snapshot ever ran, so the
   * declared command is the best signal available.
   */
  private spawnCommandFor(leaf: LeafSpawn): string | undefined {
    const policy = this.config.session.restore_commands;
    if (policy === "never") return undefined;
    if (leaf.lastCommand === undefined) return leaf.command;
    return policy === "all" ? (leaf.lastCommand ?? undefined) : leaf.command;
  }

  /**
   * Resolves the command per pane (keyed by leaf id) for a tab being opened.
   * Every `claude` pane spawns with `--resume`, whether restored or freshly
   * opened: bare `claude` starts a throwaway conversation, and `--continue`
   * attaches to the most recent one in the directory, so panes and tabs opening
   * at once race onto that same conversation and clobber each other. `--resume`
   * lets each pane pick the session it belongs to.
   */
  private resolveSpawnCommands(
    tree: PaneNode,
  ): Map<string, string | undefined> {
    return new Map(
      leaves(tree).map((leaf) => {
        const cmd = this.spawnCommandFor(leaf);
        return [leaf.id, isClaudeCommand(cmd) ? withClaudeResume(cmd) : cmd];
      }),
    );
  }

  private async restorePaneContents(
    grid: PaneGrid,
    tree: PaneNode,
  ): Promise<void> {
    for (const leaf of leaves(tree)) {
      const contents = readLeafContents(leaf);
      for (const c of contents) {
        if (c.kind === "browser") {
          await this.switchPaneToBrowser(grid, leaf.id, c.url);
        } else {
          await this.switchPaneToFile(grid, leaf.id, c.path, true);
        }
      }
      // A template's dedicated file pane is born showing the chooser; leave it
      // active rather than snapping back to the terminal underneath.
      if (contents.length === 0 && leaf.file) {
        await this.switchPaneToFile(grid, leaf.id, undefined, true);
        continue;
      }
      grid.switchContentIn(leaf.id, leaf.activeContent ?? 0);
    }
  }

  private async openTerminalTab(
    tree: PaneNode,
    title?: string,
    color: string | null = null,
    projectId?: string,
  ): Promise<void> {
    const id = nextId();
    this.tabs.push({
      id,
      kind: "terminal",
      title: title ?? `場 Ba ${this.tabs.length + 1}`,
      color,
      projectId,
      lastUsedAt: Date.now(),
      pinned: false,
    });
    this.logMetric("tab_created", {
      tabId: id,
      projectId: projectId ?? null,
      payload: JSON.stringify({
        paneKind: "terminal",
        has_project: projectId != null,
      }),
    });
    this.trackNewTabDormancy(id);
    const container = document.createElement("div");
    container.className = "terminal-host";
    this.host.appendChild(container);
    const commands = this.resolveSpawnCommands(tree);
    const grid = new PaneGrid(container, tree, {
      makeSession: (sid, el, leaf) => {
        const session = new TerminalSession(sid, el, {
          fontFamily: fontStack(this.config.font.family, this.config.fonts),
          fontSize: this.config.font.size,
          render: this.config.render,
          theme: this.config.theme.terminal,
          keepAlive: this.config.session.keep_alive,
          activityThrottleMs:
            Math.max(1, this.config.tabs.activity_throttle_secs) * 1000,
          appOwnsKeystroke: (e) => this.keymap.ownsMetaKeystroke(e),
          cwd: leaf.cwd,
          command: commands.get(sid),
        });
        session.onActivity = () => this.markTabActivity(id);
        return session;
      },
      onEmpty: () => void this.closeTab(id),
      onActivePane: () => {
        this.refreshTreeIfVisible();
        void this.updateActiveTab();
        this.updateContextHint();
      },
      cwdOf: (pid) =>
        ptyCwd(pid).then(
          (c) => c ?? undefined,
          () => undefined,
        ),
      contentCap: () => Math.max(1, this.config.layout.pane_content_cap),
      onContentChange: () => {
        this.refreshTreeIfVisible();
        this.persist();
        this.updateContextHint();
        this.syncNativeVisibility();
      },
      onPickContent: (paneId) => {
        const g = this.sessions.get(id);
        if (g instanceof PaneGrid) this.openPaneContentPicker(g, paneId);
      },
      onCloseContent: () => {
        const g = this.sessions.get(id);
        if (g instanceof PaneGrid) void this.closeActiveContentGuarded(g);
      },
    });
    grid.setAccent(color);
    this.sessions.set(id, grid);
    this.activeId = id;
    this.showActive();
    await grid.open();
    await this.restorePaneContents(grid, tree);
    this.renderTabs();
    grid.focus();
    this.persist();
    this.setActiveProject(projectId ?? null);
  }

  applyTemplate(
    template: PaneNode,
    root: string,
    title?: string,
    color: string | null = null,
    projectId?: string,
  ): Promise<void> {
    return this.enqueue(() =>
      this.openTerminalTab(
        instantiate(template, nextId, root),
        title,
        color,
        projectId,
      ),
    );
  }

  openProject(id: string): Promise<void> {
    return this.enqueue(async () => {
      const project = this.projects.find((p) => p.id === id);
      if (!project) return;
      const existing = this.tabs.find(
        (t) => t.kind === "terminal" && t.projectId === id,
      );
      if (existing) {
        this.activate(existing.id);
        return;
      }
      await this.openTerminalTab(
        instantiate(project.tree, nextId, project.path),
        project.name,
        project.color,
        project.id,
      );
    });
  }

  private saveProjectLayout(): void {
    if (!this.activeId) return;
    const activeTab = this.tab(this.activeId);
    if (activeTab?.kind !== "terminal" || !activeTab.projectId) return;
    const grid = this.sessions.get(this.activeId);
    if (!(grid instanceof PaneGrid)) return;
    const projectIndex = this.config.projects.findIndex(
      (p) => p.id === activeTab.projectId,
    );
    if (projectIndex === -1) return;
    this.config.projects[projectIndex] = {
      ...this.config.projects[projectIndex],
      tree: grid.serialize(),
    };
    this.projects = [...this.config.projects];
    void configSet(this.config);
  }

  private async saveAsTemplate(): Promise<void> {
    const grid = this.sessions.get(this.activeId ?? "");
    if (!(grid instanceof PaneGrid)) return;
    const name = await promptText(t("ui.app.savePrompt"));
    if (!name) return;
    const list = [...(this.config.user_templates ?? [])];
    const tree = grid.serialize();
    const idx = list.findIndex((t) => t.name === name);
    if (idx >= 0) list[idx] = { name, tree };
    else list.push({ name, tree });
    this.config = { ...this.config, user_templates: list };
    void configSet(this.config);
    this.notify(t("ui.template.saved", { name }));
  }

  openFile(
    path: string,
    opts: { newTab?: boolean; silent?: boolean } = {},
  ): Promise<void> {
    return this.enqueue(() => this.doOpenFile(path, opts));
  }

  private async doOpenFile(
    path: string,
    opts: { newTab?: boolean; silent?: boolean } = {},
  ): Promise<void> {
    const { newTab = false, silent = false } = opts;
    // Dedupe: one live view per path, revealed wherever it lives (tab or
    // slot). A ghost tab is a separate, read-only peek at HEAD content, never
    // the live file, so it never satisfies this lookup.
    const existing = this.tabs.find(
      (t) => t.kind === "editor" && t.path === path && !t.ghost,
    );
    if (existing) {
      this.activate(existing.id);
      return;
    }
    for (const [gridId, session] of this.sessions) {
      if (session instanceof PaneGrid) {
        const loc = session.locateFile(path);
        if (loc) {
          this.activate(gridId);
          session.switchContentIn(loc.paneId, loc.index);
          return;
        }
      }
    }
    // Plain open routes into the file pane; Shift promotes to a tab; a full
    // pane overflows to a tab.
    if (!newTab) {
      const routeGrid = this.sessions.get(this.activeId ?? "");
      if (routeGrid instanceof PaneGrid) {
        const target = pickFileTarget(routeGrid.contentCandidates());
        if (target) {
          if (routeGrid.canAcceptFile(target)) {
            await this.switchPaneToFile(routeGrid, target, path, silent);
            return;
          }
          if (!silent) this.notify(t("ui.pane.overflowTab"));
        }
      }
    }
    const id = nextId();
    const name = basename(path);
    const openerId = this.activeId ?? undefined;
    const tab: EditorTab = {
      id,
      kind: "editor",
      title: name,
      path,
      dirty: false,
      lastUsedAt: Date.now(),
      pinned: false,
      openerId,
    };
    const openerIndex = openerId
      ? this.tabs.findIndex((t) => t.id === openerId)
      : -1;
    if (openerIndex >= 0) this.tabs.splice(openerIndex + 1, 0, tab);
    else this.tabs.push(tab);

    const container = document.createElement("div");
    container.className = "terminal-host editor-host";
    this.host.appendChild(container);

    let session: EditorSessionType | ImageSession | MediaSession;
    let paneKind: "image" | "media" | "editor";
    if (isImage(name)) {
      session = new ImageSession(id, path, container);
      paneKind = "image";
    } else if (mediaKind(name)) {
      session = new MediaSession(id, path, container);
      paneKind = "media";
    } else {
      const ES = await loadEditor();
      session = new ES(id, path, container, {
        fontFamily: fontStack(this.config.font.family, this.config.fonts),
        fontSize: this.config.font.size,
        palette: this.config.theme.terminal,
        preset: this.config.theme.preset,
        editor: this.config.editor,
        git: this.config.git,
      });
      session.onDirtyChange = (dirty) => this.setDirty(id, dirty);
      const editorSession = session;
      editorSession.onHistory = () => void this.openHistory(editorSession);
      editorSession.onSaveRequest = () => this.saveEditor(editorSession);
      paneKind = "editor";
    }
    this.sessions.set(id, session);
    this.logMetric("tab_created", {
      tabId: id,
      projectId: null,
      payload: JSON.stringify({ paneKind, has_project: false }),
    });
    this.trackNewTabDormancy(id);

    this.activeId = id;
    this.showActive();
    try {
      await session.open();
    } catch (e) {
      console.error("open file failed:", path, e);
      if (!silent) {
        this.notify(t("ui.app.cannotShowFile"));
      }
      await this.doCloseTab(id);
      return;
    }
    this.renderTabs();
    session.focus();
    this.persist();
    if (this.panelVisible) void this.openWorkspaceTree();
    this.setActiveProject(null);
  }

  private openGhostFile(path: string, content: string | null): Promise<void> {
    return this.enqueue(() => this.doOpenGhostFile(path, content));
  }

  // No genuinely read-only viewer exists in the app yet, so a ghost row opens
  // as an ordinary editor tab, wired with the HEAD content instead of a disk
  // read and locked to read-only inside EditorSession; the title marks it
  // as the committed snapshot so it never reads as the live (deleted) file.
  private async doOpenGhostFile(
    path: string,
    content: string | null,
  ): Promise<void> {
    if (content == null) {
      this.notify(t("ui.filetree.ghostUnavailable"));
      return;
    }
    const existing = this.tabs.find(
      (tab) => tab.kind === "editor" && tab.path === path && tab.ghost,
    );
    if (existing) {
      this.activate(existing.id);
      return;
    }
    const id = nextId();
    const name = basename(path);
    const tab: EditorTab = {
      id,
      kind: "editor",
      title: t("ui.filetree.headTabTitle", { name }),
      path,
      dirty: false,
      lastUsedAt: Date.now(),
      pinned: false,
      ghost: true,
    };
    this.tabs.push(tab);

    const container = document.createElement("div");
    container.className = "terminal-host editor-host";
    this.host.appendChild(container);

    const ES = await loadEditor();
    const session = new ES(id, path, container, {
      fontFamily: fontStack(this.config.font.family, this.config.fonts),
      fontSize: this.config.font.size,
      palette: this.config.theme.terminal,
      preset: this.config.theme.preset,
      editor: this.config.editor,
      git: this.config.git,
      readOnlyContent: content,
    });
    session.onHistory = () => void this.openHistory(session);
    this.sessions.set(id, session);
    this.logMetric("tab_created", {
      tabId: id,
      projectId: null,
      payload: JSON.stringify({ paneKind: "editor", has_project: false }),
    });
    this.trackNewTabDormancy(id);

    this.activeId = id;
    this.showActive();
    try {
      await session.open();
    } catch (e) {
      console.error("open ghost file failed:", path, e);
      this.notify(t("ui.app.cannotShowFile"));
      await this.doCloseTab(id);
      return;
    }
    this.renderTabs();
    session.focus();
    this.persist();
    this.setActiveProject(null);
  }

  private async makeFileContent(
    grid: PaneGrid,
    paneId: string,
    path: string,
  ): Promise<{
    session: EditorSessionType | ImageSession | MediaSession;
    container: HTMLElement;
    path: string;
    title: string;
  }> {
    const name = basename(path);
    const container = document.createElement("div");
    container.className = "terminal-host editor-host pane-content";
    let session: EditorSessionType | ImageSession | MediaSession;
    if (isImage(name)) {
      session = new ImageSession(paneId, path, container);
    } else if (mediaKind(name)) {
      session = new MediaSession(paneId, path, container);
    } else {
      const ES = await loadEditor();
      session = new ES(paneId, path, container, {
        fontFamily: fontStack(this.config.font.family, this.config.fonts),
        fontSize: this.config.font.size,
        palette: this.config.theme.terminal,
        preset: this.config.theme.preset,
        editor: this.config.editor,
        git: this.config.git,
      });
      session.onDirtyChange = (dirty) => grid.setContentDirty(paneId, dirty);
      const editorSession = session;
      editorSession.onHistory = () => void this.openHistory(editorSession);
      editorSession.onSaveRequest = () => this.saveEditor(editorSession);
    }
    return { session, container, path, title: name };
  }

  private paneRecents(): { rel: string; abs: string }[] {
    return this.tabs
      .filter((tab): tab is EditorTab => tab.kind === "editor" && !tab.ghost)
      .slice(-5)
      .reverse()
      .map((tab) => ({ rel: basename(tab.path), abs: tab.path }));
  }

  private async switchPaneToFile(
    grid: PaneGrid,
    paneId: string,
    path?: string,
    silent = false,
  ): Promise<void> {
    if (!path) {
      const container = document.createElement("div");
      const chooser = new PaneFileChooser(container, {
        recents: () => this.paneRecents(),
        onOpen: (abs) => void this.switchPaneToFile(grid, paneId, abs),
        onFind: () => this.openQuickOpen(),
        onBackToTerminal: () => grid.closeActiveContent(),
      });
      const added = grid.addFileContent(paneId, {
        session: chooser,
        container,
        title: t("ui.pane.fileTab"),
      });
      if (added) await chooser.open();
      else if (!silent) this.notify(t("ui.pane.paneFull"));
      return;
    }
    const handle = await this.makeFileContent(grid, paneId, path);
    try {
      await handle.session.open();
    } catch (e) {
      console.error("open file in pane failed:", path, e);
      if (!silent) this.notify(t("ui.app.cannotShowFile"));
      void handle.session.dispose();
      handle.container.remove();
      return;
    }
    // Replace an empty chooser slot in place; otherwise add a new slot. The
    // caller checks canAcceptFile first, so add only fails on a race.
    let placed = false;
    if (grid.activeContentIsChooser(paneId)) {
      grid.replaceActiveFile(paneId, handle);
      placed = true;
    } else if (grid.addFileContent(paneId, handle)) {
      placed = true;
    } else {
      void handle.session.dispose();
      handle.container.remove();
      if (!silent) this.notify(t("ui.pane.paneFull"));
    }
    if (placed && !silent) this.teachPaneFileOnce();
  }

  private async switchPaneToBrowser(
    grid: PaneGrid,
    paneId: string,
    url?: string,
  ): Promise<void> {
    const container = document.createElement("div");
    container.className = "terminal-host browser-host pane-content";
    const session = new BrowserSession(
      paneId,
      url ?? this.config.browser.home_url,
      container,
    );
    const added = grid.addFileContent(paneId, {
      session,
      container,
      path: session.path,
      title: t("ui.browser.title"),
      kind: "browser",
    });
    if (!added) {
      session.dispose();
      this.notify(t("ui.pane.paneFull"));
      return;
    }
    // A native child webview swallows key events once its page content (not
    // the chrome bar) holds focus, so ⌘W cannot be relied on to close it —
    // give it an always-clickable close button instead.
    session.onCloseRequest = () => void this.closeActiveContentGuarded(grid);
    try {
      await session.open();
    } catch (e) {
      grid.closeActiveContent();
      this.notify(errorMessage(e));
      return;
    }
    this.applyBrowserSessionConfig(session);
    this.syncNativeVisibility();
    // Creating the native webview steals first responder; pull keyboard focus
    // back into the app (its address bar, a DOM field in the main webview) so
    // shortcuts like pin and pane-switch keep working without a mouse click.
    session.focus();
    void browserReleaseFocus();
  }

  private resolveBrowserColorScheme(): "dark" | "light" {
    const prefersDark = window.matchMedia?.(
      "(prefers-color-scheme: dark)",
    ).matches;
    return resolveColorScheme(
      this.config.browser.color_scheme,
      this.config.theme.preset,
      !!prefersDark,
    );
  }

  private applyBrowserSessionConfig(session: BrowserSession): void {
    session.setColorScheme(this.resolveBrowserColorScheme());
    session.configureAutoHide(
      this.config.browser.auto_hide_chrome,
      this.config.browser.auto_hide_delay_ms,
    );
  }

  private applyBrowserSessionsConfig(): void {
    for (const s of this.sessions.values()) {
      if (!(s instanceof PaneGrid)) continue;
      for (const b of s.browserSessions()) {
        if (b.session instanceof BrowserSession)
          this.applyBrowserSessionConfig(b.session);
      }
    }
  }

  // The single authority every native child webview's visibility answers to
  // (browser panes and the HTML preview alike): it fails safe to hidden
  // whenever the pane is inactive, the content is not its pane's frontmost,
  // or any overlay/dialog/settings-adjacent surface is open (a native view
  // renders above all DOM and cannot be clipped, so it must be told
  // explicitly to get out of the way).
  private syncNativeVisibility(): void {
    const overlayOpen = overlaysOpen();
    for (const [id, s] of this.sessions) {
      if (!(s instanceof PaneGrid)) continue;
      const paneActive = id === this.activeId;
      for (const b of s.browserSessions()) {
        const contentFrontmost = s.activeContentSession(b.paneId) === b.session;
        if (b.session instanceof BrowserSession) {
          b.session.show(
            shouldShowBrowser({ paneActive, contentFrontmost, overlayOpen }),
          );
        }
      }
      for (const e of s.editorSessions()) {
        const frontmost = s.activeContentSession(e.paneId) === e.session;
        if (EditorSession !== null && e.session instanceof EditorSession) {
          e.session.setPreviewVisible(paneActive && frontmost && !overlayOpen);
        }
      }
    }
    // Pinned browsers/editors live outside the grids and stay visible across
    // every tab; only an overlay (which paints over a native view) hides them.
    for (const cell of this.pinCells) {
      if (cell?.session instanceof BrowserSession) {
        cell.session.show(!overlayOpen);
      } else if (
        EditorSession !== null &&
        cell?.session instanceof EditorSession
      ) {
        cell.session.setPreviewVisible(!overlayOpen);
      }
    }
    for (const [id, s] of this.sessions) {
      if (EditorSession !== null && s instanceof EditorSession) {
        s.setPreviewVisible(id === this.activeId && !overlayOpen);
      }
    }
  }

  private async restorePinDock(): Promise<void> {
    const saved = loadPinDock();
    for (let i = 0; i < saved.length && i < this.pinCells.length; i++) {
      const c = saved[i];
      if (!c) continue;
      if (c.kind === "browser") await this.openBrowserInCell(i, c.url);
      else if (c.kind === "timer") this.openTimerInCell(i, c.preset, c.name);
      else await this.openTerminalInCell(i);
    }
    // Only now may persist() write the dock — before this, an empty pinCells
    // would clobber the state we just read.
    this.pinDockRestored = true;
    this.persist();
  }

  private isActiveContentPinnable(): boolean {
    const grid = this.sessions.get(this.activeId ?? "");
    if (!(grid instanceof PaneGrid)) return false;
    const paneId = grid.activePaneId();
    return (
      grid.activeContentIsBrowser(paneId) || grid.activeContentIsFile(paneId)
    );
  }

  // ⌘⌃P toggles the whole dock: open it seeded with the active browser/file (or
  // a fresh browser) on top and the focus timer below; tear it all down when
  // anything is pinned. Per-cell ⌘W still closes one.
  private togglePinDock(): void {
    if (this.dockVisible()) {
      for (let i = 0; i < this.pinCells.length; i++)
        if (this.pinCells[i]) this.unpinCell(i);
      this.focusActive();
      return;
    }
    this.pinActiveContent();
    const timerIndex = this.pinCells.indexOf(null);
    if (timerIndex >= 0) this.openTimerInCell(timerIndex);
  }

  // Sends the active pane's content to the first free pinned cell, or — when
  // nothing pinnable is focused — seeds that cell with a fresh browser.
  private pinActiveContent(): void {
    const index = this.pinCells.indexOf(null);
    if (index < 0) {
      this.notify(t("ui.pin.full"));
      return;
    }
    const grid = this.sessions.get(this.activeId ?? "");
    if (grid instanceof PaneGrid && this.isActiveContentPinnable()) {
      const detached = grid.detachActiveContent();
      if (detached) {
        this.placeInCell(index, detached);
        this.refreshTreeIfVisible();
        // Showing the pinned browser re-grabs first responder; hand keyboard
        // focus back to the grid so pane navigation keeps working.
        grid.focus();
        void browserReleaseFocus();
        return;
      }
    }
    void this.openBrowserInCell(index);
  }

  private placeInCell(index: number, cell: PinnedCell): void {
    this.pinCells[index] = cell;
    const host = this.pinCellEls[index];
    host.querySelector(".pin-cell-add")?.remove();
    host.appendChild(cell.container);
    this.showPinDock();
    if (cell.session instanceof BrowserSession) {
      // Out of every grid now, so its own close button must unpin the cell.
      cell.session.onCloseRequest = () => this.unpinCell(index);
      // Persist the dock as the pinned browser navigates, so a restart restores
      // the page it was left on, not its home URL.
      cell.session.onTitle = () => this.persist();
      cell.session.syncBounds();
    }
    this.syncNativeVisibility();
    this.persist();
  }

  private addToPinDock(kind: "terminal" | "browser" | "timer"): void {
    // Fill the focused empty cell when the dock has keyboard focus, else the
    // first free cell — so ⌘⌃T/⌘⌃B/⌘⌃F land where the user is looking.
    const focused = this.focusedPin;
    const index =
      focused !== null && !this.pinCells[focused]
        ? focused
        : this.pinCells.indexOf(null);
    if (index < 0) {
      this.notify(t("ui.pin.full"));
      return;
    }
    if (kind === "timer") {
      this.openTimerInCell(index);
      this.focusPinCell(index);
      return;
    }
    const opened =
      kind === "terminal"
        ? this.openTerminalInCell(index)
        : this.openBrowserInCell(index);
    void opened.then(() => this.focusPinCell(index));
  }

  // The empty-cell picker: choose what independent content to place there.
  private openCellPicker(index: number): void {
    const { overlay, box, close } = createOverlay({
      className: "pane-picker",
      label: t("ui.pin.pickTitle"),
      onDismiss: () => void close(),
      // .pane-picker[data-closing] has no CSS transition (deliberately
      // instant), so there is no --modal-out to resolve against.
      closeDurationMs: 0,
    });
    const row = (label: string, hint: string, onClick: () => void) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "pane-picker-row";
      const name = document.createElement("span");
      name.textContent = label;
      const tag = document.createElement("span");
      tag.className = "pane-picker-hint";
      tag.textContent = hint;
      el.append(name, tag);
      el.addEventListener("click", () => {
        void close();
        onClick();
      });
      return el;
    };
    box.append(
      row(
        t("ui.pane.terminalSeg"),
        "⌘⌃T",
        () => void this.openTerminalInCell(index),
      ),
      row(
        t("ui.pane.addBrowser"),
        "⌘⌃B",
        () => void this.openBrowserInCell(index),
      ),
      row(t("ui.focus.add"), this.strokeFor("pin.timer"), () =>
        this.openTimerInCell(index),
      ),
    );
    document.body.appendChild(overlay);
    box.querySelector<HTMLButtonElement>(".pane-picker-row")?.focus();
  }

  private async openBrowserInCell(index: number, url?: string): Promise<void> {
    const container = document.createElement("div");
    container.className = "terminal-host browser-host pane-content";
    const session = new BrowserSession(
      `pin-browser-${index}`,
      url ?? this.config.browser.home_url,
      container,
    );
    this.placeInCell(index, {
      kind: "browser",
      session,
      container,
      path: session.path,
      title: t("ui.browser.title"),
    });
    try {
      await session.open();
    } catch (e) {
      this.unpinCell(index);
      this.notify(errorMessage(e));
      return;
    }
    this.applyBrowserSessionConfig(session);
    this.syncNativeVisibility();
    // A dock browser is background content; keep keyboard focus on the pane the
    // user is actually working in so shortcuts keep working.
    this.sessions.get(this.activeId ?? "")?.focus();
    void browserReleaseFocus();
  }

  private async openTerminalInCell(index: number): Promise<void> {
    const container = document.createElement("div");
    container.className = "terminal-host pane-content";
    const session = new TerminalSession(
      `pin-term-${index}-${crypto.randomUUID().slice(0, 8)}`,
      container,
      {
        fontFamily: fontStack(this.config.font.family, this.config.fonts),
        fontSize: this.config.font.size,
        render: this.config.render,
        theme: this.config.theme.terminal,
        keepAlive: this.config.session.keep_alive,
        activityThrottleMs:
          Math.max(1, this.config.tabs.activity_throttle_secs) * 1000,
        appOwnsKeystroke: (e) => this.keymap.ownsMetaKeystroke(e),
      },
    );
    session.onExit = () => this.unpinCell(index);
    this.placeInCell(index, {
      kind: "terminal",
      session,
      container,
      title: t("ui.pane.terminalSeg"),
    });
    await session.open();
    session.setVisible(true);
    session.fitAndResize();
  }

  // Resolves the focus timer's discoverable bindings from the live keymap —
  // never hardcoded — so a control tooltip or the panel legend always shows
  // whatever the user actually has bound (or drops the hint entirely once
  // they clear it).
  private focusCellShortcuts(): FocusCellShortcuts {
    return {
      toggle: this.strokeFor("timer.toggle"),
      skip: this.strokeFor("timer.skip"),
      reset: this.strokeFor("timer.reset"),
      panel: this.strokeFor("timer.panel"),
    };
  }

  private openTimerInCell(
    index: number,
    presetId?: string,
    name?: string,
  ): void {
    const container = document.createElement("div");
    container.className = "terminal-host pane-content";
    const cfg = presetId
      ? { ...this.config.focus, default_preset: presetId }
      : this.config.focus;
    const session = new FocusCell(
      `pin-timer-${index}`,
      container,
      cfg,
      this.config.theme.terminal.bg,
      this.config.metrics.enabled,
      { projectId: null, shireiSessionId: this.metricsSessionId },
      this.focusCellShortcuts(),
    );
    if (name) session.restoreName(name);
    session.onCloseRequest = () => this.unpinCell(index);
    session.onPhaseChange = (from, to) => this.fireFocusAlert(from, to);
    session.onPresetSaved = () => {
      void configSet(this.config);
      this.applyFocusCellsConfig(this.config);
    };
    session.onRename = () => this.persist();
    this.placeInCell(index, {
      kind: "timer",
      session,
      container,
      title: t("ui.focus.title"),
    });
    // Restored dock cells must never surprise-start: pinDockRestored is still
    // false while restorePinDock's loop is running, so only a cell opened by
    // an actual user action honors start_on_open.
    if (this.config.focus.start_on_open && this.pinDockRestored) {
      session.toggleStart();
    }
  }

  private fireFocusAlert(_from: Phase, to: Phase): void {
    const focus = this.config.focus;
    if (focus.alert_channel === "off") return;
    if (withinQuietHours(this.config.notifications.quiet_hours, new Date())) {
      return;
    }
    const body = t(
      to === "break" ? "notif.focus.toBreak" : "notif.focus.toFocus",
    );
    if (focus.alert_channel === "in-app") {
      showToast(body);
    } else {
      void notifyFire(t("ui.focus.title"), body).catch(() => {});
    }
    if (focus.alert_sound) playTimbre(focus.alert_timbre);
  }

  private unpinCell(index: number): void {
    const cell = this.pinCells[index];
    if (!cell) return;
    this.pinCells[index] = null;
    if (this.focusedPin === index) this.blurPinDock();
    // A pin cell owns its content: closing it kills the process (a keep_alive
    // terminal is torn down, not detached), unlike a tab which survives.
    if (cell.session instanceof TerminalSession)
      void cell.session.dispose(true);
    else void cell.session.dispose();
    cell.container.remove();
    this.showPinDock();
    this.syncNativeVisibility();
    this.refreshTreeIfVisible();
    this.persist();
  }

  private dockVisible(): boolean {
    return this.pinCells.some((c) => c !== null);
  }

  // Focus a dock cell whether it is filled or an empty "+" slot, so the keyboard
  // can reach an empty cell to add content into it. Only a filled terminal takes
  // real DOM focus (to type); a browser is background content and an empty cell
  // has nothing to focus — both stay keyboard-navigable at the app level.
  private focusPinCell(index: number): void {
    if (index < 0 || index >= this.pinCellEls.length || !this.dockVisible())
      return;
    this.focusedPin = index;
    this.pinCellEls.forEach((el, i) => {
      el.classList.toggle("pin-focused", i === index);
    });
    const cell = this.pinCells[index];
    if (cell?.kind === "terminal" || cell?.kind === "timer") {
      cell.session.focus();
    }
  }

  private blurPinDock(): void {
    this.focusedPin = null;
    for (const el of this.pinCellEls) el.classList.remove("pin-focused");
  }

  // Entering the dock lands on the top cell; the arrows reach the other from
  // there. Fails (so focus stays in the grid) when the dock is empty/hidden.
  private enterPinDock(): boolean {
    if (!this.dockVisible()) return false;
    this.focusPinCell(0);
    // Pull the keyboard off any pinned browser's webview so the dock's own keys
    // (Enter to add, ⌘⌃T/⌘⌃B, ⌘W) reach the app instead of the web page.
    void browserReleaseFocus();
    return true;
  }

  // Arrow navigation once the dock holds focus: up/down move between the two
  // stacked cells (empty or filled), left returns to the main grid.
  private navigateWithinDock(dir: FocusDir): boolean {
    if (dir === "left") {
      this.blurPinDock();
      this.focusActive();
      return true;
    }
    if (dir === "up") this.focusPinCell(0);
    else if (dir === "down") this.focusPinCell(1);
    void browserReleaseFocus();
    return true;
  }

  // ⌘W in the dock: a filled cell unpins, an empty one just exits — either way
  // focus returns to the working pane, mirroring how closing a file over a pane
  // reveals the terminal underneath, so ⌘W is never a silent no-op.
  private closeFocusedPin(): void {
    const index = this.focusedPin;
    if (index === null) return;
    if (this.pinCells[index]) this.unpinCell(index);
    this.focusActive();
  }

  // Enter on a focused empty cell opens its content picker (browser or terminal).
  private fillFocusedPin(): boolean {
    const index = this.focusedPin;
    if (index === null || this.pinCells[index]) return false;
    this.openCellPicker(index);
    return true;
  }

  // Empty cells invite content with a "+" and a hint; a filled cell shows its
  // content. The dock hides entirely when both cells are empty.
  private renderPinCells(): void {
    this.pinCellEls.forEach((host, index) => {
      if (this.pinCells[index]) {
        host.querySelector(".pin-cell-add")?.remove();
        return;
      }
      if (host.querySelector(".pin-cell-add")) return;
      const add = document.createElement("button");
      add.type = "button";
      add.className = "pin-cell-add";
      add.title = t("ui.pin.add");
      const plus = document.createElement("span");
      plus.className = "pin-cell-add-plus";
      plus.textContent = "+";
      const hint = document.createElement("span");
      hint.className = "pin-cell-add-hint";
      hint.textContent = t("ui.pin.addHint");
      add.append(plus, hint);
      add.addEventListener("click", () => this.openCellPicker(index));
      host.appendChild(add);
    });
  }

  private showPinDock(): void {
    const any = this.pinCells.some((c) => c !== null);
    this.pinSlotEl.classList.toggle("hidden", !any);
    this.pinDividerEl.classList.toggle("hidden", !any);
    this.renderPinCells();
    this.current()?.fitAndResize();
    this.syncPinBounds();
  }

  private attachPinResize(): void {
    attachDrag(this.pinDividerEl, {
      cursor: "col-resize",
      onMove: (ev) => {
        const rect = this.mainEl.getBoundingClientRect();
        if (!rect.width) return;
        const fraction = Math.max(
          this.config.layout.pin_min_fraction,
          Math.min(
            this.config.layout.pin_max_fraction,
            (rect.right - ev.clientX) / rect.width,
          ),
        );
        this.mainEl.style.setProperty(
          "--pin-width",
          `${(fraction * 100).toFixed(2)}%`,
        );
        this.current()?.fitAndResize();
        this.syncPinBounds();
      },
      onEnd: () => this.persistPinFraction(),
    });
  }

  private attachPinSplitResize(): void {
    attachDrag(this.pinSplitDividerEl, {
      cursor: "row-resize",
      onMove: (ev) => {
        const rect = this.pinSlotEl.getBoundingClientRect();
        if (!rect.height) return;
        const fraction = Math.max(
          0.2,
          Math.min(0.8, (ev.clientY - rect.top) / rect.height),
        );
        this.pinSlotEl.style.setProperty(
          "--pin-split",
          `${(fraction * 100).toFixed(2)}%`,
        );
        this.syncPinBounds();
      },
      onEnd: () => this.persistPinSplit(),
    });
  }

  private syncPinBounds(): void {
    for (const cell of this.pinCells) {
      if (cell?.session instanceof BrowserSession) cell.session.syncBounds();
      else if (cell?.session instanceof TerminalSession) {
        cell.session.fitAndResize();
      }
    }
  }

  private persistPinFraction(): void {
    const rect = this.mainEl.getBoundingClientRect();
    const slot = this.pinSlotEl.getBoundingClientRect();
    const fraction = rect.width ? slot.width / rect.width : 0.28;
    this.config = {
      ...this.config,
      layout: { ...this.config.layout, pin_width_fraction: fraction },
    };
    void configSet(this.config);
    this.current()?.fitAndResize();
    this.syncPinBounds();
  }

  private persistPinSplit(): void {
    const slot = this.pinSlotEl.getBoundingClientRect();
    const top = this.pinCellEls[0].getBoundingClientRect();
    const fraction = slot.height ? top.height / slot.height : 0.5;
    this.config = {
      ...this.config,
      layout: { ...this.config.layout, pin_split_fraction: fraction },
    };
    void configSet(this.config);
    this.syncPinBounds();
  }

  private teachPaneFileOnce(): void {
    if (localStorage.getItem("shirei.taught.paneFile")) return;
    localStorage.setItem("shirei.taught.paneFile", "1");
    this.notify(t("ui.pane.teachClose"));
  }

  private openPaneContentPicker(grid: PaneGrid, paneId: string): void {
    const { overlay, box, close } = createOverlay({
      className: "pane-picker",
      label: t("ui.pane.pickerTitle"),
      onDismiss: () => void close(),
      // .pane-picker[data-closing] has no CSS transition (deliberately
      // instant), so there is no --modal-out to resolve against.
      closeDurationMs: 0,
    });
    const row = (label: string, hint: string, onClick?: () => void) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "pane-picker-row";
      el.disabled = !onClick;
      const name = document.createElement("span");
      name.textContent = label;
      const tag = document.createElement("span");
      tag.className = "pane-picker-hint";
      tag.textContent = hint;
      el.append(name, tag);
      if (onClick)
        el.addEventListener("click", () => {
          void close();
          onClick();
        });
      return el;
    };
    box.append(
      row(t("ui.pane.addFile"), "⌘⌥T", () => {
        void this.switchPaneToFile(grid, paneId);
      }),
      this.config.browser.enabled
        ? row(t("ui.pane.addBrowser"), "⌘⌥B", () => {
            void this.switchPaneToBrowser(grid, paneId);
          })
        : row(t("ui.pane.addBrowser"), t("ui.pane.soon")),
    );
    document.body.appendChild(overlay);
    box
      .querySelector<HTMLButtonElement>(".pane-picker-row:not([disabled])")
      ?.focus();
  }

  activate(id: string): void {
    if (id === this.activeId || !this.sessions.has(id)) return;
    const previousId = this.activeId;
    this.activeId = id;
    this.showActive();
    this.renderTabs();
    void this.refreshMemoryBadge();
    this.focusActive();
    this.persist();
    if (this.panelVisible) void this.openWorkspaceTree();
    if (previousId) {
      const previousTab = this.tab(previousId);
      const previousProjectId =
        previousTab?.kind === "terminal"
          ? (previousTab.projectId ?? null)
          : null;
      this.logMetric("tab_deactivated", {
        tabId: previousId,
        projectId: previousProjectId,
      });
    }
    const tab = this.tab(id);
    const projectId = tab?.kind === "terminal" ? (tab.projectId ?? null) : null;
    this.logMetric("tab_activated", { tabId: id, projectId });
    this.feedDormancy(id, "shown");
    if (previousId) this.feedDormancy(previousId, "hidden");
    this.setActiveProject(projectId);
    this.syncNativeVisibility();
  }

  closeTab(id: string): Promise<void> {
    return this.enqueue(() => this.doCloseTab(id));
  }

  private async doCloseTab(id: string): Promise<void> {
    const tab = this.tab(id);
    if (tab?.kind === "editor" && tab.dirty) {
      const discard = await confirmDialog({
        title: t("ui.app.unsavedTitle", { name: tab.title }),
        detail: t("ui.app.unsavedDetail"),
        confirmLabel: t("ui.app.unsavedConfirm"),
      });
      if (!discard) return;
    }

    const session = this.sessions.get(id);
    if (!session) return;
    const index = this.tabs.findIndex((t) => t.id === id);

    const projectId = tab?.kind === "terminal" ? (tab.projectId ?? null) : null;
    this.logMetric("tab_closed", { tabId: id, projectId });
    this.untrackTabMetrics(id);
    this.autosaveState.delete(id);
    this.autosaveLastFiredAt.delete(id);

    this.sessions.delete(id);
    this.tabs = this.tabs.filter((t) => t.id !== id);
    if (projectId !== null) {
      const projectStillOpen = this.tabs.some(
        (t) => t.kind === "terminal" && t.projectId === projectId,
      );
      if (!projectStillOpen) this.logMetric("project_closed", { projectId });
    }

    if (session instanceof PaneGrid) await session.dispose();
    else session.dispose();

    if (this.tabs.length === 0) {
      this.activeId = null;
      this.persist();
      await invoke("close_active_window");
      return;
    }
    if (this.activeId === id) {
      // Editors live next to the tab that opened them, so closing one returns
      // there; otherwise `index` already points at the closed tab's successor.
      const opener =
        tab?.kind === "editor" && tab.openerId
          ? this.tabs.find((t) => t.id === tab.openerId)
          : undefined;
      const next =
        opener ?? this.tabs[index] ?? this.tabs[this.tabs.length - 1];
      this.activeId = next.id;
      this.showActive();
      this.focusActive();
    }
    this.renderTabs();
    this.persist();
  }

  rename(id: string, title: string): void {
    const tab = this.tab(id);
    if (!tab) return;
    tab.title = title.trim() || tab.title;
    this.renderTabs();
    this.persist();
  }

  recolor(id: string, color: string | null): void {
    const tab = this.tab(id);
    if (tab?.kind !== "terminal") return;
    tab.color = color;
    const grid = this.sessions.get(id);
    if (grid instanceof PaneGrid) grid.setAccent(color);
    this.renderTabs();
    this.persist();
  }

  private reorderTabs(orderedIds: string[]): void {
    const byId = new Map(this.tabs.map((t) => [t.id, t]));
    const next = orderedIds
      .map((id) => byId.get(id))
      .filter((t): t is TabState => t !== undefined);
    if (next.length !== this.tabs.length) return;
    this.tabs = next;
    this.renderTabs();
    this.persist();
  }

  private moveActiveTab(dir: number): void {
    if (!this.activeId || this.tabs.length < 2) return;
    const i = this.tabs.findIndex((t) => t.id === this.activeId);
    const j = i + dir;
    if (j < 0 || j >= this.tabs.length) return;
    const next = [...this.tabs];
    [next[i], next[j]] = [next[j], next[i]];
    this.tabs = next;
    this.renderTabs();
    this.persist();
  }

  private setDirty(id: string, dirty: boolean): void {
    const tab = this.tab(id);
    if (tab?.kind !== "editor" || tab.dirty === dirty) return;
    tab.dirty = dirty;
    this.renderTabs();
  }

  private notify(message: string): void {
    void messageDialog({ title: message });
  }

  private focusedPaneRect(): CssRect | null {
    const active = this.sessions.get(this.activeId ?? "");
    if (active instanceof PaneGrid) return active.activeRect();
    if (active) {
      const host = this.host.querySelector<HTMLElement>(
        ".terminal-host.active",
      );
      if (host) {
        const r = host.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      }
    }
    return null;
  }

  // The custom titlebar lives inside the webview, which fills the window with no
  // native chrome, so the viewport origin already coincides with the window
  // content origin: no extra offset to subtract.
  private titlebarOffset(): number {
    return 0;
  }

  private paletteCommands() {
    const currentTarget = this.current()
      ? ("panel" as const)
      : ("app" as const);
    const active = this.sessions.get(this.activeId ?? "");
    const editorCommands = this.isEditor(active)
      ? [
          {
            id: "git.history",
            name: t("cmd.git.history"),
            run: () => void this.openHistory(active),
          },
          {
            id: "git.blame-toggle",
            name: t("cmd.git.blame-toggle"),
            run: () => active.toggleBlame(),
          },
        ]
      : [];
    const previewEditor = this.activeFileEditor(active);
    const previewCommands = previewEditor?.isPreviewable()
      ? [
          {
            id: "editor.preview-toggle",
            name: t("ui.editor.preview.toggle"),
            run: () => void previewEditor.togglePreview(),
          },
        ]
      : [];
    const memoryCommands = this.config.memory.enabled
      ? [
          {
            id: "memory.open",
            name: t("cmd.memory.open"),
            run: () => void this.openProjectMemory("overview.md"),
          },
          {
            id: "memory.resume",
            name: t("cmd.memory.resume"),
            run: () =>
              this.sendMemoryPrompt(
                resolveTemplate(
                  this.config.memory.resume_prompt,
                  t("ui.memory.prompt.resume"),
                ),
              ),
          },
          {
            id: "memory.save_session",
            name: t("cmd.memory.save_session"),
            run: () =>
              this.sendMemoryPrompt(
                resolveTemplate(
                  this.config.memory.save_prompt,
                  t("ui.memory.prompt.save"),
                ),
              ),
          },
          {
            id: "memory.open_decisions",
            name: t("cmd.memory.open_decisions"),
            run: () => void this.openProjectMemory("decisions.md"),
          },
          {
            id: "memory.open_resume",
            name: t("cmd.memory.open_resume"),
            run: () => void this.openProjectMemory("resume.md"),
          },
          {
            id: "memory.open_sessions",
            name: t("cmd.memory.open_sessions"),
            run: () => void this.openProjectMemory("sessions"),
          },
        ]
      : [];
    return [
      ...editorCommands,
      ...previewCommands,
      ...memoryCommands,
      {
        id: "record.panel",
        name: t("ui.cmd.recordPanel"),
        run: async () => (await this.getScreencast()).recordWith("panel"),
      },
      {
        id: "record.app",
        name: t("ui.cmd.recordApp"),
        run: async () => (await this.getScreencast()).recordWith("app"),
      },
      {
        id: "record.region",
        name: t("ui.cmd.recordRegion"),
        run: async () => (await this.getScreencast()).recordWith("region"),
      },
      {
        id: "record.mp4",
        name: t("ui.cmd.recordMp4"),
        run: async () =>
          (await this.getScreencast()).recordWith(currentTarget, "mp4"),
      },
      {
        id: "record.gif",
        name: t("ui.cmd.recordGif"),
        run: async () =>
          (await this.getScreencast()).recordWith(currentTarget, "gif"),
      },
      {
        id: "record.folder",
        name: t("ui.cmd.openRecordingsFolder"),
        run: async () => (await this.getScreencast()).openRecordingsFolder(),
      },
    ];
  }

  private isEditor(
    s: PaneGrid | EditorSessionType | ImageSession | MediaSession | undefined,
  ): s is EditorSessionType {
    return EditorSession !== null && s instanceof EditorSession;
  }

  private async openHistory(session: EditorSessionType): Promise<void> {
    await this.gitHistory.open(session.path, {
      fontFamily: fontStack(this.config.font.family, this.config.fonts),
      fontSize: this.config.font.size,
      palette: this.config.theme.terminal,
      preset: this.config.theme.preset,
      editor: this.config.editor,
      defaultView: this.config.git.history.default_view,
    });
  }

  private async saveEditor(session: EditorSessionType): Promise<boolean> {
    const res = await session.save();
    if (res.conflict) {
      const overwrite = await confirmDialog({
        title: t("ui.app.fileChangedTitle"),
        detail: t("ui.app.fileChangedDetail"),
        confirmLabel: t("ui.app.fileChangedConfirm"),
      });
      if (!overwrite) return false;
      await session.saveForce();
      return true;
    }
    if (!res.ok && res.error) {
      this.notify(t("ui.app.saveFailed", { error: res.error }));
      return false;
    }
    return true;
  }

  private async saveActive(): Promise<void> {
    const s = this.sessions.get(this.activeId ?? "");
    if (this.isEditor(s)) {
      await this.saveEditor(s);
      return;
    }
    if (!(s instanceof PaneGrid)) return;
    const paneId = s.activePaneId();
    if (!s.activeContentIsFile(paneId)) return;
    const content = s.activeContentSession(paneId);
    if (EditorSession !== null && content instanceof EditorSession) {
      await this.saveEditor(content);
    }
  }

  private setPanelVisible(visible: boolean): void {
    const sidebarHadFocus =
      !visible && (this.tree.hasFocus() || this.todoFocused);
    this.panelVisible = visible;
    this.panelEl.classList.toggle("hidden", !visible);
    this.dividerEl.classList.toggle("hidden", !visible);
    this.syncSidebarButton();
    if (!visible) this.stopTreeWatch();
    if (sidebarHadFocus) this.focusActive();
  }

  private setActiveProject(projectId: string | null): void {
    const hasProject = projectId !== null;
    this.todoPanelEl.classList.toggle("hidden", !hasProject);
    void this.todoPanel.setProject(projectId);
    this.emitProjectFocusMetrics(projectId);
    this.todoProjectId = projectId;
    this.applyTodoCollapsed(this.resolveTodoCollapsed(projectId));
  }

  private resolveTodoCollapsed(projectId: string | null): boolean {
    const project = projectId
      ? this.projects.find((p) => p.id === projectId)
      : undefined;
    return project?.todo_collapsed ?? this.config.layout.todo_collapsed;
  }

  togglePanel(): void {
    this.setPanelVisible(!this.panelVisible);
    if (this.panelVisible) {
      void this.openWorkspaceTree();
      this.tree.focus();
    }
  }

  private treeHasFocus(): boolean {
    return this.panelVisible && this.tree.hasFocus();
  }

  private async revealInFinderHere(): Promise<void> {
    if (this.treeHasFocus()) {
      const sel = this.tree.selectedPath();
      if (sel) {
        await revealInFinder(sel).catch(() => {});
        return;
      }
    }
    const active = this.sessions.get(this.activeId ?? "");
    if (EditorSession !== null && active instanceof EditorSession) {
      await revealInFinder(active.path).catch(() => {});
      return;
    }
    const cwd = await this.activeCwd();
    if (cwd) await revealInFinder(cwd).catch(() => {});
  }

  private focusTodoPanel(): void {
    if (this.todoPanelEl.classList.contains("hidden")) return;
    if (!this.panelVisible) {
      this.setPanelVisible(true);
      void this.openWorkspaceTree();
    }
    this.todoFocused = true;
    this.blurPinDock();
    this.todoPanel.focus();
  }

  private blurTodoPanel(): void {
    this.todoFocused = false;
    this.todoPanel.blur();
  }

  private focusTree(): void {
    if (!this.panelVisible) {
      this.setPanelVisible(true);
      void this.openWorkspaceTree();
    }
    if (this.todoFocused) this.blurTodoPanel();
    this.blurPinDock();
    this.tree.focus();
  }

  private navigateFocus(
    dir: FocusDir,
    active:
      | PaneGrid
      | EditorSessionType
      | ImageSession
      | MediaSession
      | undefined,
  ): boolean {
    if (this.focusedPin !== null) return this.navigateWithinDock(dir);
    if (this.treeHasFocus()) {
      if (dir === "right") this.focusActive();
      return true;
    }
    if (active instanceof PaneGrid) {
      if (active.focusDir(dir)) return true;
      if (dir === "right" && this.enterPinDock()) return true;
      if (dir === "left") this.focusTree();
      return true;
    }
    if (dir === "right" && this.enterPinDock()) return true;
    if (
      dir === "left" &&
      !(EditorSession !== null && active instanceof EditorSession)
    ) {
      this.focusTree();
      return true;
    }
    return false;
  }

  private attachSidebarResize(): void {
    const main = this.dividerEl.parentElement as HTMLElement;
    attachDrag(this.dividerEl, {
      cursor: "col-resize",
      onMove: (ev) => {
        const rect = main.getBoundingClientRect();
        const max = rect.width * this.config.layout.sidebar_max_fraction;
        const width = Math.max(
          this.config.layout.sidebar_min_width,
          Math.min(max, ev.clientX - rect.left),
        );
        this.panelEl.style.width = `${width}px`;
        this.current()?.fitAndResize();
      },
      onEnd: () => {
        const width = Math.round(this.panelEl.getBoundingClientRect().width);
        this.config = {
          ...this.config,
          layout: { ...this.config.layout, sidebar_width: width },
        };
        void configSet(this.config);
        this.current()?.fitAndResize();
      },
    });
  }

  private applyTodoRatio(ratio: number): void {
    const clampedRatio = Math.max(0.1, Math.min(0.9, ratio));
    this.treeRegionEl.style.flex = `${1 - clampedRatio} 1 0`;
    this.todoPanelEl.style.flex = `${clampedRatio} 1 0`;
  }

  private applyTodoCollapsed(collapsed: boolean): void {
    this.todoCollapsed = collapsed;
    this.todoPanel.setCollapsed(collapsed);
    if (collapsed) {
      this.todoPanelEl.style.flex = "";
      this.treeRegionEl.style.flex = "1 1 0";
    } else {
      this.applyTodoRatio(this.config.layout.todo_region_ratio);
    }
    const hasProject = !this.todoPanelEl.classList.contains("hidden");
    this.todoDividerEl.classList.toggle("hidden", !hasProject || collapsed);
  }

  private setTodoCollapsed(collapsed: boolean): void {
    if (collapsed === this.todoCollapsed) return;
    if (collapsed && this.todoFocused) this.blurTodoPanel();
    this.applyTodoCollapsed(collapsed);
    this.persistTodoCollapsed(collapsed);
  }

  private persistTodoCollapsed(collapsed: boolean): void {
    if (this.todoProjectId) {
      const idx = this.config.projects.findIndex(
        (p) => p.id === this.todoProjectId,
      );
      if (idx === -1) return;
      this.config.projects[idx] = {
        ...this.config.projects[idx],
        todo_collapsed: collapsed,
      };
      this.projects = [...this.config.projects];
    } else {
      this.config = {
        ...this.config,
        layout: { ...this.config.layout, todo_collapsed: collapsed },
      };
    }
    void configSet(this.config);
  }

  private runTodoFocusDecision(decision: TodoFocusDecision): void {
    switch (decision) {
      case "expand-and-focus":
        this.setTodoCollapsed(false);
        this.focusTodoPanel();
        break;
      case "focus":
        this.focusTodoPanel();
        break;
      case "noop":
        break;
    }
  }

  private attachTodoDividerResize(): void {
    const panel = this.panelEl;

    attachDrag(this.todoDividerEl, {
      cursor: "row-resize",
      onMove: (ev) => {
        const rect = panel.getBoundingClientRect();
        if (rect.height === 0) return;
        const relY = ev.clientY - rect.top;
        const totalH = rect.height;
        const minPx = this.config.layout.todo_min_rows * TODO_ROW_HEIGHT_PX;
        const maxRatio = (totalH - minPx) / totalH;
        const minRatio = minPx / totalH;
        const rawRatio = 1 - relY / totalH;
        const ratio = Math.max(minRatio, Math.min(maxRatio, rawRatio));
        this.applyTodoRatio(ratio);
      },
      onEnd: () => {
        const rect = panel.getBoundingClientRect();
        if (rect.height === 0) return;
        const todoH = this.todoPanelEl.getBoundingClientRect().height;
        const ratio = todoH / rect.height;
        this.config = {
          ...this.config,
          layout: {
            ...this.config.layout,
            todo_region_ratio: Math.round(ratio * 1000) / 1000,
          },
        };
        void configSet(this.config);
      },
    });
  }

  private async openWorkspaceTree(): Promise<void> {
    const root = await this.activeWorkspaceRoot();
    if (!root) return;
    if (root !== this.treeRoot) {
      this.treeRoot = root;
      await this.tree.setRoot(root);
    } else {
      await this.tree.refresh();
    }
    if (root !== this.watchedRoot) {
      this.watchedRoot = root;
      void treeWatch(root).catch(() => {});
    }
    const filePath = this.activeFilePath();
    if (filePath) await this.tree.revealPath(filePath);
    this.refreshGitStatuses();
  }

  private stopTreeWatch(): void {
    if (this.watchedRoot === null) return;
    this.watchedRoot = null;
    void treeWatch(null).catch(() => {});
  }

  private async activeWorkspaceRoot(): Promise<string | null> {
    const filePath = this.activeFilePath();
    if (filePath) {
      const root = this.projectRootForPath(filePath) ?? parentDir(filePath);
      this.lastRoot = root;
      return root;
    }
    const live = await this.activeLiveCwd();
    if (live) {
      this.lastRoot = live;
      return live;
    }
    const known = this.activeLeafCwd();
    if (known) {
      this.lastRoot = known;
      return known;
    }
    if (this.lastRoot) return this.lastRoot;
    this.lastRoot = await homeDir();
    return this.lastRoot;
  }

  private async projectSearchRoot(): Promise<string> {
    const projectPath = this.activeSearchProjectPath();
    const openedFrom = this.activeOpenedFrom();
    const shellCwd =
      (await this.activeLiveCwd()) ?? this.activeLeafCwd() ?? null;
    const home = await homeDir();
    const root = resolveSearchRoot({ projectPath, openedFrom, shellCwd, home });
    return root;
  }

  private activeSearchProjectPath(): string | null {
    const fp = this.activeFilePath();
    if (fp) return this.projectRootForPath(fp);
    const tab = this.tab(this.activeId);
    if (tab?.kind === "terminal" && tab.projectId) {
      const p = this.projects.find((x) => x.id === tab.projectId);
      return p ? p.path.replace(/\/+$/, "") : null;
    }
    return null;
  }

  private activeOpenedFrom(): string | null {
    const fp = this.activeFilePath();
    return fp ? parentDir(fp) : null;
  }

  private activePtyId(): string | null {
    return this.activeGrid()?.activePtyId() ?? null;
  }

  private activeGrid(): PaneGrid | undefined {
    const active = this.activeId ? this.sessions.get(this.activeId) : undefined;
    if (active instanceof PaneGrid) return active;
    for (let i = this.tabs.length - 1; i >= 0; i--) {
      const s = this.sessions.get(this.tabs[i].id);
      if (s instanceof PaneGrid) return s;
    }
    return undefined;
  }

  private async activeLiveCwd(): Promise<string | undefined> {
    const ptyId = this.activePtyId();
    if (!ptyId) return undefined;
    return (await ptyCwd(ptyId).catch(() => null)) ?? undefined;
  }

  private activeLeafCwd(): string | undefined {
    return this.activeGrid()?.activeCwd();
  }

  private activeFilePath(): string | null {
    const tab = this.tab(this.activeId);
    return tab?.kind === "editor" ? tab.path : null;
  }

  private projectRootForPath(path: string): string | null {
    let best: string | null = null;
    for (const p of this.projects) {
      const root = p.path.replace(/\/+$/, "");
      if (
        (path === root || path.startsWith(`${root}/`)) &&
        (best === null || root.length > best.length)
      ) {
        best = root;
      }
    }
    return best;
  }

  private async activeCwd(): Promise<string | undefined> {
    return (await this.activeLiveCwd()) ?? this.activeLeafCwd();
  }

  private async openProjectMemory(
    file: "overview.md" | "decisions.md" | "resume.md" | "sessions",
  ): Promise<void> {
    if (!this.config.memory.enabled) {
      showToast(t("ui.memory.disabled"));
      return;
    }
    const cwd = await this.activeCwd();
    if (!cwd) {
      showToast(t("ui.memory.noCwd"));
      return;
    }
    let status: MemoryStatus;
    try {
      status = await memoryStatus(cwd);
    } catch (e) {
      this.notify(errorMessage(e));
      return;
    }
    if (
      !status.exists &&
      !(await confirmDialog({
        title: t("ui.memory.initConfirm"),
        confirmLabel: t("ui.memory.initConfirmLabel"),
        danger: false,
      }))
    ) {
      return;
    }
    let overview: string;
    try {
      overview = await memoryInit(cwd, {
        overview: resolveTemplate(
          this.config.memory.overview_skeleton,
          t("ui.memory.skeleton.overview"),
        ),
        decisions: resolveTemplate(
          this.config.memory.decisions_header,
          t("ui.memory.skeleton.decisions"),
        ),
      });
    } catch (e) {
      this.notify(errorMessage(e));
      return;
    }
    await this.activateProjectDocs(cwd);
    const dir = overview.slice(0, -"overview.md".length);
    if (file === "sessions") {
      await this.revealDir(`${dir}sessions`);
    } else {
      await this.openFile(`${dir}${file}`, { newTab: false });
    }
    await this.refreshMemoryBadge();
  }

  // Registering the MCP server is user-scoped and only makes the tools reachable. CLIs that
  // defer MCP tools need a line in the project's instructions file before their model looks
  // them up, so activating memory here also lands that block in every registered CLI's file.
  private async activateProjectDocs(cwd: string): Promise<void> {
    const block = resolveTemplate(
      this.config.memory.project_doc_block,
      t("ui.memory.projectDoc.block"),
    );
    let docs: MemoryProjectDoc[];
    try {
      docs = await memoryProjectPreview(cwd, block);
    } catch (e) {
      this.notify(errorMessage(e));
      return;
    }
    const pending = docs.filter((d) => d.state !== "current");
    if (pending.length === 0) return;
    const confirmed = await confirmDialog({
      title: t("ui.memory.projectDoc.confirm"),
      detail: pending
        .map((d) => `${d.doc_path}  ·  ${d.adapters.join(", ")}`)
        .join("\n"),
      confirmLabel: t("ui.memory.projectDoc.confirmLabel"),
      danger: false,
    });
    if (!confirmed) return;
    try {
      const written = await memoryProjectActivate(cwd, block);
      if (written.length > 0) {
        showToast(t("ui.memory.projectDoc.done", { count: written.length }));
      }
    } catch (e) {
      this.notify(errorMessage(e));
    }
  }

  private sendMemoryPrompt(prompt: string): void {
    if (!this.config.memory.enabled) {
      showToast(t("ui.memory.disabled"));
      return;
    }
    this.activeGrid()?.sendLineActive(promptLine(prompt));
  }

  // The safety net for when the agent forgets to save on its own: types the
  // save prompt into the terminal on a high-confidence "done", scoped to the
  // active tab only. A "waiting" agent is asking the user something, so it is
  // deliberately excluded even though tabSessionStates() would surface it —
  // typing the save prompt there would answer the agent's own prompt with
  // prose instead of a real answer.
  private maybeAutosaveMemory(): void {
    if (!this.config.memory.enabled || !this.config.memory.autosave) return;
    const tab = this.tab(this.activeId);
    if (!tab) return;
    const entry = this.tabSessionStates().get(tab.id);
    const prev = this.autosaveState.get(tab.id);
    if (entry) this.autosaveState.set(tab.id, entry.state);
    else this.autosaveState.delete(tab.id);
    if (!entry) return;

    const cooldownMin = this.config.memory.autosave_cooldown_min;
    const lastFiredAt = this.autosaveLastFiredAt.get(tab.id);
    if (
      !shouldAutosave(
        prev,
        entry.state,
        entry.confidence,
        lastFiredAt,
        cooldownMin,
        Date.now(),
      )
    ) {
      return;
    }

    void this.fireAutosave(tab.id);
  }

  private async fireAutosave(tabId: string): Promise<void> {
    try {
      const cwd = await this.activeCwd();
      if (!cwd) return;
      const status = await memoryStatus(cwd);
      if (!status.exists || this.activeId !== tabId) return;
      this.autosaveLastFiredAt.set(tabId, Date.now());
      this.activeGrid()?.sendLineActive(
        promptLine(
          resolveTemplate(
            this.config.memory.save_prompt,
            t("ui.memory.prompt.save"),
          ),
        ),
      );
    } catch {
      // Fires on a background poll, not a user action: swallow IPC errors.
    }
  }

  // Seeds project memory the first time an agent finishes work in a project
  // that has none, scoped to the active tab and fired once per project root
  // for the app's lifetime so a declining agent is not nagged on every idle.
  private maybeBootstrapMemory(): void {
    if (!this.config.memory.enabled || !this.config.memory.bootstrap_auto) {
      return;
    }
    const tab = this.tab(this.activeId);
    if (!tab) return;
    const entry = this.tabSessionStates().get(tab.id);
    const prev = this.bootstrapState.get(tab.id);
    if (entry) this.bootstrapState.set(tab.id, entry.state);
    else this.bootstrapState.delete(tab.id);
    if (!entry) return;
    if (entry.state.kind !== "done" || entry.confidence !== "high") return;
    if (prev?.kind === "done") return;

    void this.fireBootstrap(tab.id, prev, entry.state, entry.confidence);
  }

  private async fireBootstrap(
    tabId: string,
    prev: SessionState | undefined,
    next: SessionState,
    confidence: Confidence,
  ): Promise<void> {
    try {
      const cwd = await this.activeCwd();
      if (!cwd) return;
      const alreadySeeded = this.bootstrappedProjects.has(cwd);
      const status = alreadySeeded ? null : await memoryStatus(cwd);
      if (
        !shouldBootstrapMemory(
          this.activeId === tabId,
          status,
          prev,
          next,
          confidence,
          alreadySeeded,
        )
      ) {
        return;
      }
      this.bootstrappedProjects.add(cwd);
      this.activeGrid()?.sendLineActive(
        promptLine(
          resolveTemplate(
            this.config.memory.bootstrap_prompt,
            t("ui.memory.prompt.bootstrap"),
          ),
        ),
      );
    } catch {
      // Fires on a background poll, not a user action: swallow IPC errors.
    }
  }

  private async syncMemoryDefaults(): Promise<void> {
    try {
      await memoryWriteDefaults(
        resolveTemplate(
          this.config.memory.overview_skeleton,
          t("ui.memory.skeleton.overview"),
        ),
        resolveTemplate(
          this.config.memory.decisions_header,
          t("ui.memory.skeleton.decisions"),
        ),
      );
    } catch (e) {
      console.error("failed to sync memory defaults", e);
    }
  }

  private async refreshMemoryBadge(): Promise<void> {
    const tab = this.tab(this.activeId);
    if (!tab) return;
    const cwd = this.config.memory.enabled ? await this.activeCwd() : undefined;
    const status = cwd ? await memoryStatus(cwd).catch(() => null) : null;
    const next = memoryBadgeState(
      status,
      this.config.memory.resume_stale_hours,
    );
    if (tab.memory === next) return;
    tab.memory = next;
    this.renderTabs();
  }

  private treeChangeTimer: number | null = null;

  private onTreeChanged(): void {
    if (this.treeChangeTimer !== null)
      window.clearTimeout(this.treeChangeTimer);
    this.treeChangeTimer = window.setTimeout(() => {
      this.treeChangeTimer = null;
      void this.refreshMemoryBadge();
      if (this.panelVisible) void this.tree.refresh();
      this.refreshGitStatuses();
    }, 120);
  }

  /** Single-flight, debounced entry point for every git-status refresh
   *  trigger: the tree watcher, the dedicated `git-changed` event, window
   *  focus, and project/root switches. */
  private refreshGitStatuses(): void {
    if (this.gitStatusTimer !== null) window.clearTimeout(this.gitStatusTimer);
    this.gitStatusTimer = window.setTimeout(
      () => {
        this.gitStatusTimer = null;
        void this.runGitStatusRefresh();
      },
      Math.max(0, this.config.git.status.refresh_debounce_ms),
    );
  }

  private async runGitStatusRefresh(): Promise<void> {
    const decision = gitRefreshDecision({
      statusInTree: this.config.git.status.status_in_tree,
      root: this.treeRoot,
      panelVisible: this.panelVisible,
      inFlight: this.gitStatusInFlight,
    });
    if (decision === "skip") return;
    if (decision === "defer") {
      // A fetch is already running: dropping this trigger outright would
      // leave the tree stale until an unrelated event happens to fire, so
      // remember it and re-arm the debounce once the in-flight one settles.
      this.gitStatusPending = true;
      return;
    }
    const root = this.treeRoot as string;
    this.gitStatusInFlight = true;
    try {
      const report = await gitStatuses(root);
      this.tree.setStatuses(report, root);
    } catch {
      // A directory that is not a git repo is the common case, not an error
      // to surface.
    } finally {
      this.gitStatusInFlight = false;
      if (this.gitStatusPending) {
        this.gitStatusPending = false;
        this.refreshGitStatuses();
      }
    }
  }

  private refreshTreeIfVisible(): void {
    if (this.panelVisible) void this.openWorkspaceTree();
  }

  private activeProject(): { id: string; name: string; color: string } | null {
    const tab = this.tab(this.activeId);
    if (tab?.kind !== "terminal" || !tab.projectId) return null;
    const project = this.projects.find((p) => p.id === tab.projectId);
    if (!project) return null;
    return { id: project.id, name: project.name, color: project.color };
  }

  private openTodoCapture(): void {
    const project = this.activeProject();
    const projectId = project?.id ?? null;
    openTodoModal({
      project,
      listVisible: this.panelVisible,
      onSaved: () => void this.todoPanel.setProject(projectId),
    });
  }

  private openTodoEdit(todo: Todo): void {
    const project = this.activeProject();
    const projectId = project?.id ?? null;
    openTodoModal({
      project,
      editing: todo,
      onSaved: () => void this.todoPanel.setProject(projectId),
    });
  }

  private async openQuickOpen(): Promise<void> {
    const projectRoot = await this.projectSearchRoot();
    const home = await homeDir();
    const project = this.activeProject();
    const roots: ScopeRoots = {
      project: projectRoot,
      home,
      projectLabel: project?.name ?? (basename(projectRoot) || "project"),
      projectColor: project?.color ?? null,
    };
    void this.quickopen.open(
      roots,
      this.projects,
      this.config.limits.quickopen_results,
      {
        defaultScope: this.config.quickopen.default_scope,
        toggleKey: this.config.quickopen.toggle_scope,
      },
    );
  }

  private async revealDir(path: string): Promise<void> {
    if (!this.panelVisible) this.setPanelVisible(true);
    await this.openWorkspaceTree();
    await this.tree.revealPath(path);
    this.tree.focus();
  }

  private activeFileEditor(
    active:
      | PaneGrid
      | EditorSessionType
      | ImageSession
      | MediaSession
      | undefined,
  ): EditorSessionType | undefined {
    if (EditorSession !== null && active instanceof EditorSession)
      return active;
    if (active instanceof PaneGrid) {
      const paneId = active.activePaneId();
      if (active.activeContentIsFile(paneId)) {
        const content = active.activeContentSession(paneId);
        if (EditorSession !== null && content instanceof EditorSession)
          return content;
      }
    }
    return undefined;
  }

  private onKey(e: KeyboardEvent): void {
    this.noteActivity();
    const active = this.sessions.get(this.activeId ?? "");
    if (
      active instanceof MediaSession &&
      e.key === " " &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !(e.target instanceof HTMLMediaElement)
    ) {
      e.preventDefault();
      active.togglePlay();
      return;
    }
    // Enter on a focused empty dock cell opens its content picker. Enter carries
    // no modifier so it never reaches the keymap; handled here directly.
    if (
      this.focusedPin !== null &&
      e.key === "Enter" &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !(
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) &&
      this.fillFocusedPin()
    ) {
      e.preventDefault();
      return;
    }
    if (this.todoFocused) {
      const ks = eventToKeystroke(e);
      if (ks) {
        const action = this.keymap.resolve(ks, { pane: false });
        if (action === "todo.focus") {
          e.preventDefault();
          this.runTodoFocusDecision(
            decideTodoFocusAction(this.todoCollapsed, this.todoFocused),
          );
          return;
        }
        if (action === "todo.capture") {
          e.preventDefault();
          this.dispatch("todo.capture", active);
          return;
        }
      }
      if (this.todoPanel.handleKey(e)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
    const ks = eventToKeystroke(e);
    if (!ks) return;
    // Select-all in a file editor runs on the document state, not the rendered
    // viewport, so a 1000-line file selects in full. Intercepted ahead of the
    // keymap so it wins over the terminal's own binding when a file is layered
    // over a pane. Copy is deliberately NOT handled here: it belongs to the
    // editor's own clipboard-event handler, which fills the pasteboard
    // synchronously from the state. A focused text field (the editor's search
    // box, rename, quick open) keeps its native select — that must act on the
    // field, not the document.
    const inField =
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement;
    if (!inField && ks.meta && !ks.ctrl && !ks.alt && !ks.shift) {
      const editor = ks.key === "a" ? this.activeFileEditor(active) : undefined;
      if (editor) {
        e.preventDefault();
        editor.selectAll();
        return;
      }
    }
    const action = this.keymap.resolve(ks, {
      pane: active instanceof PaneGrid,
    });
    if (!action) return;
    // These pane keys act on the terminal (copy line, paste, scroll). When a
    // file content is layered over the terminal, they belong to the focused
    // editor instead, so let the keystroke reach it unhandled.
    if (
      TERMINAL_CONTENT_ACTIONS.has(action) &&
      active instanceof PaneGrid &&
      active.activeContentIsFile(active.activePaneId())
    ) {
      return;
    }
    if (
      BROWSER_CONTENT_ACTIONS.has(action) &&
      !(
        active instanceof PaneGrid &&
        active.activeContentIsBrowser(active.activePaneId())
      )
    ) {
      return;
    }
    e.preventDefault();
    this.dispatch(action, active);
  }

  private dispatch(
    action: string,
    active:
      | PaneGrid
      | EditorSessionType
      | ImageSession
      | MediaSession
      | undefined,
  ): void {
    const pane = active instanceof PaneGrid ? active : undefined;
    switch (action) {
      case "tab.new":
        void this.newTab();
        break;
      case "tab.close":
        void this.closeActive();
        break;
      case "tab.close-tab":
        void this.closeTabActive();
        break;
      case "tab.prev":
        this.cycle(-1);
        break;
      case "tab.next":
        this.cycle(1);
        break;
      case "tab.move-prev":
        this.moveActiveTab(-1);
        break;
      case "tab.move-next":
        this.moveActiveTab(1);
        break;
      case "tab.pin":
        if (this.activeId) this.togglePin(this.activeId);
        break;
      case "palette.open":
        void this.openQuickOpen();
        break;
      case "panel.toggle":
        this.togglePanel();
        break;
      case "finder.reveal":
        void this.revealInFinderHere();
        break;
      case "tree.refresh":
        this.refreshTreeIfVisible();
        break;
      case "font.inc":
        this.setFontSize(this.fontSize + 1);
        break;
      case "font.dec":
        this.setFontSize(this.fontSize - 1);
        break;
      case "font.reset":
        this.setFontSize(DEFAULT_FONT_SIZE);
        break;
      case "scroll.up":
        pane?.scrollActive(-3);
        break;
      case "scroll.down":
        pane?.scrollActive(3);
        break;
      case "terminal.copy-line":
        pane?.copyLineActive();
        break;
      case "terminal.paste":
        pane?.pasteActive();
        break;
      case "statusbar.toggle":
        this.toggleStatusbar();
        break;
      case "record.start":
        void this.getScreencast().then((s) => s.toggle());
        break;
      case "render.recover":
        // Once the WebGL fuse has tripped, the leaked contexts only come back on
        // a webview reload; a per-pane recover would just fail to acquire one.
        if (webglPool.isExhausted()) window.location.reload();
        else pane?.recoverRenderers(true);
        break;
      case "logs.reveal":
        void revealLogs();
        break;
      case "git.history":
        if (this.isEditor(active)) void this.openHistory(active);
        break;
      case "git.blame-toggle":
        if (this.isEditor(active)) active.toggleBlame();
        break;
      case "memory.open":
        void this.openProjectMemory("overview.md");
        break;
      case "memory.open_decisions":
        void this.openProjectMemory("decisions.md");
        break;
      case "memory.open_resume":
        void this.openProjectMemory("resume.md");
        break;
      case "memory.open_sessions":
        void this.openProjectMemory("sessions");
        break;
      case "memory.resume":
        this.sendMemoryPrompt(
          resolveTemplate(
            this.config.memory.resume_prompt,
            t("ui.memory.prompt.resume"),
          ),
        );
        break;
      case "memory.save_session":
        this.sendMemoryPrompt(
          resolveTemplate(
            this.config.memory.save_prompt,
            t("ui.memory.prompt.save"),
          ),
        );
        break;
      case "editor.vim-toggle":
        this.toggleVim();
        break;
      case "editor.preview-toggle":
        void this.activeFileEditor(active)?.togglePreview();
        break;
      case "session.save":
        void this.saveActive();
        break;
      case "layout.save":
        this.saveProjectLayout();
        break;
      case "template.save":
        void this.saveAsTemplate();
        break;
      case "session.reconnect":
        if (pane) pane.reconnectActive();
        break;
      case "session.kill":
        if (pane) void this.killActiveSession(pane);
        break;
      case "pane.split-h":
        if (pane) void pane.split("h");
        break;
      case "pane.split-v":
        if (pane) void pane.split("v");
        break;
      case "pane.zoom":
        if (pane) pane.toggleZoom();
        break;
      case "pane.content.pick":
        if (pane) this.openPaneContentPicker(pane, pane.activePaneId());
        break;
      case "pane.content.cycle":
        if (pane) pane.cycleContent(1);
        break;
      case "pane.content.close":
        if (pane) pane.closeActiveContent();
        break;
      case "pane.content.slot-1":
        if (pane) pane.switchContent(0);
        break;
      case "pane.content.slot-2":
        if (pane) pane.switchContent(1);
        break;
      case "pane.content.slot-3":
        if (pane) pane.switchContent(2);
        break;
      case "focus.left":
        this.navigateFocus("left", active);
        break;
      case "focus.right":
        this.navigateFocus("right", active);
        break;
      case "focus.up":
        this.navigateFocus("up", active);
        break;
      case "focus.down":
        this.navigateFocus("down", active);
        break;
      case "tree.focus":
        if (this.treeHasFocus()) this.setPanelVisible(false);
        else this.focusTree();
        break;
      case "todo.focus":
        this.runTodoFocusDecision(
          decideTodoFocusAction(this.todoCollapsed, this.todoFocused),
        );
        break;
      case "todo.collapse":
        this.setTodoCollapsed(!this.todoCollapsed);
        break;
      case "todo.capture":
        this.openTodoCapture();
        break;
      case "browser.open":
        if (pane) void this.switchPaneToBrowser(pane, pane.activePaneId());
        break;
      case "pane.pin":
        this.togglePinDock();
        break;
      case "pin.terminal":
        this.addToPinDock("terminal");
        break;
      case "pin.browser":
        this.addToPinDock("browser");
        break;
      case "pin.timer":
        this.addToPinDock("timer");
        break;
      case "timer.toggle":
        this.activeFocusCell()?.toggleStart();
        break;
      case "timer.skip":
        this.activeFocusCell()?.skip();
        break;
      case "timer.reset":
        this.activeFocusCell()?.reset();
        break;
      case "timer.rename":
        this.activeFocusCell()?.startRename();
        break;
      case "timer.panel":
        this.activeFocusCell()?.openPanel();
        break;
      case "timer.focusCell": {
        const index = this.timerCellIndex();
        if (index >= 0) this.focusPinCell(index);
        break;
      }
      case "browser.focus-url":
        this.activeBrowser(pane)?.focus();
        break;
      case "browser.back": {
        const s = this.activeBrowser(pane);
        if (s) void browserBack(s.label);
        break;
      }
      case "browser.forward": {
        const s = this.activeBrowser(pane);
        if (s) void browserForward(s.label);
        break;
      }
      case "browser.reload": {
        const s = this.activeBrowser(pane);
        if (s) void browserReload(s.label);
        break;
      }
      case "orchestration.open":
        this.toggleOrchestration();
        break;
      case "orchestration.goto-waiting":
        this.gotoWhoNeedsMe();
        break;
      case "orchestration.next-waiting":
        this.cycleWaiting(1);
        break;
      case "orchestration.prev-waiting":
        this.cycleWaiting(-1);
        break;
    }
  }

  private activeBrowserSession(pane?: PaneGrid): BrowserSession | undefined {
    if (!pane) return undefined;
    const session = pane.activeContentSession(pane.activePaneId());
    return session instanceof BrowserSession ? session : undefined;
  }

  // The browser the user is looking at, for controls routed through the native
  // menu (so ⌘[/⌘]/reload/⌘L survive a focused webview). A keyboard-focused
  // pinned browser wins; otherwise, when a child webview holds first responder
  // (`document.hasFocus()` is false) and there is a single pinned browser, it is
  // unambiguously that one; else the active grid pane's browser.
  private pinnedBrowserCells(): { session: BrowserSession; index: number }[] {
    const out: { session: BrowserSession; index: number }[] = [];
    this.pinCells.forEach((cell, index) => {
      if (cell?.session instanceof BrowserSession)
        out.push({ session: cell.session, index });
    });
    return out;
  }

  private activeBrowser(pane?: PaneGrid): BrowserSession | undefined {
    if (this.focusedPin !== null) {
      const cell = this.pinCells[this.focusedPin];
      if (cell?.session instanceof BrowserSession) return cell.session;
    }
    if (!document.hasFocus()) {
      const pinned = this.pinnedBrowserCells();
      if (pinned.length === 1) return pinned[0].session;
    }
    return this.activeBrowserSession(pane);
  }

  // The timer keyboard shortcuts operate on the keyboard-focused dock cell when
  // it holds one, else the first pinned timer — so ⌘⌃Space/⌘⌃S/⌘⌃0 always reach
  // a timer when exactly one is pinned, and the focused one when there are two.
  private timerCellIndex(): number {
    if (
      this.focusedPin !== null &&
      this.pinCells[this.focusedPin]?.kind === "timer"
    ) {
      return this.focusedPin;
    }
    return this.pinCells.findIndex((cell) => cell?.kind === "timer");
  }

  private activeFocusCell(): FocusCell | undefined {
    const index = this.timerCellIndex();
    const cell = index >= 0 ? this.pinCells[index] : null;
    return cell?.session instanceof FocusCell ? cell.session : undefined;
  }

  private async guardDirtyContent(
    grid: PaneGrid,
    paneId: string,
  ): Promise<boolean> {
    if (!grid.activeContentDirty(paneId)) return true;
    const session = grid.activeContentSession(paneId);
    const choice = await choiceDialog({
      title: t("ui.close.saveTitle", { name: grid.activeContentTitle(paneId) }),
      detail: t("ui.close.saveDetail"),
      choices: [
        { label: t("ui.close.save"), value: "save" },
        { label: t("ui.close.discard"), value: "discard", danger: true },
      ],
    });
    if (choice === null) return false;
    if (
      choice === "save" &&
      EditorSession !== null &&
      session instanceof EditorSession
    ) {
      return this.saveEditor(session);
    }
    return true;
  }

  private async closeActiveContentGuarded(grid: PaneGrid): Promise<void> {
    const paneId = grid.activePaneId();
    if (await this.guardDirtyContent(grid, paneId)) grid.closeActiveContent();
  }

  private async confirmDiscardDirty(grid: PaneGrid): Promise<boolean> {
    if (!grid.hasDirtyContent()) return true;
    return confirmDialog({
      title: t("ui.close.dirtyTitle"),
      detail: t("ui.close.dirtyDetail"),
      confirmLabel: t("ui.close.discard"),
    });
  }

  private async closeActive(): Promise<void> {
    // A focused pinned dock cell closes first, wherever ⌘W came from — the app's
    // own keydown or the native menu accelerator that fires while a pinned
    // browser's webview holds focus. Same close-and-reveal flow as a content
    // pane: the cell empties and focus returns to the working pane.
    if (this.focusedPin !== null) {
      this.closeFocusedPin();
      return;
    }
    const active = this.sessions.get(this.activeId ?? "");
    const gridBrowserFocused =
      active instanceof PaneGrid &&
      active.activeContentIsBrowser(active.activePaneId());
    // A pinned browser focused by mouse holds the webview first responder, so the
    // main document reports no focus; ⌘W then closes that browser (unambiguous
    // when it is the only pinned browser and the grid isn't itself showing a
    // browser) instead of a background grid pane.
    if (!document.hasFocus() && !gridBrowserFocused) {
      const pinned = this.pinnedBrowserCells();
      if (pinned.length === 1) {
        this.focusedPin = pinned[0].index;
        this.closeFocusedPin();
        return;
      }
    }
    // ⌘W closes the frontmost thing: a file or browser layered over a terminal
    // closes and reveals the terminal, leaving the tab in place.
    if (
      active instanceof PaneGrid &&
      (active.activeContentIsFile(active.activePaneId()) ||
        active.activeContentIsBrowser(active.activePaneId()))
    ) {
      await this.closeActiveContentGuarded(active);
      return;
    }
    if (!(active instanceof PaneGrid)) {
      if (this.activeId) void this.closeTab(this.activeId);
      return;
    }
    if (!(await this.confirmDiscardDirty(active))) {
      active.focus();
      return;
    }
    const tabId = this.activeId;
    const paneCount = active.leafIds().length;
    const { confirm, proc } = await this.evalConfirm(
      this.config.session.confirm_close,
      active.activePtyId(),
    );
    if (confirm && paneCount > 1 && tabId) {
      const choice = await choiceDialog({
        title: t("ui.close.whatTitle"),
        detail: proc
          ? t("ui.close.whatDetailProc", { proc, count: paneCount })
          : t("ui.close.whatDetailPlain", { count: paneCount }),
        choices: [
          { label: t("ui.close.closeTerminal"), value: "pane", danger: true },
          { label: t("ui.close.closeTab"), value: "tab", danger: true },
        ],
      });
      if (choice === null) {
        active.focus();
        return;
      }
      if (choice === "tab") {
        void this.closeTab(tabId);
        return;
      }
      active.closePane();
      return;
    }
    if (confirm) {
      const ok = await confirmDialog({
        title: t("ui.close.terminalTitle"),
        detail: proc
          ? t("ui.close.terminalDetailProc", { proc })
          : t("ui.close.detailLoseRunning"),
        confirmLabel: t("ui.close.terminalConfirm"),
      });
      if (!ok) {
        active.focus();
        return;
      }
    }
    active.closePane();
  }

  private async closeTabActive(): Promise<void> {
    const tabId = this.activeId;
    if (!tabId) return;
    const active = this.sessions.get(tabId);
    if (!(active instanceof PaneGrid)) {
      void this.closeTab(tabId);
      return;
    }
    if (!(await this.confirmDiscardDirty(active))) {
      active.focus();
      return;
    }
    const { confirm, proc, count } = await this.evalConfirmTab(active);
    if (confirm) {
      const ok = await confirmDialog({
        title: t("ui.close.tabTitle"),
        detail:
          count > 1
            ? t("ui.close.tabDetailMany", { count })
            : proc
              ? t("ui.close.tabDetailProc", { proc })
              : t("ui.close.detailLoseRunning"),
        confirmLabel: t("ui.close.tabConfirm"),
      });
      if (!ok) {
        active.focus();
        return;
      }
    }
    void this.closeTab(tabId);
  }

  private async killActiveSession(grid: PaneGrid): Promise<void> {
    const { confirm, proc } = await this.evalConfirm(
      this.config.session.confirm_kill,
      grid.activePtyId(),
    );
    if (confirm) {
      const ok = await confirmDialog({
        title: proc
          ? t("ui.kill.titleNamed", { proc })
          : t("ui.kill.titleSession"),
        detail: t("ui.kill.detail"),
        confirmLabel: t("ui.kill.confirm"),
      });
      if (!ok) return;
    }
    this.logKillMetric(grid);
    grid.killActive();
  }

  // Logged ahead of the actual kill so a user-initiated kill is distinguishable
  // in the timeline from the done/errored transition the kill itself produces.
  private logKillMetric(grid: PaneGrid): void {
    if (!this.config.metrics.enabled) return;
    const tabId = [...this.sessions].find(([, s]) => s === grid)?.[0];
    if (!tabId) return;
    const tab = this.tab(tabId);
    const projectId = tab?.kind === "terminal" ? (tab.projectId ?? null) : null;
    const command = getSessionState(grid.activePtyId())?.command ?? null;
    this.logMetric("killed", {
      tabId,
      projectId,
      cliName: resolveCliId(command, this.config.cli_registry),
      payload: JSON.stringify({ command }),
    });
  }

  private async runningProc(ptyId: string): Promise<string | null> {
    try {
      const snap = await ptySnapshot(ptyId);
      const argv0 = (snap.command ?? "").trim().split(/\s+/)[0] ?? "";
      const proc = argv0.split("/").pop() ?? "";
      if (proc && !this.config.session.safe_processes.includes(proc)) {
        return proc;
      }
    } catch {
      // without a snapshot the running process is unknown: do not nag
    }
    return null;
  }

  private async evalConfirm(
    policy: ConfirmPolicy,
    ptyId: string,
  ): Promise<{ confirm: boolean; proc: string | null }> {
    if (policy === "never") return { confirm: false, proc: null };
    if (policy === "always") return { confirm: true, proc: null };
    const proc = await this.runningProc(ptyId);
    return { confirm: proc !== null, proc };
  }

  private async evalConfirmTab(
    grid: PaneGrid,
  ): Promise<{ confirm: boolean; proc: string | null; count: number }> {
    const ids = grid.leafIds();
    const policy = this.config.session.confirm_close;
    if (policy === "never")
      return { confirm: false, proc: null, count: ids.length };
    if (policy === "always")
      return { confirm: true, proc: null, count: ids.length };
    const procs = await Promise.all(ids.map((id) => this.runningProc(id)));
    const proc = procs.find((p) => p !== null) ?? null;
    return { confirm: proc !== null, proc, count: ids.length };
  }

  killActiveFor(id: string): void {
    const grid = this.sessions.get(id);
    if (grid instanceof PaneGrid) void this.killActiveSession(grid);
  }

  reconnectActiveFor(id: string): void {
    const grid = this.sessions.get(id);
    if (grid instanceof PaneGrid) grid.reconnectActive();
  }

  private gotoTab(n: number): void {
    const tab = this.tabs[n - 1];
    if (tab) this.activate(tab.id);
  }

  private cycle(dir: number): void {
    if (this.tabs.length < 2 || !this.activeId) return;
    const i = this.tabs.findIndex((t) => t.id === this.activeId);
    const n = this.tabs.length;
    const next = this.tabs[(i + dir + n) % n];
    this.activate(next.id);
  }

  private setFontSize(size: number): void {
    const clamped = Math.min(
      this.config.limits.font_size_max,
      Math.max(this.config.limits.font_size_min, size),
    );
    if (clamped === this.config.font.size) return;
    this.config = {
      ...this.config,
      font: { ...this.config.font, size: clamped },
    };
    void configSet(this.config);
  }

  private tabSessionStates(): Map<string, SessionStateEntry> {
    const states = new Map<string, SessionStateEntry>();
    const registry = this.config.cli_registry;
    for (const tab of this.tabs) {
      const grid = this.sessions.get(tab.id);
      if (!(grid instanceof PaneGrid)) continue;
      const tracked = grid
        .leafIds()
        .filter((id) =>
          isTrackedAgent(getSessionState(id)?.command ?? null, registry),
        );
      const primary = pickPrimaryState(tracked);
      if (primary) states.set(tab.id, primary);
    }
    return states;
  }

  private renderTabs(): void {
    const states = this.tabSessionStates();
    this.tabbar.render(
      this.tabs,
      this.activeId,
      states,
      this.tabAttention(states),
    );
  }

  // A blocked session on a background tab must keep flagging until the user
  // opens it: the one-shot transition is missed precisely because the tab is
  // not being watched. Attention is the set of non-active tabs that need the
  // user (a high-confidence Waiting) and whose state is unseen since it last
  // changed; the active tab is always considered seen, so visiting a tab clears
  // its flag. Done and errored stay calm — finishing never raises the flag.
  private tabAttention(states: Map<string, SessionStateEntry>): Set<string> {
    const attention = new Set<string>();
    const present = new Set(this.tabs.map((tab) => tab.id));
    for (const id of this.acknowledgedState.keys()) {
      if (!present.has(id)) this.acknowledgedState.delete(id);
    }
    for (const tab of this.tabs) {
      const entry = states.get(tab.id);
      if (tab.id === this.activeId) {
        if (entry) this.acknowledgedState.set(tab.id, entry.state);
        else this.acknowledgedState.delete(tab.id);
        continue;
      }
      if (!entry || !needsYou(entry)) continue;
      const seen = this.acknowledgedState.get(tab.id);
      if (!seen || !sameKind(seen, entry.state)) attention.add(tab.id);
    }
    return attention;
  }

  // Every tracked session across every tab, flat: the board and the
  // keyboard-triage shortcuts both operate across the whole workspace, not
  // just the active tab.
  private allTrackedSessionIds(): string[] {
    const ids: string[] = [];
    for (const tab of this.tabs) {
      const grid = this.sessions.get(tab.id);
      if (grid instanceof PaneGrid) ids.push(...grid.leafIds());
    }
    return ids;
  }

  private activeSessionId(): string | null {
    const active = this.sessions.get(this.activeId ?? "");
    return active instanceof PaneGrid ? active.activePtyId() : null;
  }

  private trackedRows(
    label: (tab: TabState, entry: SessionStateEntry) => string,
  ): BoardRow[] {
    const rows: BoardRow[] = [];
    const registry = this.config.cli_registry;
    for (const tab of this.tabs) {
      const grid = this.sessions.get(tab.id);
      if (!(grid instanceof PaneGrid)) continue;
      for (const id of grid.leafIds()) {
        const entry = getSessionState(id);
        if (!entry || !isTrackedAgent(entry.command, registry)) continue;
        const color = tab.kind === "terminal" ? tab.color : null;
        rows.push({
          id,
          tab: tab.title,
          color,
          label: label(tab, entry),
          entry,
        });
      }
    }
    return rows;
  }

  private boardRows(): BoardRow[] {
    return this.trackedRows((tab, entry) => entry.command ?? tab.title);
  }

  // The notification's identity leads with the session name, not the raw
  // process name (the board's row label does the opposite) — the CLI is
  // appended separately per `identity.append_cli` when composing the message.
  private notificationRows(): BoardRow[] {
    return this.trackedRows((tab) => tab.title);
  }

  private boardHints(): BoardHints {
    return {
      gotoWaiting: this.strokeFor("orchestration.goto-waiting"),
      next: this.strokeFor("orchestration.next-waiting"),
      prev: this.strokeFor("orchestration.prev-waiting"),
    };
  }

  private toggleOrchestration(): void {
    if (this.orchestration.isOpen()) {
      this.orchestration.close();
      this.focusActive();
      return;
    }
    this.orchestration.open(this.boardRows(), this.boardHints());
  }

  // Jumps to a session by mux id, wherever it lives: activates its owning
  // tab, then switches that tab's pane grid to the session's leaf.
  private focusSession(id: string): void {
    for (const tab of this.tabs) {
      const grid = this.sessions.get(tab.id);
      if (!(grid instanceof PaneGrid) || !grid.leafIds().includes(id)) {
        continue;
      }
      this.activate(tab.id);
      grid.setActive(id);
      return;
    }
  }

  private gotoWhoNeedsMe(): void {
    const id = needsAttentionId(this.allTrackedSessionIds());
    if (id) this.focusSession(id);
  }

  private cycleWaiting(dir: 1 | -1): void {
    const id = cycleWaitingId(
      this.allTrackedSessionIds(),
      this.activeSessionId(),
      dir,
    );
    if (id) this.focusSession(id);
  }

  private persist(): void {
    if (this.restoring) return;
    // A ghost view's content lives only in this session's memory; persisting
    // its path would restore it as a normal (and broken) open of a file that
    // no longer exists on disk.
    const session: SavedTab[] = this.tabs
      .filter((t) => t.kind !== "editor" || !t.ghost)
      .map((t) => {
        const active = t.id === this.activeId;
        if (t.kind === "terminal") {
          const grid = this.sessions.get(t.id);
          return {
            kind: "terminal" as const,
            tree:
              grid instanceof PaneGrid
                ? grid.serialize()
                : ({ kind: "leaf", id: t.id } as PaneNode),
            projectId: t.projectId,
            title: t.title,
            color: t.color,
            lastUsedAt: t.lastUsedAt,
            pinned: t.pinned,
            active,
          };
        }
        return {
          kind: "editor" as const,
          path: t.path,
          lastUsedAt: t.lastUsedAt,
          pinned: t.pinned,
          active,
        };
      });
    const dock = this.pinCells.map((cell) => {
      if (cell?.session instanceof BrowserSession) {
        return { kind: "browser" as const, url: cell.session.path };
      }
      if (cell?.session instanceof TerminalSession) {
        return { kind: "terminal" as const };
      }
      if (cell?.session instanceof FocusCell) {
        return {
          kind: "timer" as const,
          preset: cell.session.presetId,
          ...(cell.session.sessionName
            ? { name: cell.session.sessionName }
            : {}),
        };
      }
      return null;
    });
    if (this.pinDockRestored) savePinDock(dock);
    const json = JSON.stringify(session);
    if (json === this.lastSessionJson) return;
    this.lastSessionJson = json;
    saveSession(session);
  }

  private async snapshot(): Promise<void> {
    if (document.hidden) return;
    for (const [, grid] of this.sessions) {
      if (!(grid instanceof PaneGrid)) continue;
      const map = new Map<string, { cwd?: string; command?: string }>();
      for (const leafId of grid.leafIds()) {
        try {
          const s = await ptySnapshot(leafId);
          map.set(leafId, {
            cwd: s.cwd ?? undefined,
            command: s.command ?? undefined,
          });
        } catch {
          // The PTY may die between leafIds() and ptySnapshot; skip the leaf
          // and keep its previous snapshot.
        }
      }
      grid.applySnapshot(map);
    }
    this.persist();
    this.refreshTreeIfVisible();
    if (this.config.performance.enabled) void this.updateActiveTab();
  }
}
