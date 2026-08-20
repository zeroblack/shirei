import { t } from "./i18n";
import {
  buildWorkingMark,
  maybeWaiting,
  needsYou,
  type SessionStateEntry,
  stateTitle,
} from "./sessionstate";
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
  onMemoryOpen?: () => void;
}

const DRAG_THRESHOLD_PX = 4;
// Must match the .tab-shifting transition duration in styles.css.
const TAB_SETTLE_MS = 180;
const POPOVER_OFFSET_PX = 4;
// Lucide "bell": the single needs-you mark. One meaning — this session is
// blocked waiting for you to advance it.
const BELL =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/></svg>';
// Sleeping "Zzz": the tentative "quiet a while — maybe waiting" mark. A
// different silhouette from the bell so a glance never confuses certain (bell)
// with maybe (this); three ascending z's that breathe softly, carrying no
// urgency — the session has gone quiet, it might want you.
const ZZZ =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 14 H8.5 L4.5 18.5 H8.5" stroke-width="1.9"/><path d="M9.5 9 H14 L9.5 14 H14" stroke-width="2.1"/><path d="M14.5 3 H20.5 L14.5 9 H20.5" stroke-width="2.3"/></svg>';

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
  activeDrag: boolean;
  move: (e: PointerEvent) => void;
  up: (e: PointerEvent) => void;
}

type IndicatorMove = "slide" | "hop" | "snap" | "drag" | "shift";

export class TabBar {
  private readonly root: HTMLElement;
  private readonly cb: TabBarCallbacks;
  private readonly indicator: HTMLElement;
  private popover: HTMLElement | null = null;
  private palette: string[];
  private drag: DragState | null = null;
  private suppressClick = false;
  private showAge = false;
  // The Bell fades in once, on the render where a tab first earns it, then
  // holds still until it clears. render() rebuilds the tab DOM on every call,
  // so the set of tabs already wearing a Bell is carried across renders to gate
  // the one-shot entrance.
  private bellShown = new Set<string>();
  // Set by the click handler right before it calls onActivate, cleared at the
  // end of the render that click synchronously triggers. Lets moveMode tell a
  // mouse-driven activation (slide) apart from a keyboard jump (hop/snap) even
  // though both funnel through the same onActivate callback.
  private pointerActivation = false;
  private lastActiveId: string | null = null;
  private lastIds: string[] = [];

  constructor(root: HTMLElement, cb: TabBarCallbacks, palette: string[]) {
    this.root = root;
    this.cb = cb;
    this.palette = palette;
    this.root.setAttribute("role", "tablist");
    this.indicator = document.createElement("div");
    this.indicator.className = "tab-indicator";
    this.indicator.setAttribute("aria-hidden", "true");
    this.indicator.style.opacity = "0";
    this.root.appendChild(this.indicator);
    document.addEventListener("click", () => this.closePopover());
    document.fonts.ready.then(() => this.syncIndicator("snap"));
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

  render(
    tabs: TabState[],
    activeId: string | null,
    states: Map<string, SessionStateEntry>,
    attention: Set<string>,
  ): void {
    const mode = this.moveMode(tabs, activeId);
    const activated = activeId !== this.lastActiveId;

    // The indicator must survive every render untouched: a detached element
    // cancels its running CSS transition, and even replaceChildren(this.indicator)
    // counts as detaching it. Remove everything else, keep it in place.
    for (const child of Array.from(this.root.children)) {
      if (child !== this.indicator) child.remove();
    }

    const activeTab = tabs.find((t) => t.id === activeId);
    const rootStyle = document.documentElement.style;
    if (activeTab?.kind === "terminal" && activeTab.color) {
      rootStyle.setProperty("--active-accent", activeTab.color);
    } else {
      rootStyle.removeProperty("--active-accent");
    }

    const nextBellShown = new Set<string>();
    for (const tab of tabs) {
      const state = states.get(tab.id);
      const showBell =
        tab.kind === "terminal" &&
        state !== undefined &&
        attention.has(tab.id) &&
        needsYou(state);
      // The tentative ring is live and never latched: it shows only while a
      // background tab is quiet-but-maybe-waiting, and clears the instant that
      // tab becomes active. Working (Atom) and the certain Bell take priority.
      const showRing =
        tab.kind === "terminal" &&
        state !== undefined &&
        tab.id !== activeId &&
        !showBell &&
        maybeWaiting(state);
      if (showBell) nextBellShown.add(tab.id);
      this.root.appendChild(
        this.renderTab(
          tab,
          tab.id === activeId,
          state,
          showBell,
          showBell && !this.bellShown.has(tab.id),
          showRing,
        ),
      );
    }
    this.bellShown = nextBellShown;

    const add = document.createElement("button");
    add.className = "tab-add";
    add.textContent = "+";
    add.title = t("ui.tabbar.newTab");
    add.addEventListener("click", (e) => {
      e.stopPropagation();
      this.cb.onNew();
    });
    const addSlot = document.createElement("div");
    addSlot.className = "tab-add-slot";
    addSlot.setAttribute("role", "presentation");
    addSlot.appendChild(add);
    this.root.appendChild(addSlot);

    if (activated) {
      this.root.querySelector<HTMLElement>(".tab.active")?.scrollIntoView({
        inline: "nearest",
        block: "nearest",
        behavior: "instant",
      });
    }
    this.syncIndicator(mode);
    this.lastActiveId = activeId;
    this.lastIds = tabs.map((tab) => tab.id);
    this.pointerActivation = false;
  }

  private moveMode(
    tabs: TabState[],
    activeId: string | null,
  ): "slide" | "hop" | "snap" {
    if (this.pointerActivation) return "slide";
    if (activeId === this.lastActiveId) return "snap";
    const from = this.lastIds.indexOf(this.lastActiveId ?? "");
    const to = tabs.findIndex((t) => t.id === activeId);
    if (from === -1 || to === -1) return "snap";
    if (tabs.length !== this.lastIds.length) return "snap";
    return Math.abs(to - from) === 1 ? "hop" : "snap";
  }

  private syncIndicator(mode: IndicatorMove, dx = 0): void {
    const el = this.root.querySelector<HTMLElement>(".tab.active");
    if (!el) {
      this.indicator.style.opacity = "0";
      return;
    }
    const left = el.offsetLeft + dx;
    const width = el.offsetWidth;
    const unit = this.indicator.offsetWidth;
    const color = el.style.getPropertyValue("--tab-color");
    const transform = `translateX(${left}px) scaleX(${width / unit})`;
    if (mode === "snap" && transform === this.indicator.style.transform) {
      this.indicator.style.opacity = "1";
      this.indicator.style.setProperty("--tab-ind-color", color || "");
      return;
    }
    this.indicator.dataset.move = mode;
    this.indicator.style.opacity = "1";
    this.indicator.style.setProperty("--tab-ind-color", color || "");
    this.indicator.style.transform = transform;
  }

  private renderTab(
    tab: TabState,
    active: boolean,
    state: SessionStateEntry | undefined,
    showBell: boolean,
    animateBell: boolean,
    showRing: boolean,
  ): HTMLElement {
    const el = document.createElement("div");
    el.className = active ? "tab active" : "tab";
    el.setAttribute("role", "tab");
    el.setAttribute("aria-selected", active ? "true" : "false");
    if (showBell) el.classList.add("attn");
    if (showRing) el.classList.add("maybe");
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
      // Guard against a click on the already-active tab: onActivate() then
      // early-returns without a render, and the flag would otherwise linger
      // stale onto whatever unrelated render happens next.
      if (!active) this.pointerActivation = true;
      this.cb.onActivate(tab.id);
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (tab.kind === "terminal") {
        this.openPalette(el, tab.id, tab.pinned, tab.color);
      }
    });

    if (tab.pinned) {
      el.classList.add("pinned");
      const pin = document.createElement("span");
      pin.className = "tab-pin";
      pin.textContent = "★";
      el.appendChild(pin);
    }

    if (tab.memory) {
      const badge = document.createElement("span");
      badge.className = "tab-memory";
      badge.dataset.state = tab.memory;
      badge.textContent = "M";
      badge.title =
        tab.memory === "stale"
          ? t("ui.memory.badgeStale")
          : t("ui.memory.badge");
      badge.setAttribute("role", "button");
      badge.tabIndex = 0;
      const openMemory = (e: Event) => {
        e.stopPropagation();
        this.cb.onMemoryOpen?.();
      };
      badge.onclick = openMemory;
      badge.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openMemory(e);
        }
      };
      el.appendChild(badge);
    }

    if (tab.kind === "terminal") {
      const mark = this.buildStateMark(state, showBell, animateBell, showRing);
      if (mark) el.appendChild(mark);
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
    close.setAttribute(
      "aria-label",
      t("ui.tabbar.closeTab", { title: tab.title }),
    );
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

  // The tab carries exactly one mark: the Atom while output flows, the Bell
  // when the session is blocked waiting for the user (needs-you, held until the
  // tab is visited), and nothing otherwise — idle, done, and errored are calm.
  // The mark renders on every tab regardless of project color; identity lives
  // in the separate always-on left-edge bar.
  private buildStateMark(
    state: SessionStateEntry | undefined,
    showBell: boolean,
    animateBell: boolean,
    showRing: boolean,
  ): HTMLElement | null {
    if (state?.state.kind === "working") {
      const mark = document.createElement("span");
      mark.className = "tab-state";
      mark.title = stateTitle(state);
      buildWorkingMark(mark);
      return mark;
    }
    if (showBell && state) {
      const mark = document.createElement("span");
      mark.className = "tab-mark tab-bell";
      if (animateBell) mark.classList.add("mark-in");
      mark.title = stateTitle(state);
      mark.innerHTML = BELL;
      return mark;
    }
    if (showRing && state) {
      const mark = document.createElement("span");
      mark.className = "tab-mark tab-zzz";
      mark.title = stateTitle(state);
      mark.innerHTML = ZZZ;
      return mark;
    }
    return null;
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
    if (target.closest(".tab-close, .tab-rename")) return;
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
      activeDrag: false,
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
    if (d.activeDrag) this.syncIndicator("drag", dx);
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
    d.activeDrag = d.el.classList.contains("active");
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
      if (d.els[i].classList.contains("active")) {
        this.syncIndicator("shift", shift);
      }
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
    this.syncIndicator("shift");
    window.setTimeout(() => {
      for (const t of d.els) {
        t.classList.remove("tab-shifting");
        t.style.transform = "";
      }
      this.syncIndicator("snap");
    }, TAB_SETTLE_MS);
  }

  private openPalette(
    anchor: HTMLElement,
    id: string,
    pinned: boolean,
    color: string | null,
  ): void {
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
    for (const swatchColor of this.palette) {
      const swatch = document.createElement("button");
      swatch.className = "swatch";
      if (swatchColor === color) swatch.classList.add("current");
      swatch.style.background = swatchColor;
      swatch.addEventListener("click", () => {
        this.cb.onRecolor(id, swatchColor);
        this.closePopover();
      });
      swatches.appendChild(swatch);
    }

    const clear = document.createElement("button");
    clear.className = "swatch swatch-clear";
    if (color === null) clear.classList.add("current");
    clear.textContent = "∅";
    clear.title = t("ui.tabbar.noColor");
    clear.addEventListener("click", () => {
      this.cb.onRecolor(id, null);
      this.closePopover();
    });
    swatches.appendChild(clear);
    pop.appendChild(swatches);

    document.body.appendChild(pop);
    this.positionPopover(pop, anchor.getBoundingClientRect());
    this.popover = pop;
  }

  private positionPopover(pop: HTMLElement, anchorRect: DOMRect): void {
    const margin = 8;
    const rect = pop.getBoundingClientRect();

    const preferredLeft = anchorRect.left;
    const clampedLeft = Math.min(
      preferredLeft,
      window.innerWidth - rect.width - margin,
    );
    const left = Math.max(margin, clampedLeft);
    const flippedX = clampedLeft < preferredLeft;

    const preferredTop = anchorRect.bottom + POPOVER_OFFSET_PX;
    const flippedY = preferredTop + rect.height > window.innerHeight - margin;
    const top = flippedY
      ? Math.max(margin, anchorRect.top - rect.height - POPOVER_OFFSET_PX)
      : preferredTop;

    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    pop.style.transformOrigin = `${flippedY ? "bottom" : "top"} ${flippedX ? "right" : "left"}`;
    if (flippedY) pop.dataset.flip = "up";
  }

  private closePopover(): void {
    this.popover?.remove();
    this.popover = null;
  }
}
