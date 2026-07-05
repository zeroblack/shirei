import { listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  getCurrentWindow,
  LogicalPosition,
  LogicalSize,
} from "@tauri-apps/api/window";
import { error as logError } from "@tauri-apps/plugin-log";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  copyFileToClipboard,
  revealInFinder,
  screencastStart,
  screencastStop,
  shareFile,
} from "./commands";
import type { Config, RecordFormat } from "./config";
import { errorCode, errorMessage } from "./errors";
import { type MessageKey, t } from "./i18n";
import { createOverlay } from "./overlay";
import {
  type CssRect,
  type FinishOp,
  moveTarget,
  type RecordTarget,
  renderFilename,
  resolveFinish,
  selectorAction,
  toPhysicalRect,
} from "./screencast-core";

const HUD_LABEL = "screencast-hud";
const HUD_WIDTH = 156;
const HUD_HEIGHT = 40;
const HUD_TOP_MARGIN = 12;

const FRAME_LABEL = "screencast-frame";
// The glow lives outside the true rect: CSS insets by this, and the window is
// grown by it, so the visible 2px border lands exactly on the recorded edge.
const FRAME_BLEED = 8;

const PRIVACY_SCREEN_CAPTURE_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

export interface ScreencastDeps {
  getConfig: () => Config;
  focusedPaneRect: () => CssRect | null;
  titlebarOffset: () => number;
  activeTabName: () => string;
  notify: (msg: string, action?: { label: string; run: () => void }) => void;
}

export interface Screencast {
  toggle: () => void;
  recordWith: (target: RecordTarget, format?: RecordFormat) => void;
  openRecordingsFolder: () => void;
  isRecording: () => boolean;
}

function openPrivacySettings(): void {
  void openUrl(PRIVACY_SCREEN_CAPTURE_URL).catch(() => {});
}

export function createScreencast(deps: ScreencastDeps): Screencast {
  let recording = false;
  let frameUnlisten: Array<() => void> = [];
  let repositionPending = false;

  void listen<{ path: string }>("screencast://stopped", (e) => {
    if (!recording) return;
    void finish(e.payload.path);
  });

  // A stop can originate from the HUD window or the duration timer, neither of
  // which can surface a finish error; the backend emits this so the main window
  // resets state and reports the failure instead of leaving the UI stuck.
  void listen<string>("screencast://failed", (e) => {
    if (!recording) return;
    recording = false;
    void closeOverlayWindows();
    deps.notify(e.payload || t("ui.screencast.recordingFailed"));
  });

  async function closeOverlayWindows(): Promise<void> {
    for (const un of frameUnlisten) un();
    frameUnlisten = [];
    for (const label of [HUD_LABEL, FRAME_LABEL]) {
      const win = await WebviewWindow.getByLabel(label);
      if (win) await win.close().catch(() => {});
    }
  }

  // Screen-space (logical points) rect the frame window should occupy: the
  // recorded surface grown by FRAME_BLEED on every side so the border's glow
  // sits just outside the captured pixels. App covers the whole window; panel
  // and region offset their CSS rect by the content origin.
  async function frameRect(
    target: RecordTarget,
    rect: CssRect | null,
  ): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const win = getCurrentWindow();
    const sf = await win.scaleFactor();
    if (target === "app") {
      const pos = await win.outerPosition();
      const size = await win.outerSize();
      return {
        x: pos.x / sf - FRAME_BLEED,
        y: pos.y / sf - FRAME_BLEED,
        width: size.width / sf + FRAME_BLEED * 2,
        height: size.height / sf + FRAME_BLEED * 2,
      };
    }
    if (!rect) return null;
    const origin = await win.innerPosition();
    return {
      x: origin.x / sf + rect.x - FRAME_BLEED,
      y: origin.y / sf + rect.y - FRAME_BLEED,
      width: rect.width + FRAME_BLEED * 2,
      height: rect.height + FRAME_BLEED * 2,
    };
  }

  async function openFrame(
    target: RecordTarget,
    rect: CssRect | null,
  ): Promise<void> {
    const r = await frameRect(target, rect);
    if (!r) return;
    const frame = new WebviewWindow(FRAME_LABEL, {
      url: "frame.html",
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
      decorations: false,
      alwaysOnTop: true,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      shadow: false,
      focus: false,
      title: t("ui.screencast.recordingTitle"),
    });
    await new Promise<void>((resolve, reject) => {
      void frame.once("tauri://created", () => resolve());
      void frame.once("tauri://error", (e) =>
        reject(new Error(String(e.payload))),
      );
    });
    await frame.setIgnoreCursorEvents(true);

    // App mode captures the whole window, which can be dragged or resized mid
    // recording; keep the frame glued to it. Panel/region rects don't move.
    if (target === "app") {
      const win = getCurrentWindow();
      const reposition = (): void => {
        if (repositionPending) return;
        repositionPending = true;
        requestAnimationFrame(() => {
          repositionPending = false;
          void repositionFrame();
        });
      };
      frameUnlisten.push(await win.onMoved(reposition));
      frameUnlisten.push(await win.onResized(reposition));
    }
  }

  async function repositionFrame(): Promise<void> {
    const r = await frameRect("app", null);
    const frame = await WebviewWindow.getByLabel(FRAME_LABEL);
    if (!r || !frame) return;
    await frame.setPosition(
      new LogicalPosition(Math.round(r.x), Math.round(r.y)),
    );
    await frame.setSize(
      new LogicalSize(Math.round(r.width), Math.round(r.height)),
    );
  }

  function joinPath(dir: string, name: string): string {
    return `${dir.replace(/\/+$/, "")}/${name}`;
  }

  async function execFinish(op: FinishOp, path: string): Promise<boolean> {
    switch (op) {
      case "copy":
        try {
          await copyFileToClipboard(path);
        } catch (e) {
          deps.notify(errorMessage(e));
          return false;
        }
        return true;
      case "reveal":
        await revealInFinder(path).catch(() => {});
        return true;
      case "share":
        try {
          await shareFile(path);
        } catch (e) {
          deps.notify(errorMessage(e));
          return false;
        }
        return true;
      case "none":
        return true;
    }
  }

  async function finish(path: string): Promise<void> {
    recording = false;
    await closeOverlayWindows();
    const onFinish = deps.getConfig().recorder.on_finish;
    const op =
      onFinish === "ask"
        ? resolveFinish(
            "ask",
            await askFinishPrompt(path.split("/").pop() ?? path),
          )
        : resolveFinish(onFinish, null);
    await execFinish(op, path);
  }

  async function stopAndFinish(): Promise<void> {
    try {
      const { path } = await screencastStop();
      await finish(path);
    } catch (e) {
      // The "screencast://failed" listener may have already handled this stop;
      // the recording flag makes both paths idempotent so it toasts once.
      if (!recording) return;
      recording = false;
      await closeOverlayWindows();
      deps.notify(errorMessage(e));
    }
  }

  async function beginRecording(
    target: RecordTarget,
    format: RecordFormat,
  ): Promise<void> {
    if (recording) return;
    let rect: CssRect | null = null;
    if (target === "panel") {
      rect = deps.focusedPaneRect();
      if (!rect) {
        deps.notify(t("ui.screencast.noFocusedPane"));
        return;
      }
    } else if (target === "region") {
      rect = await selectRegion();
      if (!rect) return;
    }

    const physical =
      rect === null
        ? null
        : toPhysicalRect(rect, {
            dpr: window.devicePixelRatio,
            titlebarOffsetCss: deps.titlebarOffset(),
          });

    const cfg = deps.getConfig();
    if (cfg.recorder.countdown_secs > 0) {
      const proceed = await runCountdown(cfg.recorder.countdown_secs);
      if (!proceed) return;
    }

    const name = renderFilename(cfg.recorder.filename_template, {
      tab: deps.activeTabName(),
      date: new Date(),
      ext: format,
    });
    const outPath = joinPath(cfg.recorder.dir, name);

    try {
      await screencastStart({ mode: target, rect: physical, format, outPath });
    } catch (e) {
      const code = errorCode(e);
      if (code === "screencast-permission-denied") {
        // macOS only applies the screen-recording grant on the next launch, so
        // tell the user to relaunch instead of leaving them re-trying in vain.
        deps.notify(t(`error.${code}` as MessageKey), {
          label: t("ui.screencast.openPrivacySettings"),
          run: openPrivacySettings,
        });
      } else if (code === "screencast-unsupported") {
        deps.notify(t(`error.${code}` as MessageKey));
      } else {
        deps.notify(errorMessage(e));
      }
      return;
    }

    recording = true;
    try {
      await openHud();
    } catch (e) {
      // The recording is live; without its HUD it would be invisible, so say so
      // outright instead of leaving the user wondering whether it ever started.
      void logError(`screencast: HUD window failed: ${errorMessage(e)}`);
      deps.notify(t("ui.screencast.recordingNoIndicator"));
    }
    // The glow frame is enhancement, never a blocker: the recording and HUD are
    // the source of truth, so a frame failure is logged and swallowed.
    if (cfg.recorder.highlight_frame) {
      try {
        await openFrame(target, rect);
      } catch (e) {
        void logError(`screencast: frame window failed: ${errorMessage(e)}`);
      }
    }
  }

  async function openHud(): Promise<void> {
    const existing = await WebviewWindow.getByLabel(HUD_LABEL);
    if (existing) return;
    const x = Math.round((window.screen.availWidth - HUD_WIDTH) / 2);
    const hud = new WebviewWindow(HUD_LABEL, {
      url: "hud.html",
      width: HUD_WIDTH,
      height: HUD_HEIGHT,
      x,
      y: HUD_TOP_MARGIN,
      decorations: false,
      alwaysOnTop: true,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      shadow: false,
      focus: false,
      title: t("ui.screencast.recordingTitle"),
    });
    await new Promise<void>((resolve, reject) => {
      void hud.once("tauri://created", () => resolve());
      void hud.once("tauri://error", (e) =>
        reject(new Error(String(e.payload))),
      );
    });
  }

  function runCountdown(seconds: number): Promise<boolean> {
    return new Promise((resolve) => {
      const { overlay, box, close } = createOverlay({
        className: "screencast-countdown",
        label: t("ui.screencast.countdownLabel"),
        onDismiss: () => done(false),
        // Capture blocks on this exit, so any longer is dead air before recording.
        closeDurationMs: 120,
      });

      let remaining = seconds;
      let timer: number | undefined;

      const done = (proceed: boolean): void => {
        if (timer !== undefined) window.clearInterval(timer);
        // Resolve only once the overlay is off the DOM, otherwise the capture
        // starts while it is still painted and the countdown lands in the video.
        void close().then(() => resolve(proceed));
      };

      const lead = document.createElement("div");
      lead.className = "screencast-countdown-lead";
      lead.textContent = t("ui.screencast.countdownLead");

      const ringWrap = document.createElement("div");
      ringWrap.className = "screencast-countdown-ring-wrap";
      const ns = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(ns, "svg");
      svg.setAttribute("viewBox", "0 0 84 84");
      svg.setAttribute("class", "screencast-countdown-ring");
      const track = document.createElementNS(ns, "circle");
      const arc = document.createElementNS(ns, "circle");
      for (const c of [track, arc]) {
        c.setAttribute("cx", "42");
        c.setAttribute("cy", "42");
        c.setAttribute("r", "38");
      }
      track.setAttribute("class", "screencast-countdown-track");
      arc.setAttribute("class", "screencast-countdown-arc");
      const circumference = 2 * Math.PI * 38;
      arc.style.strokeDasharray = `${circumference}`;
      svg.append(track, arc);

      const number = document.createElement("div");
      number.className = "screencast-countdown-number";
      ringWrap.append(svg, number);

      const hint = document.createElement("div");
      hint.className = "screencast-countdown-hint";
      hint.textContent = t("ui.screencast.countdownHint");

      box.append(lead, ringWrap, hint);

      const sweep = (): void => {
        arc.style.transition = "none";
        arc.style.strokeDashoffset = `${circumference}`;
        void arc.getBoundingClientRect();
        arc.style.transition = "stroke-dashoffset 1s linear";
        arc.style.strokeDashoffset = "0";
      };

      const paint = (): void => {
        number.textContent = t("ui.screencast.countdownNumber", { remaining });
        number.classList.remove("pop");
        void number.getBoundingClientRect();
        number.classList.add("pop");
        sweep();
      };
      paint();

      box.tabIndex = -1;
      timer = window.setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          done(true);
          return;
        }
        paint();
      }, 1000);

      document.body.appendChild(overlay);
      box.focus();
    });
  }

  function openSelector(): void {
    if (recording) return;
    let target: RecordTarget = "panel";
    let format = deps.getConfig().recorder.format;

    const { overlay, box, close } = createOverlay({
      className: "screencast-selector",
      label: t("ui.screencast.recordScreen"),
      onDismiss: () => close(),
      closeDurationMs: 140,
    });

    const header = document.createElement("div");
    header.className = "screencast-selector-header";
    const dot = document.createElement("span");
    dot.className = "screencast-rec-dot";
    const title = document.createElement("div");
    title.className = "screencast-selector-title";
    title.textContent = t("ui.screencast.recordScreen");
    header.append(dot, title);

    const choices = document.createElement("div");
    choices.className = "screencast-selector-choices";
    const rail = document.createElement("div");
    rail.className = "screencast-selector-rail";
    choices.append(rail);

    const targets: RecordTarget[] = ["panel", "app", "region"];
    const chips: Record<RecordTarget, string> = {
      panel: "P",
      app: "A",
      region: "R",
    };
    const labels: Record<RecordTarget, string> = {
      panel: t("ui.screencast.targetPanel"),
      app: t("ui.screencast.targetApp"),
      region: t("ui.screencast.targetRegion"),
    };
    const rows = {} as Record<RecordTarget, HTMLElement>;
    for (const choice of targets) {
      const row = document.createElement("div");
      row.className = "screencast-selector-row";
      const chip = document.createElement("kbd");
      chip.className = "screencast-selector-chip";
      chip.textContent = chips[choice];
      const label = document.createElement("span");
      label.textContent = labels[choice];
      row.append(chip, label);
      choices.append(row);
      rows[choice] = row;
    }

    const seg = document.createElement("div");
    seg.className = "screencast-seg";
    const segUnderline = document.createElement("div");
    segUnderline.className = "screencast-seg-underline";
    const segEls: Record<"mp4" | "gif", HTMLElement> = {
      mp4: document.createElement("div"),
      gif: document.createElement("div"),
    };
    seg.append(segUnderline);
    for (const f of ["mp4", "gif"] as const) {
      segEls[f].className = "screencast-seg-option";
      segEls[f].textContent = f.toUpperCase();
      seg.append(segEls[f]);
    }

    const hint = document.createElement("div");
    hint.className = "screencast-selector-hint";
    hint.textContent = t("ui.screencast.selectorHint");

    box.append(header, choices, seg, hint);

    const update = (): void => {
      for (const choice of targets)
        rows[choice].classList.toggle("selected", choice === target);
      rail.style.transform = `translateY(${rows[target].offsetTop}px)`;
      segEls.mp4.classList.toggle("active", format === "mp4");
      segEls.gif.classList.toggle("active", format === "gif");
      segUnderline.style.transform =
        format === "gif" ? "translateX(100%)" : "translateX(0)";
    };

    box.tabIndex = -1;
    box.addEventListener("keydown", (e) => {
      const action = selectorAction(e.key);
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      switch (action.kind) {
        case "target":
          target = action.target;
          update();
          break;
        case "move":
          target = moveTarget(target, action.delta);
          update();
          break;
        case "format":
          format = action.format;
          update();
          break;
        case "format-cycle":
          format = format === "mp4" ? "gif" : "mp4";
          update();
          break;
        case "confirm":
          close();
          void beginRecording(target, format);
          break;
        case "cancel":
          close();
          break;
      }
    });

    document.body.appendChild(overlay);
    box.focus();
    update();
  }

  function askFinishPrompt(filename: string): Promise<string | null> {
    return new Promise((resolve) => {
      const { overlay, box, close } = createOverlay({
        className: "screencast-finish",
        label: t("ui.screencast.ready"),
        onDismiss: () => done(null),
        closeDurationMs: 140,
      });
      const done = (choice: string | null): void => {
        close();
        resolve(choice);
      };

      const check = document.createElement("div");
      check.className = "screencast-finish-check";
      const title = document.createElement("div");
      title.className = "screencast-finish-title";
      title.textContent = t("ui.screencast.ready");
      const file = document.createElement("div");
      file.className = "screencast-finish-file";
      file.textContent = filename;

      const cells = document.createElement("div");
      cells.className = "screencast-finish-cells";
      const actions: [string, string][] = [
        ["C", t("ui.screencast.finishCopy")],
        ["F", t("ui.screencast.finishReveal")],
        ["S", t("ui.screencast.finishShare")],
      ];
      actions.forEach(([glyph, label], i) => {
        const cell = document.createElement("div");
        cell.className =
          i === 0 ? "screencast-finish-cell primary" : "screencast-finish-cell";
        const chip = document.createElement("kbd");
        chip.textContent = glyph;
        const text = document.createElement("span");
        text.textContent = label;
        cell.append(chip, text);
        cells.append(cell);
      });

      box.append(check, title, file, cells);

      box.tabIndex = -1;
      box.addEventListener("keydown", (e) => {
        const k = e.key.toLowerCase();
        if (e.key === "Enter") {
          e.preventDefault();
          done(null);
        } else if (k === "c" || k === "f" || k === "s") {
          e.preventDefault();
          done(k === "f" ? null : k);
        }
      });

      document.body.appendChild(overlay);
      box.focus();
    });
  }

  function selectRegion(): Promise<CssRect | null> {
    return new Promise((resolve) => {
      const layer = document.createElement("div");
      layer.className = "screencast-region";
      const startHint = document.createElement("div");
      startHint.className = "screencast-region-hint";
      startHint.textContent = t("ui.screencast.regionHint");
      const sel = document.createElement("div");
      sel.className = "screencast-region-box";
      sel.style.display = "none";
      for (const corner of ["tl", "tr", "bl", "br"]) {
        const h = document.createElement("div");
        h.className = `screencast-region-handle ${corner}`;
        sel.append(h);
      }
      const badge = document.createElement("div");
      badge.className = "screencast-region-badge";
      sel.append(badge);
      layer.append(startHint, sel);
      document.body.append(layer);

      let startX = 0;
      let startY = 0;
      let dragging = false;
      let pending = false;
      let last: { x: number; y: number } | null = null;

      const finishWith = (rect: CssRect | null): void => {
        window.removeEventListener("keydown", onKey, true);
        layer.remove();
        resolve(rect);
      };

      const paint = (cx: number, cy: number): void => {
        const x = Math.min(startX, cx);
        const y = Math.min(startY, cy);
        const w = Math.abs(cx - startX);
        const h = Math.abs(cy - startY);
        sel.style.display = "block";
        sel.style.left = `${x}px`;
        sel.style.top = `${y}px`;
        sel.style.width = `${w}px`;
        sel.style.height = `${h}px`;
        badge.textContent = `${Math.round(w)} × ${Math.round(h)}`;
      };

      const onMove = (e: MouseEvent): void => {
        if (!dragging) return;
        last = { x: e.clientX, y: e.clientY };
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
          pending = false;
          if (last) paint(last.x, last.y);
        });
      };

      const onUp = (e: MouseEvent): void => {
        if (!dragging) return;
        dragging = false;
        layer.removeEventListener("mousemove", onMove);
        layer.removeEventListener("mouseup", onUp);
        const x = Math.min(startX, e.clientX);
        const y = Math.min(startY, e.clientY);
        const width = Math.abs(e.clientX - startX);
        const height = Math.abs(e.clientY - startY);
        if (width < 8 || height < 8) {
          finishWith(null);
          return;
        }
        finishWith({ x, y, width, height });
      };

      const onKey = (e: KeyboardEvent): void => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finishWith(null);
        }
      };

      layer.addEventListener("mousedown", (e) => {
        e.preventDefault();
        startHint.remove();
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        paint(e.clientX, e.clientY);
        layer.addEventListener("mousemove", onMove);
        layer.addEventListener("mouseup", onUp);
      });
      window.addEventListener("keydown", onKey, true);
    });
  }

  return {
    toggle: () => {
      if (recording) void stopAndFinish();
      else openSelector();
    },
    recordWith: (target, format) =>
      void beginRecording(target, format ?? deps.getConfig().recorder.format),
    openRecordingsFolder: () =>
      void revealInFinder(deps.getConfig().recorder.dir).catch(() => {}),
    isRecording: () => recording,
  };
}
