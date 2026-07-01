import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { type ITheme, Terminal } from "@xterm/xterm";
import type { RenderConfig, TerminalColors } from "./config";
import { RendererDiag } from "./diag";
import { errorMessage } from "./errors";
import {
  applyKittySequence,
  encodeKey,
  KittyKeyboardState,
} from "./kitty-keyboard";
import { lineUnderCursor } from "./term-lines";
import { webglPool } from "./webgl-pool";

const KITTY_PREFIXES = ["?", ">", "<", "="];

// Best-effort IPC for high-frequency writes/resizes. A rejection here is a
// benign transient (a pane mid-transition, a daemon momentarily unreachable);
// swallowing it keeps those from surfacing as unhandled promise rejections.
const fireForget = (cmd: string, args: Record<string, unknown>): void => {
  void invoke(cmd, args).catch(() => {});
};

// Focus in/out reports the terminal emits on its own under DECSET 1004, not
// user input. They must still reach the PTY, but counting them as activity
// would reset a tab's idle age every time you merely pass through it.
const FOCUS_REPORTS = new Set(["\x1b[I", "\x1b[O"]);

// Dragging a window between displays fires DPR changes in bursts; re-measuring
// the cell per event would thrash, so wait for the value to settle.
const DPR_SETTLE_MS = 150;

// A hidden pane drains its buffered output once it crosses this size, so a
// chatty background session can't grow the buffer without bound. Draining is a
// single bulk write whose cost xterm's own scrollback then caps.
const HIDDEN_FLUSH_BYTES = 256 * 1024;

export const rgbaFrom = (hex: string, alpha: number): string => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return `rgba(255, 255, 255, ${alpha})`;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
};

const toXtermTheme = (c: TerminalColors): ITheme => ({
  background: c.bg,
  foreground: c.fg,
  cursor: c.cursor,
  black: c.black,
  red: c.red,
  green: c.green,
  yellow: c.yellow,
  blue: c.blue,
  magenta: c.magenta,
  cyan: c.cyan,
  white: c.white,
  brightBlack: c.brightBlack,
  brightRed: c.brightRed,
  brightGreen: c.brightGreen,
  brightYellow: c.brightYellow,
  brightBlue: c.brightBlue,
  brightMagenta: c.brightMagenta,
  brightCyan: c.brightCyan,
  brightWhite: c.brightWhite,
  cursorAccent: c.bg,
  selectionBackground: rgbaFrom(c.fg, 0.25),
  selectionInactiveBackground: rgbaFrom(c.fg, 0.12),
});

interface TermLook {
  fontFamily: string;
  fontSize: number;
  render: RenderConfig;
  theme: TerminalColors;
  keepAlive: boolean;
  activityThrottleMs: number;
  appOwnsKeystroke: (e: KeyboardEvent) => boolean;
  cwd?: string;
  command?: string;
}

export class TerminalSession {
  readonly id: string;
  private readonly term: Terminal;
  private readonly fit = new FitAddon();
  private readonly container: HTMLElement;
  private readonly cwd?: string;
  private readonly command?: string;
  private fontFamily: string;
  private fontSize: number;
  private unlisten?: UnlistenFn;
  private webgl?: WebglAddon;
  private dprQuery?: MediaQueryList;
  private wantWebgl: boolean;
  private readonly kitty = new KittyKeyboardState();
  private kittyEnabled: boolean;
  private shiftEnterNewline: boolean;
  private wantCursorBlink: boolean;
  private useDaemon: boolean;
  // While a pane is hidden its PTY output is buffered instead of written to
  // xterm, so background panes (other tabs' Claude/TUI sessions) stop parsing
  // and painting. The buffer drains on show; if it grows past the threshold it
  // drains early so memory stays bounded without dropping output.
  private visible = true;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private dprSettleTimer: number | undefined;
  private readonly onDprChange = () => {
    window.clearTimeout(this.dprSettleTimer);
    this.dprSettleTimer = window.setTimeout(
      () => this.repaint(),
      DPR_SETTLE_MS,
    );
  };
  private readonly diag: RendererDiag;
  private readonly ac = new AbortController();
  private readonly activityThrottleMs: number;
  private readonly appOwnsKeystroke: (e: KeyboardEvent) => boolean;
  onExit?: () => void;
  onActivity?: () => void;
  private lastActivityEmit = 0;

  constructor(id: string, container: HTMLElement, look: TermLook) {
    this.id = id;
    this.container = container;
    this.cwd = look.cwd;
    this.command = look.command;
    this.fontFamily = look.fontFamily;
    this.fontSize = look.fontSize;
    this.wantWebgl = look.render.webgl;
    this.kittyEnabled = look.render.kitty_keyboard;
    this.shiftEnterNewline = look.render.shift_enter_newline;
    this.wantCursorBlink = look.render.cursor_blink;
    this.useDaemon = look.keepAlive;
    this.activityThrottleMs = look.activityThrottleMs;
    this.appOwnsKeystroke = look.appOwnsKeystroke;
    this.diag = new RendererDiag(
      id,
      look.render.diagnostics,
      () => (this.webgl ? "webgl" : "dom"),
      // A genuine stall on a visible pane only earns a cheap repaint; rebuilding
      // the GL context here is what exhausts WebKit's context budget and garbles
      // panes. Context rebuilds stay on the rare paths: GPU wake and ⌘⌥R.
      () => this.repaint(),
      () => this.container.clientWidth > 0,
    );
    this.term = new Terminal({
      fontFamily: look.fontFamily,
      fontSize: look.fontSize,
      lineHeight: look.render.line_height,
      letterSpacing: look.render.letter_spacing,
      cursorBlink: false,
      cursorStyle: look.render.cursor_style,
      cursorInactiveStyle: look.render.cursor_inactive_style,
      scrollback: look.render.scrollback,
      minimumContrastRatio: look.render.min_contrast,
      rescaleOverlappingGlyphs: true,
      customGlyphs: true,
      drawBoldTextInBrightColors: true,
      allowProposedApi: true,
      macOptionIsMeta: false,
      theme: toXtermTheme(look.theme),
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.metaKey && e.type === "keydown") {
        return !this.appOwnsKeystroke(e);
      }
      return this.handleKittyKey(e);
    });
    this.registerKittyHandlers();
    this.term.onRender(() => this.diag.onRender());
  }

  private handleKittyKey(e: KeyboardEvent): boolean {
    // Shift+Enter inserts a newline instead of submitting. When the app enabled
    // the kitty protocol, encodeKey emits \x1b[13;2u below; otherwise (plain
    // shells, Claude Code — which does not negotiate kitty here) fall back to
    // \x1b\r (meta+enter), which Claude Code and most REPLs read as a soft
    // newline rather than submit.
    if (
      this.shiftEnterNewline &&
      e.key === "Enter" &&
      e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      (!this.kittyEnabled || this.kitty.current() === 0)
    ) {
      if (e.type === "keydown") {
        this.writeInput("\x1b\r");
        this.markActivity();
      }
      e.preventDefault();
      return false;
    }
    if (e.metaKey || !this.kittyEnabled || this.kitty.current() === 0)
      return true;
    if (e.type !== "keydown" && e.type !== "keyup") return true;
    const seq = encodeKey(e, this.kitty.current());
    if (seq === null) return true;
    if (seq) this.writeInput(seq);
    if (e.type === "keydown") this.markActivity();
    // Kitty already delivered the key to the app in the PTY; cancel the
    // webview default so Tab/arrows do not move focus out of the terminal
    // (pane switching is ⌘⇧arrows).
    e.preventDefault();
    return false;
  }

  private registerKittyHandlers(): void {
    const respond = (data: string) => this.writeInput(data);
    for (const prefix of KITTY_PREFIXES) {
      this.term.parser.registerCsiHandler({ prefix, final: "u" }, (params) => {
        // With the toggle off we still answer the query (0 flags) so the app
        // never hangs waiting, but push/set are ignored → legacy encoding.
        if (!this.kittyEnabled) {
          if (prefix === "?") respond("\x1b[?0u");
          return true;
        }
        const nums = params.map((p) => (Array.isArray(p) ? (p[0] ?? 0) : p));
        const resp = applyKittySequence(this.kitty, prefix, nums);
        if (resp) respond(resp);
        return true;
      });
    }
  }

  async open(): Promise<void> {
    await this.loadFont();
    this.term.open(this.container);
    this.fit.fit();
    webglPool.setEnabled(this.wantWebgl);
    webglPool.register(
      this.id,
      () => this.enableWebgl(),
      () => this.fallbackToDom(),
    );

    this.unlisten = await listen(`pty-exit-${this.id}`, () => this.onExit?.());
    this.term.onData((data) => {
      if (!FOCUS_REPORTS.has(data)) this.markActivity();
      this.writeInput(data);
    });
    this.setupClipboard();

    this.diag.note(
      `SESSION cols=${this.term.cols} rows=${this.term.rows} wantWebgl=${this.wantWebgl} kitty=${this.kittyEnabled}${this.command ? ` cmd=${this.command}` : ""}`,
    );
    this.diag.start();

    const onData = this.makeOnData();

    if (this.useDaemon) {
      try {
        await invoke("mux_spawn", {
          id: this.id,
          cols: this.term.cols,
          rows: this.term.rows,
          cwd: this.cwd ?? null,
          command: this.command ?? null,
          onData,
        });
        await this.nudgeRedraw();
        return;
      } catch (err) {
        this.useDaemon = false;
        this.diag.note(
          `mux_spawn failed (${errorMessage(err)}); falling back to in-process PTY`,
        );
      }
    }
    try {
      await invoke("pty_spawn", {
        id: this.id,
        cols: this.term.cols,
        rows: this.term.rows,
        cwd: this.cwd ?? null,
        onData,
      });
    } catch (err) {
      // Keep the pane alive and explain instead of leaving a dead terminal
      // with live listeners behind a rejected open().
      this.unlisten?.();
      this.unlisten = undefined;
      this.term.writeln(`shirei: failed to start shell: ${errorMessage(err)}`);
      return;
    }
    if (this.command) {
      fireForget("pty_write", { id: this.id, data: `${this.command}\n` });
    }
  }

  private writeInput(data: string): void {
    fireForget(this.useDaemon ? "mux_write" : "pty_write", {
      id: this.id,
      data,
    });
  }

  private markActivity(): void {
    const now = Date.now();
    if (now - this.lastActivityEmit >= this.activityThrottleMs) {
      this.lastActivityEmit = now;
      this.onActivity?.();
    }
  }

  private makeOnData(): Channel<ArrayBuffer> {
    const onData = new Channel<ArrayBuffer>();
    onData.onmessage = (buf) => {
      const bytes = new Uint8Array(buf);
      this.diag.scan(bytes);
      if (this.visible) {
        this.term.write(bytes);
        return;
      }
      this.pending.push(bytes);
      this.pendingBytes += bytes.length;
      if (this.pendingBytes >= HIDDEN_FLUSH_BYTES) this.drainPending();
    };
    return onData;
  }

  private drainPending(): void {
    if (this.pending.length === 0) return;
    for (const chunk of this.pending) this.term.write(chunk);
    this.pending = [];
    this.pendingBytes = 0;
  }

  async reconnect(): Promise<void> {
    if (this.useDaemon) {
      this.term.reset();
      this.pending = [];
      this.pendingBytes = 0;
      try {
        await invoke("mux_spawn", {
          id: this.id,
          cols: this.term.cols,
          rows: this.term.rows,
          cwd: this.cwd ?? null,
          command: null,
          onData: this.makeOnData(),
        });
        await this.nudgeRedraw();
        return;
      } catch {
        // daemon did not answer: degrade to a plain redraw
      }
    }
    this.fitAndResize();
    this.term.refresh(0, this.term.rows - 1);
  }

  // Reattaching to the daemon replays a raw byte ring, which cannot reconstruct
  // an alt-screen TUI (Claude, vim, lazygit) — the replayed frame is partial.
  // A SIGWINCH (resize off-by-one and back) makes the foreground app repaint its
  // whole screen over the stale replay.
  private async nudgeRedraw(): Promise<void> {
    const { cols, rows } = this.term;
    if (!this.useDaemon || rows <= 1) return;
    await invoke("mux_resize", { id: this.id, cols, rows: rows - 1 });
    await invoke("mux_resize", { id: this.id, cols, rows });
  }

  async killSession(): Promise<void> {
    await invoke(this.useDaemon ? "mux_kill" : "pty_kill", { id: this.id });
  }

  private async loadFont(): Promise<void> {
    try {
      // document.fonts.ready only resolves pending loads; on a cold start the
      // font was never requested, so force it before xterm measures the cell.
      await document.fonts.load(`${this.fontSize}px ${this.fontFamily}`);
    } catch {
      // without the Font Loading API, xterm measures with whatever is loaded
    }
  }

  private enableWebgl(): void {
    this.disposeWebgl();
    const addon = new WebglAddon();
    try {
      this.term.loadAddon(addon);
      addon.onContextLoss(() => {
        this.diag.note("webgl: CONTEXT_LOST -> falling back to DOM");
        this.fallbackToDom();
      });
      this.webgl = addon;
      this.watchDpr();
      this.diag.note("webgl: addon active");
    } catch (err) {
      addon.dispose();
      this.diag.note(`webgl: INIT_FAILED ${String(err)} -> fallback DOM`);
      // A failed activate means WebKit's context budget is spent; trip the fuse
      // so every pane drops to DOM and we stop churning contexts (which only
      // makes it worse) until a webview reload reclaims them.
      webglPool.markExhausted();
      // A failed activate can leave xterm pointing at a dead renderer; force the
      // DOM renderer back to painting so the pane never strands blank.
      this.repaint();
    }
  }

  private disposeWebgl(): void {
    this.dprQuery?.removeEventListener("change", this.onDprChange);
    this.dprQuery = undefined;
    window.clearTimeout(this.dprSettleTimer);
    if (!this.webgl) return;
    // WKWebView keeps a disposed WebGL2 context alive until GC, so churn (pane
    // and tab switches, DPR changes) can exhaust the process-wide context budget
    // and make the next `new WebglAddon()` throw, stranding panes on a blank
    // renderer. Drop the GPU slot eagerly instead of waiting for the collector.
    this.releaseGlContext();
    try {
      this.webgl.dispose();
    } catch {
      // the context may already be lost; the DOM renderer takes over
    }
    this.webgl = undefined;
  }

  private releaseGlContext(): void {
    for (const canvas of this.container.querySelectorAll<HTMLCanvasElement>(
      "canvas",
    )) {
      canvas
        .getContext("webgl2")
        ?.getExtension("WEBGL_lose_context")
        ?.loseContext();
    }
  }

  private fallbackToDom(): void {
    this.disposeWebgl();
    this.repaint();
  }

  // Re-measures the cell with the live font, rebuilds the renderer's atlas for
  // the current DPR and repaints every row. Cures both failure modes seen under
  // renderer churn: a blank pane (bytes arriving, nothing painted) and cells
  // sized from a fallback font evicted mid-session (glyphs spread across
  // oversized cells). No-op while hidden (re-measuring a zero-size element would
  // cache bad dimensions); falls back to a plain refresh if the internal API
  // shape moves.
  private repaint(): void {
    if (this.container.clientWidth === 0) return;
    const rs = this.renderService();
    if (rs?.handleDevicePixelRatioChange) rs.handleDevicePixelRatioChange();
    else this.term.refresh(0, this.term.rows - 1);
  }

  private renderService():
    | { handleDevicePixelRatioChange?: () => void }
    | undefined {
    return (
      this.term as unknown as {
        _core?: {
          _renderService?: { handleDevicePixelRatioChange?: () => void };
        };
      }
    )._core?._renderService;
  }

  private watchDpr(): void {
    this.dprQuery?.removeEventListener("change", this.onDprChange);
    this.dprQuery = window.matchMedia(
      `(resolution: ${window.devicePixelRatio}dppx)`,
    );
    this.dprQuery.addEventListener("change", this.onDprChange);
  }

  private recreateWebgl(): void {
    if (this.webgl && !webglPool.isExhausted()) this.enableWebgl();
  }

  // After the GPU sleeps, the WebGL surface can be silently stale even when no
  // webglcontextlost fires (WKWebView/macOS), leaving the pane blank or garbled.
  // A long wake rebuilds the GL context outright (a fresh context also fixes a
  // corrupt texture atlas); a quick refocus just forces a repaint.
  async recover(hard: boolean): Promise<void> {
    // A long sleep or GC can evict the loaded web font; re-ensure it before any
    // re-measure so the cell is sized from the real font, not a wide fallback.
    await this.loadFont();
    if (hard && this.webgl) this.recreateWebgl();
    this.fit.fit();
    this.repaint();
  }

  private setupClipboard(): void {
    this.container.addEventListener(
      "mouseup",
      (e) => {
        if (e.button === 0 && this.term.hasSelection())
          void writeText(this.term.getSelection());
      },
      { signal: this.ac.signal },
    );
    this.container.addEventListener(
      "contextmenu",
      (e) => {
        e.preventDefault();
        void this.pasteFromClipboard();
      },
      { signal: this.ac.signal },
    );
  }

  private async pasteFromClipboard(): Promise<void> {
    try {
      const text = await readText();
      if (text) this.term.paste(text);
    } catch {
      // readText throws when the clipboard holds no text (image/file)
    }
  }

  copyLine(): void {
    if (this.term.hasSelection()) {
      void writeText(this.term.getSelection());
      return;
    }
    const text = lineUnderCursor(this.term.buffer.active);
    if (text.trim()) void writeText(text);
  }

  paste(): void {
    void this.pasteFromClipboard();
  }

  show(visible: boolean): void {
    this.container.classList.toggle("active", visible);
  }

  // Tracks whether the pane's grid is on the active tab. Hidden panes buffer
  // their PTY output (see makeOnData) instead of writing it; becoming visible
  // drains the buffer so the screen catches up in one pass.
  setVisible(visible: boolean): void {
    const becameVisible = visible && !this.visible;
    this.visible = visible;
    if (becameVisible) this.drainPending();
  }

  fitAndResize(): void {
    this.fit.fit();
    fireForget(this.useDaemon ? "mux_resize" : "pty_resize", {
      id: this.id,
      cols: this.term.cols,
      rows: this.term.rows,
    });
  }

  /** Applies font, render options and theme in one pass: a single reflow and
   *  a single PTY resize instead of one cascade per setting. */
  applyLook(
    family: string,
    size: number,
    render: RenderConfig,
    theme: TerminalColors,
  ): void {
    this.fontSize = size;
    this.fontFamily = family;
    this.term.options.fontFamily = family;
    this.term.options.fontSize = size;
    this.wantWebgl = render.webgl;
    this.kittyEnabled = render.kitty_keyboard;
    this.shiftEnterNewline = render.shift_enter_newline;
    this.term.options.lineHeight = render.line_height;
    this.term.options.letterSpacing = render.letter_spacing;
    this.wantCursorBlink = render.cursor_blink;
    this.term.options.cursorStyle = render.cursor_style;
    this.term.options.cursorInactiveStyle = render.cursor_inactive_style;
    this.term.options.scrollback = render.scrollback;
    this.term.options.minimumContrastRatio = render.min_contrast;
    this.term.options.theme = toXtermTheme(theme);
    webglPool.setEnabled(render.webgl);
    this.fitAndResize();
  }

  setCursorBlink(on: boolean): void {
    this.term.options.cursorBlink = on && this.wantCursorBlink;
  }

  markHot(): void {
    webglPool.touch(this.id);
  }

  focus(): void {
    this.term.focus();
  }

  scrollByLines(lines: number): void {
    this.term.scrollLines(lines);
  }

  scrollbackWeight(): number {
    return this.term.buffer.active.length * this.term.cols;
  }

  async dispose(): Promise<void> {
    this.unlisten?.();
    this.unlisten = undefined;
    this.ac.abort();
    this.diag.dispose();
    webglPool.unregister(this.id);
    this.disposeWebgl();
    await invoke(this.useDaemon ? "mux_detach" : "pty_kill", { id: this.id });
    this.pending = [];
    this.pendingBytes = 0;
    this.term.dispose();
    this.container.remove();
  }
}
