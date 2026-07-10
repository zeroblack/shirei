import type { RenderConfig, TerminalColors } from "./config";
import { attachDrag } from "./drag";
import { PaneCluster } from "./panecluster";
import {
  canAdd,
  type FileTargetCandidate,
  nextIndex,
  type PaneContentKind,
  type PaneContentSession,
} from "./panecontent";
import {
  closeLeaf,
  type Dir,
  leaves,
  type PaneLeaf,
  type PaneNode,
  splitLeaf,
} from "./panetree";
import type { TerminalSession } from "./terminal";

export type FocusDir = "left" | "right" | "up" | "down";

export type LeafSpawn = Pick<PaneLeaf, "cwd" | "command" | "lastCommand">;

export interface PaneGridCallbacks {
  makeSession: (
    id: string,
    container: HTMLElement,
    leaf: LeafSpawn,
  ) => TerminalSession;
  onEmpty: () => void;
  onActivePane?: () => void;
  cwdOf?: (ptyId: string) => Promise<string | undefined>;
  contentCap: () => number;
  onContentChange?: () => void;
  onPickContent?: (paneId: string) => void;
  onCloseContent?: (paneId: string) => void;
}

let paneSeq = 0;
function nextPaneId(): string {
  paneSeq += 1;
  return `p${Date.now().toString(36)}${paneSeq}`;
}

interface PaneStackEntry {
  kind: "file" | "browser";
  session: PaneContentSession;
  container: HTMLElement;
  path?: string;
  title: string;
  dirty: boolean;
}

export interface DetachedContent {
  kind: "file" | "browser";
  session: PaneContentSession;
  container: HTMLElement;
  path?: string;
  title: string;
}

interface Pane {
  el: HTMLElement;
  terminal: TerminalSession;
  termContainer: HTMLElement;
  contents: PaneStackEntry[];
  activeIndex: number;
  lastActiveSeq: number;
  cluster: PaneCluster;
}

export class PaneGrid {
  private readonly host: HTMLElement;
  private readonly cb: PaneGridCallbacks;
  private tree: PaneNode;
  private readonly panes = new Map<string, Pane>();
  private activeLeafId: string;
  private zoomed = false;
  private visible = true;
  private activeSeq = 0;

  constructor(host: HTMLElement, tree: PaneNode, cb: PaneGridCallbacks) {
    this.host = host;
    this.cb = cb;
    this.tree = tree;
    for (const leaf of leaves(tree)) this.createPane(leaf);
    this.activeLeafId = leaves(tree)[0].id;
    this.render();
  }

  async open(): Promise<void> {
    // Spawns are independent; opening serially would cost one IPC round-trip
    // per pane before anything renders.
    await Promise.all([...this.panes.values()].map((p) => p.terminal.open()));
    this.fitAll();
    this.setActive(this.activeLeafId);
  }

  private createPane(leaf: PaneLeaf): void {
    const el = document.createElement("div");
    el.className = "pane-leaf";
    const termContainer = document.createElement("div");
    termContainer.className = "pane-content pane-content-active";
    el.appendChild(termContainer);
    const session = this.cb.makeSession(leaf.id, termContainer, {
      cwd: leaf.cwd,
      command: leaf.command,
      lastCommand: leaf.lastCommand,
    });
    session.onExit = () => this.closePane(leaf.id);
    el.addEventListener("mousedown", () => this.setActive(leaf.id), true);
    session.setVisible(this.visible);
    const cluster = new PaneCluster(el, {
      onSelect: (index) => {
        this.setActive(leaf.id);
        this.switchContent(index);
      },
      onPick: () => {
        this.setActive(leaf.id);
        this.cb.onPickContent?.(leaf.id);
      },
      onClose: (index) => {
        this.setActive(leaf.id);
        this.switchContent(index);
        this.cb.onCloseContent?.(leaf.id);
      },
    });
    this.panes.set(leaf.id, {
      el,
      terminal: session,
      termContainer,
      contents: [],
      activeIndex: 0,
      lastActiveSeq: 0,
      cluster,
    });
  }

  private render(): void {
    for (const { el } of this.panes.values()) {
      el.classList.remove("pane-root", "zoomed");
    }
    const root = this.renderNode(this.tree);
    root.classList.add("pane-root");
    this.host.replaceChildren(root);
    this.highlightActive();
    this.fitAll();
    for (const pane of this.panes.values()) this.refreshCluster(pane);
  }

  private renderNode(node: PaneNode): HTMLElement {
    if (node.kind === "leaf") {
      const pane = this.panes.get(node.id);
      if (!pane) throw new Error(`pane without a session: ${node.id}`);
      return pane.el;
    }
    const split = document.createElement("div");
    split.className = `pane-split ${node.dir}`;
    const a = this.renderNode(node.a);
    const b = this.renderNode(node.b);
    a.style.flex = `${node.ratio}`;
    b.style.flex = `${1 - node.ratio}`;
    const divider = document.createElement("div");
    divider.className = "pane-divider";
    this.attachDividerDrag(divider, split, node, a, b);
    split.append(a, divider, b);
    return split;
  }

  private attachDividerDrag(
    divider: HTMLElement,
    split: HTMLElement,
    node: { dir: Dir; ratio: number },
    a: HTMLElement,
    b: HTMLElement,
  ): void {
    const horizontal = node.dir === "h";
    attachDrag(divider, {
      onMove: (ev) => {
        const rect = split.getBoundingClientRect();
        const total = horizontal ? rect.width : rect.height;
        const start = horizontal ? rect.left : rect.top;
        const pos = (horizontal ? ev.clientX : ev.clientY) - start;
        const ratio = Math.max(0.1, Math.min(0.9, pos / total));
        node.ratio = ratio;
        a.style.flex = `${ratio}`;
        b.style.flex = `${1 - ratio}`;
        this.fitAll();
      },
      onEnd: () => this.fitAll(),
    });
  }

  async split(dir: Dir): Promise<void> {
    if (this.zoomed) this.toggleZoom();
    const cwd = await this.cb.cwdOf?.(this.activeLeafId);
    const id = nextPaneId();
    const leaf: PaneLeaf = { kind: "leaf", id, cwd };
    this.tree = splitLeaf(this.tree, this.activeLeafId, dir, leaf);
    this.createPane(leaf);
    this.render();
    void this.panes
      .get(id)
      ?.terminal.open()
      .then(() => this.setActive(id));
  }

  closePane(id?: string): void {
    const target = id ?? this.activeLeafId;
    const next = closeLeaf(this.tree, target);
    const pane = this.panes.get(target);
    if (pane) {
      for (const c of pane.contents) void c.session.dispose();
      pane.cluster.dispose();
      void pane.terminal.dispose();
      this.panes.delete(target);
    }
    if (next === null) {
      this.cb.onEmpty();
      return;
    }
    this.tree = next;
    this.zoomed = false;
    if (!this.panes.has(this.activeLeafId)) {
      this.activeLeafId = leaves(this.tree)[0].id;
    }
    this.render();
    this.setActive(this.activeLeafId);
  }

  focusDir(dir: FocusDir): boolean {
    const active = this.panes.get(this.activeLeafId);
    if (!active) return false;
    const r = active.el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let best: { id: string; dist: number } | null = null;
    for (const [id, { el }] of this.panes) {
      if (id === this.activeLeafId) continue;
      const o = el.getBoundingClientRect();
      const ox = o.left + o.width / 2;
      const oy = o.top + o.height / 2;
      const inDir =
        (dir === "left" && ox < cx) ||
        (dir === "right" && ox > cx) ||
        (dir === "up" && oy < cy) ||
        (dir === "down" && oy > cy);
      if (!inDir) continue;
      const dist = Math.hypot(ox - cx, oy - cy);
      if (!best || dist < best.dist) best = { id, dist };
    }
    if (!best) return false;
    this.setActive(best.id);
    return true;
  }

  toggleZoom(): void {
    const active = this.panes.get(this.activeLeafId);
    if (!active) return;
    this.zoomed = !this.zoomed;
    if (this.zoomed) {
      active.el.classList.add("pane-root", "zoomed");
      this.host.replaceChildren(active.el);
    } else {
      this.render();
    }
    this.fitAll();
  }

  setActive(id: string): void {
    const pane = this.panes.get(id);
    if (!pane) return;
    this.activeLeafId = id;
    this.activeSeq += 1;
    pane.lastActiveSeq = this.activeSeq;
    this.highlightActive();
    this.refreshActiveState();
    if (pane.activeIndex === 0) pane.terminal.fitAndResize();
    this.activeSession(pane).focus();
    this.cb.onActivePane?.();
  }

  activePtyId(): string {
    return this.activeLeafId;
  }

  activeRect(): { x: number; y: number; width: number; height: number } | null {
    const pane = this.panes.get(this.activeLeafId);
    if (!pane) return null;
    const r = pane.el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }

  activeCwd(): string | undefined {
    return leaves(this.tree).find((l) => l.id === this.activeLeafId)?.cwd;
  }

  reconnectActive(): void {
    void this.panes.get(this.activeLeafId)?.terminal.reconnect();
  }

  reconnectAll(): void {
    for (const pane of this.panes.values()) void pane.terminal.reconnect();
  }

  killActive(): void {
    void this.panes.get(this.activeLeafId)?.terminal.killSession();
  }

  scrollActive(lines: number): void {
    this.panes.get(this.activeLeafId)?.terminal.scrollByLines(lines);
  }

  copyLineActive(): void {
    this.panes.get(this.activeLeafId)?.terminal.copyLine();
  }

  pasteActive(): void {
    this.panes.get(this.activeLeafId)?.terminal.paste();
  }

  private highlightActive(): void {
    const multi = this.panes.size > 1;
    for (const [id, { el }] of this.panes) {
      el.classList.toggle("active", multi && id === this.activeLeafId);
    }
  }

  private refreshActiveState(): void {
    for (const [id, pane] of this.panes) {
      pane.terminal.setCursorBlink(this.visible && id === this.activeLeafId);
      if (this.visible && id !== this.activeLeafId) pane.terminal.markHot();
    }
    // Hidden panes keep their context instead of releasing it on every tab
    // switch: churning contexts is what exhausts WebKit and garbles panes.
    // The pool's LRU evicts the coldest only when live contexts exceed the cap.
    if (this.visible) this.panes.get(this.activeLeafId)?.terminal.markHot();
  }

  fitAll(): void {
    for (const pane of this.panes.values()) pane.terminal.fitAndResize();
  }

  recoverRenderers(hard: boolean): void {
    for (const pane of this.panes.values()) void pane.terminal.recover(hard);
  }

  show(visible: boolean): void {
    this.visible = visible;
    this.host.classList.toggle("active", visible);
    for (const pane of this.panes.values()) this.applyContentVisibility(pane);
    this.refreshActiveState();
    if (visible) this.fitAll();
  }

  focus(): void {
    const pane = this.panes.get(this.activeLeafId);
    if (pane) this.activeSession(pane).focus();
  }

  fitAndResize(): void {
    this.fitAll();
  }

  applyLook(
    family: string,
    size: number,
    render: RenderConfig,
    theme: TerminalColors,
  ): void {
    for (const pane of this.panes.values())
      pane.terminal.applyLook(family, size, render, theme);
    this.refreshActiveState();
  }

  applyContentLook(apply: (session: PaneContentSession) => void): void {
    for (const pane of this.panes.values())
      for (const c of pane.contents) apply(c.session);
  }

  setAccent(color: string | null): void {
    if (color) this.host.style.setProperty("--tab-color", color);
    else this.host.style.removeProperty("--tab-color");
  }

  private activeSession(pane: Pane): TerminalSession | PaneContentSession {
    return pane.activeIndex === 0
      ? pane.terminal
      : pane.contents[pane.activeIndex - 1].session;
  }

  private activeContainer(pane: Pane): HTMLElement {
    return pane.activeIndex === 0
      ? pane.termContainer
      : pane.contents[pane.activeIndex - 1].container;
  }

  private applyContentVisibility(pane: Pane): void {
    const active = this.activeContainer(pane);
    pane.termContainer.classList.toggle(
      "pane-content-active",
      pane.termContainer === active,
    );
    for (const c of pane.contents) {
      c.container.classList.toggle(
        "pane-content-active",
        c.container === active,
      );
    }
    pane.terminal.setVisible(this.visible && pane.activeIndex === 0);
  }

  private stackLen(pane: Pane): number {
    return 1 + pane.contents.length;
  }

  private notifyContent(): void {
    this.cb.onContentChange?.();
  }

  private idOf(pane: Pane): string {
    for (const [id, p] of this.panes) if (p === pane) return id;
    return this.activeLeafId;
  }

  private refreshCluster(pane: Pane): void {
    pane.cluster.render(this.descriptorsOf(this.idOf(pane)));
  }

  private activate(pane: Pane, index: number): void {
    pane.activeIndex = index;
    this.applyContentVisibility(pane);
    if (index === 0) {
      pane.terminal.fitAndResize();
      // The terminal was display:none behind the file content, so its renderer
      // can strand blank; force a repaint now that it is shown again.
      void pane.terminal.recover(false);
    }
    this.activeSession(pane).focus();
    this.notifyContent();
    this.refreshCluster(pane);
  }

  addFileContent(
    paneId: string,
    entry: {
      session: PaneContentSession;
      container: HTMLElement;
      path?: string;
      title: string;
      kind?: "file" | "browser";
    },
  ): boolean {
    const pane = this.panes.get(paneId);
    if (!pane) return false;
    if (!canAdd(this.stackLen(pane), this.cb.contentCap())) return false;
    entry.container.classList.add("pane-content");
    pane.el.appendChild(entry.container);
    pane.contents.push({
      kind: entry.kind ?? "file",
      session: entry.session,
      container: entry.container,
      path: entry.path,
      title: entry.title,
      dirty: false,
    });
    this.activate(pane, pane.contents.length);
    return true;
  }

  replaceActiveFile(
    paneId: string,
    entry: {
      session: PaneContentSession;
      container: HTMLElement;
      path?: string;
      title: string;
      kind?: "file" | "browser";
    },
  ): void {
    const pane = this.panes.get(paneId);
    if (!pane || pane.activeIndex === 0) {
      this.addFileContent(paneId, entry);
      return;
    }
    const slot = pane.contents[pane.activeIndex - 1];
    void slot.session.dispose();
    slot.container.remove();
    entry.container.classList.add("pane-content");
    pane.el.appendChild(entry.container);
    pane.contents[pane.activeIndex - 1] = {
      kind: entry.kind ?? "file",
      session: entry.session,
      container: entry.container,
      path: entry.path,
      title: entry.title,
      dirty: false,
    };
    this.activate(pane, pane.activeIndex);
  }

  activeContentIsFile(paneId: string): boolean {
    const pane = this.panes.get(paneId);
    return !!pane && pane.activeIndex > 0;
  }

  activeContentIsBrowser(paneId: string): boolean {
    const pane = this.panes.get(paneId);
    if (!pane || pane.activeIndex === 0) return false;
    return pane.contents[pane.activeIndex - 1].kind === "browser";
  }

  // Every browser stack entry across every pane, active or not: the caller
  // (the visibility authority) must be able to hide a browser that was just
  // demoted behind a terminal, which only enumerating active ones would miss.
  browserSessions(): { paneId: string; session: PaneContentSession }[] {
    const out: { paneId: string; session: PaneContentSession }[] = [];
    for (const [paneId, pane] of this.panes) {
      for (const c of pane.contents) {
        if (c.kind === "browser") out.push({ paneId, session: c.session });
      }
    }
    return out;
  }

  cycleContent(dir: 1 | -1): void {
    const pane = this.panes.get(this.activeLeafId);
    if (!pane) return;
    this.activate(pane, nextIndex(this.stackLen(pane), pane.activeIndex, dir));
  }

  switchContent(index: number): void {
    const pane = this.panes.get(this.activeLeafId);
    if (!pane || index < 0 || index >= this.stackLen(pane)) return;
    this.activate(pane, index);
  }

  switchContentIn(paneId: string, index: number): void {
    const pane = this.panes.get(paneId);
    if (!pane || index < 0 || index >= this.stackLen(pane)) return;
    this.activate(pane, index);
  }

  closeActiveContent(): void {
    const pane = this.panes.get(this.activeLeafId);
    if (!pane || pane.activeIndex === 0) return;
    const [removed] = pane.contents.splice(pane.activeIndex - 1, 1);
    void removed.session.dispose();
    removed.container.remove();
    this.activate(pane, 0);
  }

  // Lifts the active content out of the pane without disposing it, so the caller
  // can re-parent its live session elsewhere (the pinned dock). If that leaves
  // the pane empty and it is one of several, the pane collapses so the grid
  // reflows; the sole pane of a tab is kept alive, reverting to its terminal.
  detachActiveContent(): DetachedContent | null {
    const pane = this.panes.get(this.activeLeafId);
    if (!pane || pane.activeIndex === 0) return null;
    const [removed] = pane.contents.splice(pane.activeIndex - 1, 1);
    const detached: DetachedContent = {
      session: removed.session,
      container: removed.container,
      path: removed.path,
      title: removed.title,
      kind: removed.kind,
    };
    if (pane.contents.length === 0 && leaves(this.tree).length > 1) {
      this.closePane(this.activeLeafId);
    } else {
      this.activate(pane, 0);
    }
    return detached;
  }

  setContentDirty(paneId: string, dirty: boolean): void {
    const pane = this.panes.get(paneId);
    if (!pane || pane.activeIndex === 0) return;
    pane.contents[pane.activeIndex - 1].dirty = dirty;
    this.notifyContent();
  }

  activePaneId(): string {
    return this.activeLeafId;
  }

  contentCandidates(): FileTargetCandidate[] {
    return [...this.panes.entries()].map(([id, pane]) => ({
      paneId: id,
      focused: id === this.activeLeafId,
      hasFile: pane.contents.length > 0,
      recency: pane.lastActiveSeq,
    }));
  }

  // A file already loaded in this grid, so an open can reveal it in place
  // instead of creating a duplicate view.
  locateFile(path: string): { paneId: string; index: number } | null {
    for (const [id, pane] of this.panes) {
      const i = pane.contents.findIndex((c) => c.path === path);
      if (i >= 0) return { paneId: id, index: i + 1 };
    }
    return null;
  }

  activeContentPath(paneId: string): string | undefined {
    const pane = this.panes.get(paneId);
    if (!pane || pane.activeIndex === 0) return undefined;
    return pane.contents[pane.activeIndex - 1].path;
  }

  activeContentDirty(paneId: string): boolean {
    const pane = this.panes.get(paneId);
    if (!pane || pane.activeIndex === 0) return false;
    return pane.contents[pane.activeIndex - 1].dirty;
  }

  activeContentSession(paneId: string): PaneContentSession | undefined {
    const pane = this.panes.get(paneId);
    if (!pane || pane.activeIndex === 0) return undefined;
    return pane.contents[pane.activeIndex - 1].session;
  }

  activeContentTitle(paneId: string): string {
    const pane = this.panes.get(paneId);
    if (!pane || pane.activeIndex === 0) return "";
    return pane.contents[pane.activeIndex - 1].title;
  }

  // Any pane in this tab holds an unsaved file, so a tab/pane teardown would
  // drop edits without asking.
  hasDirtyContent(): boolean {
    for (const pane of this.panes.values())
      if (pane.contents.some((c) => c.dirty)) return true;
    return false;
  }

  private activeIsChooser(pane: Pane): boolean {
    if (pane.activeIndex === 0) return false;
    const active = pane.contents[pane.activeIndex - 1];
    return active.kind === "file" && active.path === undefined;
  }

  // Whether a file open can land in this pane: replacing an empty chooser slot
  // never grows the stack, so it always fits; otherwise it needs room.
  canAcceptFile(paneId: string): boolean {
    const pane = this.panes.get(paneId);
    if (!pane) return false;
    return (
      this.activeIsChooser(pane) ||
      canAdd(this.stackLen(pane), this.cb.contentCap())
    );
  }

  activeContentIsChooser(paneId: string): boolean {
    const pane = this.panes.get(paneId);
    return !!pane && this.activeIsChooser(pane);
  }

  descriptorsOf(paneId: string): {
    kind: PaneContentKind;
    title: string;
    dirty: boolean;
    active: boolean;
  }[] {
    const pane = this.panes.get(paneId);
    if (!pane) return [];
    return [
      {
        kind: "terminal" as const,
        title: "terminal",
        dirty: false,
        active: pane.activeIndex === 0,
      },
      ...pane.contents.map((c, i) => ({
        kind: c.kind,
        title: c.title,
        dirty: c.dirty,
        active: pane.activeIndex === i + 1,
      })),
    ];
  }

  serialize(): PaneNode {
    this.syncContents();
    return structuredClone(this.tree);
  }

  private syncContents(): void {
    const write = (node: PaneNode): void => {
      if (node.kind === "leaf") {
        const pane = this.panes.get(node.id);
        if (pane) {
          node.contents = pane.contents
            .filter((c) => c.path)
            .map((c) => {
              if (c.kind === "browser")
                return { kind: "browser" as const, url: c.path as string };
              return { kind: "file" as const, path: c.path as string };
            });
          node.activeContent = pane.activeIndex;
        }
        return;
      }
      write(node.a);
      write(node.b);
    };
    write(this.tree);
  }

  applySnapshot(snap: Map<string, { cwd?: string; command?: string }>): void {
    const apply = (node: PaneNode): void => {
      if (node.kind === "leaf") {
        const s = snap.get(node.id);
        if (s) {
          // Undefined cwd means it was not resolved this cycle; keep the last
          // known value rather than persisting a wrong fallback.
          if (s.cwd) node.cwd = s.cwd;
          // Observed state goes to lastCommand, never to the declared command:
          // restore decides via config whether captured commands re-run.
          node.lastCommand = s.command ?? null;
        }
        return;
      }
      apply(node.a);
      apply(node.b);
    };
    apply(this.tree);
  }

  leafIds(): string[] {
    return leaves(this.tree).map((l) => l.id);
  }

  scrollbackWeight(): number {
    let total = 0;
    for (const pane of this.panes.values())
      total += pane.terminal.scrollbackWeight();
    return total;
  }

  async dispose(): Promise<void> {
    await Promise.all(
      [...this.panes.values()].flatMap((p) => [
        ...p.contents.map((c) => Promise.resolve(c.session.dispose())),
        p.terminal.dispose(),
      ]),
    );
    this.panes.clear();
    this.host.remove();
  }
}
