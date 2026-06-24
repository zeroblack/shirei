import { t } from "./i18n";
import type { TabState } from "./types";

export interface TabBarCallbacks {
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onRecolor: (id: string, color: string | null) => void;
  onReorder: (orderedIds: string[]) => void;
  onReconnect: (id: string) => void;
  onKill: (id: string) => void;
  onPin: (id: string) => void;
  onNew: () => void;
}

const DRAG_THRESHOLD_PX = 4;
// Must match the .tab-shifting transition duration in styles.css.
const TAB_SETTLE_MS = 180;
const POPOVER_OFFSET_PX = 4;

function formatAge(lastUsedAt: number): string {
  const secs = Math.max(0, Math.floor((Date.now() - lastUsedAt) / 1000));
  if (secs < 60) return t("ui.tabbar.ageNow");
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const rm = mins % 60;
    return rm ? `${hours}h ${rm}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const rh = hours % 24;
  return rh ? `${days}d ${rh}h` : `${days}d`;
}

interface DragState {
  id: string;
  el: HTMLElement;
  els: HTMLElement[];
  rects: DOMRect[];
  fromIndex: number;
  toIndex: number;
  startX: number;
  slotWidth: number;
  started: boolean;
  move: (e: PointerEvent) => void;
  up: (e: PointerEvent) => void;
}

export class TabBar {
  private readonly root: HTMLElement;
  private readonly cb: TabBarCallbacks;
  private popover: HTMLElement | null = null;
  private palette: string[];
  private drag: DragState | null = null;
  private suppressClick = false;
  private showAge = false;

  constructor(root: HTMLElement, cb: TabBarCallbacks, palette: string[]) {
    this.root = root;
    this.cb = cb;
    this.palette = palette;
    document.addEventListener("click", () => this.closePopover());
  }

  setPalette(palette: string[]): void {
    this.palette = palette;
  }

  setShowAge(showAge: boolean): void {
    this.showAge = showAge;
  }

  refreshAges(): void {
    for (const span of this.root.querySelectorAll<HTMLElement>(".tab-age")) {
      const lu = Number(span.dataset.lastUsed);
      if (!Number.isNaN(lu)) span.textContent = formatAge(lu);
    }
  }

  updateAge(id: string, lastUsedAt: number): void {
    const span = this.root.querySelector<HTMLElement>(
      `.tab[data-tab-id="${id}"] .tab-age`,
    );
    if (span) {
      span.dataset.lastUsed = String(lastUsedAt);
      span.textContent = formatAge(lastUsedAt);
    }
  }

  render(tabs: TabState[], activeId: string | null): void {
    this.root.replaceChildren();

    const activeTab = tabs.find((t) => t.id === activeId);
    const rootStyle = document.documentElement.style;
    if (activeTab?.kind === "terminal" && activeTab.color) {
      rootStyle.setProperty("--active-accent", activeTab.color);
    } else {
      rootStyle.removeProperty("--active-accent");
    }

    for (const tab of tabs) {
      this.root.appendChild(this.renderTab(tab, tab.id === activeId));
    }

    const add = document.createElement("button");
    add.className = "tab-add";
    add.textContent = "+";
    add.title = t("ui.tabbar.newTab");
    add.addEventListener("click", (e) => {
      e.stopPropagation();
      this.cb.onNew();
    });
    this.root.appendChild(add);
  }

  private renderTab(tab: TabState, active: boolean): HTMLElement {
    const el = document.createElement("div");
    el.className = active ? "tab active" : "tab";
    el.dataset.tabId = tab.id;
    if (tab.kind === "terminal" && tab.color) {
      el.style.setProperty("--tab-color", tab.color);
      el.classList.add("colored");
    }
    el.addEventListener("pointerdown", (e) =>
      this.onPointerDown(e, el, tab.id),
    );
    el.addEventListener("click", () => {
      if (this.suppressClick) return;
      this.cb.onActivate(tab.id);
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (tab.kind === "terminal") this.openPalette(el, tab.id, tab.pinned);
    });

    if (tab.pinned) {
      el.classList.add("pinned");
      const pin = document.createElement("span");
      pin.className = "tab-pin";
      pin.textContent = "★";
      el.appendChild(pin);
    }

    if (tab.kind === "terminal") {
      const dot = document.createElement("button");
      dot.className = "tab-dot";
      dot.title = t("ui.tabbar.color");
      dot.addEventListener("click", (e) => {
        e.stopPropagation();
        this.openPalette(el, tab.id, tab.pinned);
      });
      el.appendChild(dot);
    } else {
      const icon = document.createElement("span");
      icon.className = "tab-icon";
      icon.textContent = "◧";
      el.appendChild(icon);
      if (tab.dirty) el.classList.add("dirty");
    }

    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = tab.title;
    label.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      this.startRename(label, tab);
    });

    const close = document.createElement("button");
    close.className = "tab-close";
    close.textContent = "×";
    close.title = t("ui.tabbar.close");
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      this.cb.onClose(tab.id);
    });

    el.append(label);
    if (this.showAge && !active) {
      const age = document.createElement("span");
      age.className = "tab-age";
      age.dataset.lastUsed = String(tab.lastUsedAt);
      age.textContent = formatAge(tab.lastUsedAt);
      el.append(age);
    }
    el.append(close);
    return el;
  }

  private startRename(label: HTMLElement, tab: TabState): void {
    const input = document.createElement("input");
    input.className = "tab-rename";
    input.value = tab.title;
    label.replaceWith(input);
    input.focus();
    input.select();
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") this.cb.onRename(tab.id, input.value);
      else if (e.key === "Escape") this.cb.onRename(tab.id, tab.title);
    });
    input.addEventListener("blur", () => this.cb.onRename(tab.id, input.value));
  }

  private onPointerDown(e: PointerEvent, el: HTMLElement, id: string): void {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest(".tab-close, .tab-dot, .tab-rename")) return;
    const els = Array.from(this.root.querySelectorAll<HTMLElement>(".tab"));
    const fromIndex = els.indexOf(el);
    if (fromIndex === -1) return;
    const move = (ev: PointerEvent) => this.onPointerMove(ev);
    const up = () => this.onPointerUp();
    this.drag = {
      id,
      el,
      els,
      rects: [],
      fromIndex,
      toIndex: fromIndex,
      startX: e.clientX,
      slotWidth: 0,
      started: false,
      move,
      up,
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  private onPointerMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const dx = e.clientX - d.startX;
    if (!d.started) {
      if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      this.beginDrag(d);
    }
    e.preventDefault();
    d.el.style.transform = `translateX(${dx}px)`;
    const toIndex = this.targetIndex(d, e.clientX);
    if (toIndex !== d.toIndex) {
      d.toIndex = toIndex;
      this.applyShift(d);
    }
  }

  private beginDrag(d: DragState): void {
    d.started = true;
    d.rects = d.els.map((t) => t.getBoundingClientRect());
    const gap = Number.parseFloat(getComputedStyle(this.root).gap) || 0;
    d.slotWidth = d.rects[d.fromIndex].width + gap;
    d.el.classList.add("dragging");
    document.body.style.cursor = "grabbing";
    for (const t of d.els) if (t !== d.el) t.classList.add("tab-shifting");
  }

  private targetIndex(d: DragState, clientX: number): number {
    let count = 0;
    for (let i = 0; i < d.rects.length; i++) {
      if (i === d.fromIndex) continue;
      const r = d.rects[i];
      if (clientX > r.left + r.width / 2) count++;
    }
    return count;
  }

  private applyShift(d: DragState): void {
    for (let i = 0; i < d.els.length; i++) {
      if (i === d.fromIndex) continue;
      let shift = 0;
      if (i > d.fromIndex && i <= d.toIndex) shift = -d.slotWidth;
      else if (i < d.fromIndex && i >= d.toIndex) shift = d.slotWidth;
      d.els[i].style.transform = shift ? `translateX(${shift}px)` : "";
    }
  }

  private onPointerUp(): void {
    const d = this.drag;
    if (!d) return;
    window.removeEventListener("pointermove", d.move);
    window.removeEventListener("pointerup", d.up);
    this.drag = null;
    if (!d.started) return;
    document.body.style.cursor = "";
    this.suppressClick = true;
    window.setTimeout(() => {
      this.suppressClick = false;
    }, 0);
    if (d.toIndex !== d.fromIndex) {
      const ids = d.els.map((t) => t.dataset.tabId as string);
      const [moved] = ids.splice(d.fromIndex, 1);
      ids.splice(d.toIndex, 0, moved);
      this.cb.onReorder(ids);
      return;
    }
    d.el.classList.remove("dragging");
    for (const t of d.els) {
      t.classList.add("tab-shifting");
      t.style.transform = "";
    }
    window.setTimeout(() => {
      for (const t of d.els) {
        t.classList.remove("tab-shifting");
        t.style.transform = "";
      }
    }, TAB_SETTLE_MS);
  }

  private openPalette(anchor: HTMLElement, id: string, pinned: boolean): void {
    this.closePopover();
    const pop = document.createElement("div");
    pop.className = "palette";
    pop.addEventListener("click", (e) => e.stopPropagation());

    const actions = document.createElement("div");
    actions.className = "palette-actions";
    const pin = document.createElement("button");
    pin.className = "palette-action";
    pin.textContent = `★ ${pinned ? t("ui.tabbar.unpin") : t("ui.tabbar.pin")}`;
    pin.title = t("ui.tabbar.pinTitle");
    pin.addEventListener("click", () => {
      this.cb.onPin(id);
      this.closePopover();
    });
    const reconnect = document.createElement("button");
    reconnect.className = "palette-action";
    reconnect.textContent = t("ui.tabbar.reconnect");
    reconnect.title = t("ui.tabbar.reconnectTitle");
    reconnect.addEventListener("click", () => {
      this.cb.onReconnect(id);
      this.closePopover();
    });
    const kill = document.createElement("button");
    kill.className = "palette-action palette-kill";
    kill.textContent = t("ui.tabbar.kill");
    kill.title = t("ui.tabbar.killTitle");
    kill.addEventListener("click", () => {
      this.cb.onKill(id);
      this.closePopover();
    });
    actions.append(pin, reconnect, kill);
    pop.appendChild(actions);

    const swatches = document.createElement("div");
    swatches.className = "palette-swatches";
    for (const color of this.palette) {
      const swatch = document.createElement("button");
      swatch.className = "swatch";
      swatch.style.background = color;
      swatch.addEventListener("click", () => {
        this.cb.onRecolor(id, color);
        this.closePopover();
      });
      swatches.appendChild(swatch);
    }

    const clear = document.createElement("button");
    clear.className = "swatch swatch-clear";
    clear.textContent = "∅";
    clear.title = t("ui.tabbar.noColor");
    clear.addEventListener("click", () => {
      this.cb.onRecolor(id, null);
      this.closePopover();
    });
    swatches.appendChild(clear);
    pop.appendChild(swatches);

    const rect = anchor.getBoundingClientRect();
    pop.style.left = `${rect.left}px`;
    pop.style.top = `${rect.bottom + POPOVER_OFFSET_PX}px`;
    document.body.appendChild(pop);
    this.popover = pop;
  }

  private closePopover(): void {
    this.popover?.remove();
    this.popover = null;
  }
}
