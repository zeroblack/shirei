interface OverlayOpts {
  className: string;
  role?: "dialog" | "alertdialog";
  label?: string;
  onDismiss: () => void;
  // Duration of the exit transition in ms; used as fallback if transitionend
  // never fires (e.g. overlays with no CSS transition). Defaults to 0.
  closeDurationMs?: number;
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
      const fallbackMs = (opts.closeDurationMs ?? 0) + 50;
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
