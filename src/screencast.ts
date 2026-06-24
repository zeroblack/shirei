import { listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
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
const HUD_WIDTH = 132;
const HUD_HEIGHT = 36;
const HUD_TOP_MARGIN = 12;

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

  void listen<{ path: string }>("screencast://stopped", (e) => {
    if (!recording) return;
    void finish(e.payload.path);
  });

  async function closeHud(): Promise<void> {
    const hud = await WebviewWindow.getByLabel(HUD_LABEL);
    if (hud) await hud.close().catch(() => {});
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
    await closeHud();
    const onFinish = deps.getConfig().recorder.on_finish;
    const op =
      onFinish === "ask"
        ? resolveFinish("ask", await askFinishPrompt())
        : resolveFinish(onFinish, null);
    await execFinish(op, path);
  }

  async function stopAndFinish(): Promise<void> {
    try {
      const { path } = await screencastStop();
      await finish(path);
    } catch (e) {
      recording = false;
      await closeHud();
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
      });

      let remaining = seconds;
      let timer: number | undefined;

      const done = (proceed: boolean): void => {
        if (timer !== undefined) window.clearInterval(timer);
        close();
        resolve(proceed);
      };

      const number = document.createElement("div");
      number.className = "screencast-countdown-number";
      const hint = document.createElement("div");
      hint.className = "screencast-countdown-hint";
      hint.textContent = t("ui.screencast.countdownHint");
      box.append(number, hint);

      const paint = (): void => {
        number.textContent = t("ui.screencast.countdownNumber", { remaining });
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
    });

    const render = (): void => {
      box.replaceChildren();
      const title = document.createElement("div");
      title.className = "screencast-selector-title";
      title.textContent = t("ui.screencast.recordScreen");

      const choices = document.createElement("div");
      choices.className = "screencast-selector-choices";
      const targetLabels: Record<RecordTarget, string> = {
        panel: t("ui.screencast.targetPanel"),
        app: t("ui.screencast.targetApp"),
        region: t("ui.screencast.targetRegion"),
      };
      for (const choice of ["panel", "app", "region"] as RecordTarget[]) {
        const row = document.createElement("div");
        row.className =
          choice === target
            ? "screencast-selector-row selected"
            : "screencast-selector-row";
        row.textContent = targetLabels[choice];
        choices.append(row);
      }

      const formats = document.createElement("div");
      formats.className = "screencast-selector-formats";
      formats.textContent = t("ui.screencast.format", {
        format: format.toUpperCase(),
      });

      const hint = document.createElement("div");
      hint.className = "screencast-selector-hint";
      hint.textContent = t("ui.screencast.selectorHint");

      box.append(title, choices, formats, hint);
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
          render();
          break;
        case "move":
          target = moveTarget(target, action.delta);
          render();
          break;
        case "format":
          format = action.format;
          render();
          break;
        case "format-cycle":
          format = format === "mp4" ? "gif" : "mp4";
          render();
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

    render();
    document.body.appendChild(overlay);
    box.focus();
  }

  function askFinishPrompt(): Promise<string | null> {
    return new Promise((resolve) => {
      const { overlay, box, close } = createOverlay({
        className: "screencast-finish",
        label: t("ui.screencast.ready"),
        onDismiss: () => done(null),
      });
      const done = (choice: string | null): void => {
        close();
        resolve(choice);
      };

      const title = document.createElement("div");
      title.className = "screencast-finish-title";
      title.textContent = t("ui.screencast.ready");
      const hint = document.createElement("div");
      hint.className = "screencast-finish-hint";
      hint.textContent = t("ui.screencast.readyHint");
      box.append(title, hint);

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
      const sel = document.createElement("div");
      sel.className = "screencast-region-box";
      sel.style.display = "none";
      layer.append(sel);
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
