import { t } from "./i18n";
import type { PaneContentSession } from "./panecontent";

export class PaneFileChooser implements PaneContentSession {
  private rows: { el: HTMLButtonElement; abs: string }[] = [];
  private selected = 0;
  private readonly onKeyDown = (e: KeyboardEvent) => this.handleKey(e);

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
        this.rows.push({ el: row, abs: r.abs });
      }
    }
    const actions = document.createElement("div");
    actions.className = "pane-filechooser-actions";
    actions.textContent = t("ui.pane.chooserActions");
    box.appendChild(actions);
    this.container.replaceChildren(box);
    this.container.addEventListener("keydown", this.onKeyDown);
    this.highlight();
  }

  // ⌘P bubbles to the global palette binding, so only the bare keys the global
  // dispatcher ignores (arrows / Enter / Escape) are handled here.
  private handleKey(e: KeyboardEvent): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = this.rows[this.selected];
      if (row) this.cb.onOpen(row.abs);
      else this.cb.onFind();
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.cb.onBackToTerminal();
    }
  }

  private move(dir: 1 | -1): void {
    if (this.rows.length === 0) return;
    this.selected = (this.selected + dir + this.rows.length) % this.rows.length;
    this.highlight();
  }

  private highlight(): void {
    this.rows.forEach((r, i) => {
      r.el.classList.toggle("selected", i === this.selected);
    });
  }

  show(visible: boolean): void {
    this.container.classList.toggle("pane-content-active", visible);
  }

  focus(): void {
    this.container.focus();
  }

  dispose(): void {
    this.container.removeEventListener("keydown", this.onKeyDown);
    this.container.remove();
  }
}
