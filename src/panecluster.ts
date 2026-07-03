import { t } from "./i18n";
import { FILE_GLYPH, TERMINAL_GLYPH } from "./icons";
import type { PaneContentKind } from "./panecontent";

export interface ClusterItem {
  kind: PaneContentKind;
  title: string;
  dirty: boolean;
  active: boolean;
}

export class PaneCluster {
  private readonly root: HTMLElement;

  constructor(
    el: HTMLElement,
    private readonly cb: {
      onSelect: (index: number) => void;
      onPick: () => void;
      onClose: (index: number) => void;
    },
  ) {
    this.root = document.createElement("div");
    this.root.className = "pane-cluster";
    el.appendChild(this.root);
  }

  render(items: ClusterItem[]): void {
    this.root.classList.toggle("multi", items.length > 1);
    this.root.replaceChildren();
    if (items.length <= 1) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "pane-cluster-add";
      add.title = t("ui.pane.addContent");
      add.textContent = "+";
      add.addEventListener("click", (e) => {
        e.stopPropagation();
        this.cb.onPick();
      });
      this.root.appendChild(add);
      return;
    }
    items.forEach((item, index) => {
      const seg = document.createElement("button");
      seg.type = "button";
      seg.className = "pane-cluster-seg";
      seg.classList.toggle("active", item.active);
      seg.classList.toggle("dirty", item.dirty);
      seg.title =
        item.kind === "terminal" ? t("ui.pane.terminalSeg") : item.title;
      const glyph = document.createElement("span");
      glyph.className = "pane-cluster-glyph";
      glyph.innerHTML = item.kind === "terminal" ? TERMINAL_GLYPH : FILE_GLYPH;
      seg.appendChild(glyph);
      if (item.kind !== "terminal") {
        const label = document.createElement("span");
        label.className = "pane-cluster-label";
        label.textContent = item.title;
        seg.appendChild(label);
        const close = document.createElement("span");
        close.className = "pane-cluster-close";
        close.title = t("ui.pane.closeFile");
        close.textContent = "×";
        close.addEventListener("click", (e) => {
          e.stopPropagation();
          this.cb.onClose(index);
        });
        seg.appendChild(close);
      }
      seg.addEventListener("click", (e) => {
        e.stopPropagation();
        this.cb.onSelect(index);
      });
      this.root.appendChild(seg);
    });
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "pane-cluster-pick";
    pick.title = t("ui.pane.changeType");
    pick.innerHTML = "&#9662;";
    pick.addEventListener("click", (e) => {
      e.stopPropagation();
      this.cb.onPick();
    });
    this.root.appendChild(pick);
  }

  dispose(): void {
    this.root.remove();
  }
}
