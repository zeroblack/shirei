const TOAST_TTL_MS = 6000;

export interface ToastAction {
  label: string;
  run: () => void;
}

export function showToast(message: string, action?: ToastAction): void {
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");

  const msg = document.createElement("span");
  msg.className = "toast-msg";
  msg.textContent = message;
  el.append(msg);

  const dismiss = (): void => {
    clearTimeout(timer);
    el.remove();
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

  document.body.append(el);
  const timer = setTimeout(dismiss, TOAST_TTL_MS);
}
