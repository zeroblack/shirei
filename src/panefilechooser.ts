import { t } from "./i18n";
import type { PaneContentSession } from "./panecontent";

export class PaneFileChooser implements PaneContentSession {
  constructor(
    private readonly container: HTMLElement,
    private readonly cb: {
      recents: () => { rel: string; abs: string }[];
      onOpen: (abs: string) => void;
      onFind: () => void;
      onBackToTerminal: () => void;
    },
  ) {
    this.container.classList.add("pane-filechooser");
    this.container.tabIndex = -1;
  }

  async open(): Promise<void> {
    const box = document.createElement("div");
    box.className = "pane-filechooser-box";
    const title = document.createElement("div");
    title.className = "pane-filechooser-title";
    title.textContent = t("ui.pane.noFileOpen");
    const hint = document.createElement("div");
    hint.className = "pane-filechooser-hint";
    hint.textContent = t("ui.pane.takesNextFile");
    box.append(title, hint);
    const recents = this.cb.recents().slice(0, 5);
    if (recents.length) {
      const label = document.createElement("div");
      label.className = "pane-filechooser-label";
      label.textContent = t("ui.pane.recent");
      box.appendChild(label);
      for (const r of recents) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "pane-filechooser-row";
        row.textContent = r.rel;
        row.addEventListener("click", () => this.cb.onOpen(r.abs));
        box.appendChild(row);
      }
    }
    const actions = document.createElement("div");
    actions.className = "pane-filechooser-actions";
    actions.textContent = t("ui.pane.chooserActions");
    box.appendChild(actions);
    this.container.replaceChildren(box);
  }

  show(visible: boolean): void {
    this.container.classList.toggle("pane-content-active", visible);
  }

  focus(): void {
    this.container.focus();
  }

  dispose(): void {
    this.container.remove();
  }
}
