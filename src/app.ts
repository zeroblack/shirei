import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { homeDir } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { alpha, mix } from "./colors";
import { ptyCwd, ptySnapshot, revealInFinder, revealLogs } from "./commands";
import {
  allTemplates,
  binaryOnPath,
  type Config,
  type ConfirmPolicy,
  configSet,
  DEFAULT_FONT_SIZE,
  type Project,
  type TerminalColors,
} from "./config";
import { choiceDialog, confirmDialog, messageDialog } from "./confirm";
import { attachDrag } from "./drag";
import type { EditorSession as EditorSessionType } from "./editor";
import { FileTree } from "./filetree";
import { fontStack, isFontLoaded, registerFont } from "./fonts";
import { setLocale, t } from "./i18n";
import { isImage, mediaKind, SEARCH, SIDEBAR } from "./icons";
import { ImageSession } from "./image";
import { Keymap } from "./keymap";
import { eventToKeystroke, formatKeystroke, resolveBindings } from "./keys";
import { MediaSession } from "./media";
import { type FocusDir, type LeafSpawn, PaneGrid } from "./panegrid";
import {
  declaredCommands,
  instantiate,
  leaves,
  type PaneNode,
  resolveDefaultTemplate,
} from "./panetree";
import { basename, parentDir } from "./path";
import { promptText } from "./prompt";
import { QuickOpen } from "./quickopen";
import type { Screencast } from "./screencast";
import type { CssRect } from "./screencast-core";
import { StatusBar } from "./statusbar";
import { clearSession, loadSession, type SavedTab, saveSession } from "./store";
import { TabBar } from "./tabbar";
import { TerminalSession } from "./terminal";
import { showToast } from "./toast";
import { openTodoModal } from "./todomodal";
import { TodoPanel } from "./todopanel";
import type { Todo } from "./todos";
import type { EditorTab, TabState } from "./types";
import { webglPool } from "./webgl-pool";

let EditorSession: typeof EditorSessionType | null = null;

async function loadEditor(): Promise<typeof EditorSessionType> {
  if (!EditorSession) {
    const mod = await import("./editor");
    EditorSession = mod.EditorSession;
  }
  return EditorSession;
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return `t${Date.now().toString(36)}${seq}`;
}

function isClaudeCommand(cmd: string | undefined): cmd is string {
  return cmd !== undefined && cmd.trim().split(/\s+/)[0] === "claude";
}

function withClaudeFlag(cmd: string, flag: "--continue" | "--resume"): string {
  if (/(^|\s)(--continue|--resume|-c|-r)(\s|$)/.test(cmd)) return cmd;
  return `${cmd} ${flag}`;
}

// Hidden longer than this on return is treated as a GPU sleep (rebuild renderers)
// rather than a quick app switch (light repaint).
const LONG_HIDDEN_MS = 5000;

// Row height of the TODO panel, used to convert `todo_min_rows` to pixels when
// clamping the divider position. Matches the CSS row height; not user-configurable.
const TODO_ROW_HEIGHT_PX = 24;

const CHROME: Record<"dark" | "light", Record<string, string>> = {
  dark: {
    "--bg": "#000000",
    "--bg-bar": "#0c0d0f",
    "--fg": "#ffffff",
    "--fg-dim": "#6e727b",
    "--border": "#26282e",
    "--surface-0": "#0c0d0f",
    "--surface-1": "#121316",
    "--surface-2": "#17191d",
    "--surface-3": "#1d1f24",
    "--border-soft": "rgba(255, 255, 255, 0.06)",
    "--border-strong": "rgba(255, 255, 255, 0.12)",
    "--text": "#ffffff",
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
  return {
    "--bg": bg,
    "--bg-bar": mix(bg, fg, 0.05),
    "--surface-0": mix(bg, fg, 0.03),
    "--surface-1": mix(bg, fg, 0.06),
    "--surface-2": mix(bg, fg, 0.1),
    "--surface-3": mix(bg, fg, 0.14),
    "--fg": fg,
    "--text": fg,
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
}

export class App {
  private tabs: TabState[] = [];
  private readonly sessions = new Map<
    string,
    PaneGrid | EditorSessionType | ImageSession | MediaSession
  >();
  private activeId: string | null = null;
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
  private readonly mainEl: HTMLElement;
  private readonly panelEl: HTMLElement;
  private readonly dividerEl: HTMLElement;
  private readonly treeRegionEl: HTMLElement;
  private readonly todoPanelEl: HTMLElement;
  private readonly todoPanel: TodoPanel;
  private readonly todoDividerEl: HTMLElement;
  private todoFocused = false;
  private panelVisible = false;
  private lastRoot: string | null = null;
  private treeRoot: string | null = null;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private ageTimer: ReturnType<typeof setInterval> | null = null;
  private lastSessionJson: string | null = null;
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
    onOpenFile: (path) => void this.openFile(path),
    onRevealDir: (path) => void this.revealDir(path),
    onOpenProject: (id) => void this.openProject(id),
    commands: () => this.paletteCommands(),
  });

  constructor(tabbarEl: HTMLElement, host: HTMLElement, config: Config) {
    this.host = host;
    this.config = config;
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
      onOpenFile: (path) => void this.openFile(path),
      onEscape: () => this.sessions.get(this.activeId ?? "")?.focus(),
    });
    this.todoDividerEl = document.querySelector<HTMLElement>(
      "#todo-divider",
    ) as HTMLElement;
    this.todoPanel = new TodoPanel(this.todoPanelEl, {
      onRequestModal: () => this.openTodoCapture(),
      onRequestDetail: (todo) => this.openTodoEdit(todo),
    });
    this.todoPanelEl.addEventListener("focusout", (e) => {
      if (this.todoPanelEl.contains(e.relatedTarget as Node | null)) return;
      if (this.todoFocused) this.blurTodoPanel();
    });
    this.setActiveProject(null);
    this.panelEl.classList.add("hidden");
    this.applyMotionVars(config.motion);
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
    webglPool.setCap(config.render.webgl_pool_cap);
    window.addEventListener("resize", () => this.queueFit());
    window.addEventListener("keydown", (e) => this.onKey(e));
    window.addEventListener("beforeunload", () => this.dispose());
    document.addEventListener("visibilitychange", () => this.onVisibility());
    window.addEventListener("focus", () => {
      this.cmdAvailable.clear();
      this.current()?.recoverRenderers(false);
    });
    this.setupTitlebarSearch();
    document.addEventListener("focusin", () => this.refreshFocusSurface());
    this.refreshFocusSurface();
    this.startTimers();
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
    btn.addEventListener("click", () => void this.openQuickOpen());
    this.updateSearchHint();

    this.sidebarBtn = document.querySelector<HTMLElement>("#titlebar-sidebar");
    const sidebarIcon = this.sidebarBtn?.querySelector<HTMLElement>(".ts-icon");
    if (sidebarIcon) sidebarIcon.innerHTML = SIDEBAR;
    this.sidebarBtn?.addEventListener("click", () => this.togglePanel());
    this.syncSidebarButton();
    this.applyTitlebarLabels();
  }

  private applyTitlebarLabels(): void {
    const search = document.querySelector<HTMLElement>("#titlebar-search");
    search?.setAttribute("title", t("ui.titlebar.search"));
    const searchLabel = search?.querySelector<HTMLElement>(".ts-label");
    if (searchLabel) searchLabel.textContent = t("ui.titlebar.searchLabel");
    this.sidebarBtn?.setAttribute("title", t("ui.titlebar.toggleSidebar"));
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
    this.todoPanel.setFocusHint(this.strokeFor("todo.focus"));
    this.tree.setFocusHint(this.strokeFor("tree.focus"));
  }

  // Coming back from a long hidden span (likely a GPU sleep, where WKWebView can
  // leave the WebGL surface stale without firing webglcontextlost) rebuilds the
  // renderers; a quick refocus only nudges a repaint.
  private onVisibility(): void {
    if (document.hidden) {
      this.hiddenAt = Date.now();
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
    this.ageTimer = setInterval(
      () => this.tabbar.refreshAges(),
      Math.max(1, this.config.tabs.age_refresh_secs) * 1000,
    );
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
  }

  dispose(): void {
    this.stopTimers();
    if (getCurrentWindow().label === "main") this.persist();
    else clearSession();
    this.statusbar.dispose();
    for (const session of this.sessions.values()) void session.dispose();
  }

  async init(): Promise<void> {
    this.tree.setHome(await homeDir());
    const saved = loadSession();
    if (saved.length === 0) {
      await this.newTab();
    } else {
      for (const t of saved) {
        if (t.kind === "terminal") {
          await this.openTerminalTab(t.tree, t.title, t.color, t.projectId);
        } else {
          await this.openFile(t.path, true);
        }
      }
      if (!this.tabs.some((x) => x.kind === "terminal")) await this.newTab();
      saved.forEach((s, i) => {
        const t = this.tabs[i];
        if (!t) return;
        if (typeof s.lastUsedAt === "number") t.lastUsedAt = s.lastUsedAt;
        if (typeof s.pinned === "boolean") t.pinned = s.pinned;
      });
      this.renderTabs();
    }
    if (this.panelVisible) await this.openWorkspaceTree();
  }

  async bindMenu(): Promise<void> {
    await listen("menu-new-tab", () => void this.newTab());
    await listen("menu-close-tab", () => void this.closeActive());
    await listen("menu-palette", () => void this.openQuickOpen());
    await listen("menu-toggle-sidebar", () => this.togglePanel());
    await listen("menu-zoom-in", () => this.setFontSize(this.fontSize + 1));
    await listen("menu-zoom-out", () => this.setFontSize(this.fontSize - 1));
    await listen("menu-zoom-reset", () => this.setFontSize(DEFAULT_FONT_SIZE));
    await listen<number>("menu-goto-tab", (e) => this.gotoTab(e.payload));
  }

  applyConfig(c: Config): void {
    const previous = this.config;
    this.config = c;
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
    this.applyFocusChrome(c.chrome);
    this.applyMotionVars(c.motion);
    webglPool.setCap(c.render.webgl_pool_cap);
    if (
      previous.session.snapshot_interval_secs !==
        c.session.snapshot_interval_secs ||
      previous.tabs.age_refresh_secs !== c.tabs.age_refresh_secs
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
            invoke<number | null>("pty_pid", { id }).catch(() => null),
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
   * Panes restored from a snapshot (`lastCommand` defined) that run `claude`
   * come back continuing their conversation: `--continue` when the tab holds a
   * single claude pane, `--resume` when several share it so each picks its own.
   */
  private resolveSpawnCommands(
    tree: PaneNode,
  ): Map<string, string | undefined> {
    const entries = leaves(tree).map((leaf) => ({
      id: leaf.id,
      cmd: this.spawnCommandFor(leaf),
      restored: leaf.lastCommand !== undefined,
    }));
    const claude = entries.filter((e) => e.restored && isClaudeCommand(e.cmd));
    const flag = claude.length > 1 ? "--resume" : "--continue";
    return new Map(
      entries.map((e) => [
        e.id,
        e.restored && isClaudeCommand(e.cmd)
          ? withClaudeFlag(e.cmd, flag)
          : e.cmd,
      ]),
    );
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
      },
      cwdOf: (pid) =>
        ptyCwd(pid).then(
          (c) => c ?? undefined,
          () => undefined,
        ),
    });
    grid.setAccent(color);
    this.sessions.set(id, grid);
    this.activeId = id;
    this.showActive();
    await grid.open();
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

  openFile(path: string, silent = false): Promise<void> {
    return this.enqueue(() => this.doOpenFile(path, silent));
  }

  private async doOpenFile(path: string, silent = false): Promise<void> {
    const existing = this.tabs.find(
      (t) => t.kind === "editor" && t.path === path,
    );
    if (existing) {
      this.activate(existing.id);
      return;
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
    if (isImage(name)) {
      session = new ImageSession(id, path, container);
    } else if (mediaKind(name)) {
      session = new MediaSession(id, path, container);
    } else {
      const ES = await loadEditor();
      session = new ES(id, path, container, {
        fontFamily: fontStack(this.config.font.family, this.config.fonts),
        fontSize: this.config.font.size,
        palette: this.config.theme.terminal,
        preset: this.config.theme.preset,
        editor: this.config.editor,
      });
      session.onDirtyChange = (dirty) => this.setDirty(id, dirty);
    }
    this.sessions.set(id, session);

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

  activate(id: string): void {
    if (id === this.activeId || !this.sessions.has(id)) return;
    this.activeId = id;
    this.showActive();
    this.renderTabs();
    this.focusActive();
    this.persist();
    if (this.panelVisible) void this.openWorkspaceTree();
    const tab = this.tab(id);
    const projectId = tab?.kind === "terminal" ? (tab.projectId ?? null) : null;
    this.setActiveProject(projectId);
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

    this.sessions.delete(id);
    this.tabs = this.tabs.filter((t) => t.id !== id);

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
    return [
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

  private async saveActive(): Promise<void> {
    const s = this.sessions.get(this.activeId ?? "");
    if (!this.isEditor(s)) return;
    const res = await s.save();
    if (res.conflict) {
      const overwrite = await confirmDialog({
        title: t("ui.app.fileChangedTitle"),
        detail: t("ui.app.fileChangedDetail"),
        confirmLabel: t("ui.app.fileChangedConfirm"),
      });
      if (overwrite) await s.saveForce();
      return;
    }
    if (!res.ok && res.error) {
      this.notify(t("ui.app.saveFailed", { error: res.error }));
    }
  }

  private setPanelVisible(visible: boolean): void {
    const sidebarHadFocus =
      !visible && (this.tree.hasFocus() || this.todoFocused);
    this.panelVisible = visible;
    this.panelEl.classList.toggle("hidden", !visible);
    this.dividerEl.classList.toggle("hidden", !visible);
    this.syncSidebarButton();
    if (sidebarHadFocus) this.focusActive();
  }

  private setActiveProject(projectId: string | null): void {
    const hasProject = projectId !== null;
    this.todoPanelEl.classList.toggle("hidden", !hasProject);
    this.todoDividerEl.classList.toggle("hidden", !hasProject);
    void this.todoPanel.setProject(projectId);
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
    if (this.treeHasFocus()) {
      if (dir === "right") this.focusActive();
      return true;
    }
    if (active instanceof PaneGrid) {
      if (active.focusDir(dir)) return true;
      if (dir === "left") this.focusTree();
      return true;
    }
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

  private applyMotionVars(motion: Config["motion"]): void {
    const root = document.documentElement;
    const reduced =
      motion.respect_reduced_motion &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const ms = (v: number): string =>
      !motion.enabled || reduced ? "0ms" : `${v}ms`;
    root.style.setProperty("--task-sink", ms(motion.task_sink_ms));
    root.style.setProperty("--modal-in", ms(motion.modal_in_ms));
    root.style.setProperty("--modal-out", ms(motion.modal_out_ms));
    root.style.setProperty("--reveal", ms(motion.reveal_ms));
    root.style.setProperty("--reveal-stagger", ms(motion.reveal_stagger_ms));
    root.style.setProperty("--divider-snap", ms(motion.divider_snap_ms));
  }

  private applyTodoRatio(ratio: number): void {
    const clampedRatio = Math.max(0.1, Math.min(0.9, ratio));
    this.treeRegionEl.style.flex = `${1 - clampedRatio} 1 0`;
    this.todoPanelEl.style.flex = `${clampedRatio} 1 0`;
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
    const filePath = this.activeFilePath();
    if (filePath) await this.tree.revealPath(filePath);
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
    const root = await this.activeWorkspaceRoot();
    void this.quickopen.open(
      root,
      this.projects,
      this.config.limits.quickopen_results,
    );
  }

  private async revealDir(path: string): Promise<void> {
    if (!this.panelVisible) this.setPanelVisible(true);
    await this.openWorkspaceTree();
    await this.tree.revealPath(path);
    this.tree.focus();
  }

  private onKey(e: KeyboardEvent): void {
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
    if (this.todoFocused) {
      const ks = eventToKeystroke(e);
      if (ks) {
        const action = this.keymap.resolve(ks, { pane: false });
        if (action === "todo.focus") {
          e.preventDefault();
          this.blurTodoPanel();
          this.focusActive();
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
    const action = this.keymap.resolve(ks, {
      pane: active instanceof PaneGrid,
    });
    if (!action) return;
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
      case "editor.vim-toggle":
        this.toggleVim();
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
        if (this.treeHasFocus()) this.focusActive();
        else this.focusTree();
        break;
      case "todo.focus":
        if (this.todoFocused) {
          this.blurTodoPanel();
          this.focusActive();
        } else {
          this.focusTodoPanel();
        }
        break;
      case "todo.capture":
        this.openTodoCapture();
        break;
    }
  }

  private async closeActive(): Promise<void> {
    const active = this.sessions.get(this.activeId ?? "");
    if (!(active instanceof PaneGrid)) {
      if (this.activeId) void this.closeTab(this.activeId);
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
    grid.killActive();
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

  private renderTabs(): void {
    this.tabbar.render(this.tabs, this.activeId);
  }

  private persist(): void {
    const session: SavedTab[] = this.tabs.map((t) => {
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
        };
      }
      return {
        kind: "editor" as const,
        path: t.path,
        lastUsedAt: t.lastUsedAt,
        pinned: t.pinned,
      };
    });
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
