interface OverlayOpts {
  className: string;
  role?: "dialog" | "alertdialog";
  label?: string;
  onDismiss: () => void;
  // CSS custom property whose live value drives this overlay's exit
  // transition; read at close time so a fallback timer never clips a
  // duration the user raised in Settings. Defaults to --modal-out, the
  // token nearly every overlay animates on.
  closeDurationVar?: string;
  // Escape hatch for the rare exit that isn't driven by a CSS custom
  // property at all. Bypasses closeDurationVar entirely.
  closeDurationMs?: number;
}

export const DEFAULT_CLOSE_DURATION_VAR = "--modal-out";
// Last-resort fallback when the custom property is empty or unparsable
// (e.g. this window never ran applyMotionVars). Matches motion.modal_out_ms's
// own default in config.rs.
export const FALLBACK_CLOSE_MS = 130;
// The +50ms buffer only matters if transitionend never fires (e.g. reduced
// motion collapses the transition to 0ms, or the box has no transition).
export const CLOSE_FALLBACK_BUFFER_MS = 50;

export function resolveCssDurationMs(
  varName: string,
  fallbackMs: number,
): number {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  if (!raw) return fallbackMs;
  const value = Number.parseFloat(raw);
  if (Number.isNaN(value)) return fallbackMs;
  if (raw.endsWith("ms")) return value;
  if (raw.endsWith("s")) return value * 1000;
  return fallbackMs;
}

export interface Overlay {
  overlay: HTMLDivElement;
  box: HTMLDivElement;
  close: () => Promise<void>;
}

// Every overlay is constructed here, so counting mounts/closes at this one
// origin covers current and future overlays alike: a native child webview
// (the browser pane) cannot be clipped by the DOM and must be told
// explicitly to hide whenever any of these is on top of it.
let overlayCount = 0;
let onOverlayChange: ((count: number) => void) | null = null;

export function overlaysOpen(): boolean {
  return overlayCount > 0;
}

export function setOverlayObserver(cb: (count: number) => void): void {
  onOverlayChange = cb;
}

/**
 * Scaffold shared by every transient overlay: dialog role, click-outside and
 * Escape dismissal, and a focus trap so Tab never escapes to the page below —
 * in a keyboard-first product the dialog must own the keyboard.
 */
export function createOverlay(opts: OverlayOpts): Overlay {
  const overlay = document.createElement("div");
  overlay.className = opts.className;

  const box = document.createElement("div");
  box.className = `${opts.className}-box`;
  box.setAttribute("role", opts.role ?? "dialog");
  box.setAttribute("aria-modal", "true");
  if (opts.label) box.setAttribute("aria-label", opts.label);

  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) opts.onDismiss();
  });
  overlay.addEventListener("keydown", (e) => {
    // Nothing may leak to xterm or global shortcuts while the dialog is open.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      opts.onDismiss();
      return;
    }
    if (e.key === "Tab") {
      cycleFocus(e, box, e.shiftKey ? -1 : 1);
      return;
    }
    // Arrows mirror Tab so the dialog can be driven without reaching for Tab,
    // but only when focus is on a control that ignores arrows natively — text
    // fields, selects and sliders keep their own arrow behavior.
    if (isArrowKey(e.key) && !consumesArrows(document.activeElement)) {
      cycleFocus(e, box, e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 1);
      return;
    }
    // macOS Full Keyboard Access (off by default) makes WKWebView skip Enter
    // activation on focused buttons, so drive it ourselves — keyboard-first
    // dialogs cannot depend on a system setting.
    if (e.key === "Enter") {
      const focused = document.activeElement;
      if (focused instanceof HTMLButtonElement && box.contains(focused)) {
        e.preventDefault();
        focused.click();
      }
    }
  });

  overlay.append(box);

  overlayCount += 1;
  onOverlayChange?.(overlayCount);

  // Trigger the entrance animation in the next frame so CSS transitions fire.
  // Using @starting-style is the native way in WebKit 17.4+; the data-mounted
  // attribute is the fallback for older WebKit builds.
  requestAnimationFrame(() => {
    overlay.dataset.mounted = "true";
  });

  const close = (): Promise<void> => {
    return new Promise((resolve) => {
      overlay.dataset.closing = "true";
      const closeMs =
        opts.closeDurationMs ??
        resolveCssDurationMs(
          opts.closeDurationVar ?? DEFAULT_CLOSE_DURATION_VAR,
          FALLBACK_CLOSE_MS,
        );
      const fallbackMs = closeMs + CLOSE_FALLBACK_BUFFER_MS;
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        overlay.remove();
        overlayCount = Math.max(0, overlayCount - 1);
        onOverlayChange?.(overlayCount);
        resolve();
      };

      box.addEventListener("transitionend", finish, { once: true });
      const timer = setTimeout(finish, fallbackMs);
    });
  };

  return { overlay, box, close };
}

function cycleFocus(e: KeyboardEvent, box: HTMLElement, dir: 1 | -1): void {
  e.preventDefault();
  const focusables = [
    ...box.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ];
  if (focusables.length === 0) return;
  const current = focusables.indexOf(document.activeElement as HTMLElement);
  const next = (current + dir + focusables.length) % focusables.length;
  focusables[next].focus();
}

function isArrowKey(key: string): boolean {
  return (
    key === "ArrowUp" ||
    key === "ArrowDown" ||
    key === "ArrowLeft" ||
    key === "ArrowRight"
  );
}

function consumesArrows(el: Element | null): boolean {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    return true;
  }
  if (el instanceof HTMLInputElement) {
    const standalone = el.type === "checkbox" || el.type === "radio";
    return !standalone;
  }
  return false;
}
