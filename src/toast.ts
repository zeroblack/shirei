import {
  CLOSE_FALLBACK_BUFFER_MS,
  DEFAULT_CLOSE_DURATION_VAR,
  FALLBACK_CLOSE_MS,
  resolveCssDurationMs,
} from "./overlay";

const TOAST_TTL_MS = 6000;

export interface ToastAction {
  label: string;
  run: () => void;
}

let slot: HTMLElement | null = null;

// Mounted once and kept in the DOM for the app's lifetime, so a toast that
// fires while a previous one is mid-exit lands in the same stable container
// instead of racing to recreate it.
function getSlot(): HTMLElement {
  if (!slot) {
    slot = document.createElement("div");
    slot.className = "toast-slot";
    document.body.append(slot);
  }
  return slot;
}

export function showToast(message: string, action?: ToastAction): void {
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");

  const msg = document.createElement("span");
  msg.className = "toast-msg";
  msg.textContent = message;
  el.append(msg);

  let closed = false;
  const dismiss = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    el.dataset.closing = "true";
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(fallback);
      el.remove();
    };
    el.addEventListener("transitionend", finish, { once: true });
    const fallbackMs =
      resolveCssDurationMs(DEFAULT_CLOSE_DURATION_VAR, FALLBACK_CLOSE_MS) +
      CLOSE_FALLBACK_BUFFER_MS;
    const fallback = setTimeout(finish, fallbackMs);
  };

  if (action) {
    const btn = document.createElement("button");
    btn.className = "toast-action";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      dismiss();
      action.run();
    });
    el.append(btn);
  }

  getSlot().append(el);
  const timer = setTimeout(dismiss, TOAST_TTL_MS);
}
