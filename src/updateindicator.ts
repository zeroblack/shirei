import { t } from "./i18n";

// A titlebar pill that appears once an update is pending and clicking it opens
// the update modal. Created lazily so windows that never see a pending update
// never carry the extra DOM node.
export class UpdateIndicator {
  private el: HTMLButtonElement | null = null;

  constructor(private readonly onActivate: () => void) {}

  show(version: string): void {
    const btn = this.el ?? this.mount();
    const title = t("ui.update.available", { version });
    btn.title = title;
    btn.setAttribute("aria-label", title);
  }

  hide(): void {
    this.el?.remove();
    this.el = null;
  }

  private mount(): HTMLButtonElement {
    const actions = document.querySelector<HTMLElement>("#titlebar-actions");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "titlebar-update";
    const dot = document.createElement("span");
    dot.className = "tu-dot";
    dot.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "tu-label";
    label.textContent = t("ui.update.indicatorLabel");
    btn.append(dot, label);
    btn.addEventListener("click", () => this.onActivate());
    actions?.prepend(btn);
    requestAnimationFrame(() => {
      btn.dataset.mounted = "true";
    });
    this.el = btn;
    return btn;
  }
}
