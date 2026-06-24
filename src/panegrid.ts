import type { RenderConfig, TerminalColors } from "./config";
import { attachDrag } from "./drag";
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
}

let paneSeq = 0;
function nextPaneId(): string {
  paneSeq += 1;
  return `p${Date.now().toString(36)}${paneSeq}`;
}

interface Pane {
  session: TerminalSession;
  el: HTMLElement;
}

export class PaneGrid {
  private readonly host: HTMLElement;
  private readonly cb: PaneGridCallbacks;
  private tree: PaneNode;
  private readonly panes = new Map<string, Pane>();
  private activeLeafId: string;
  private zoomed = false;
  private visible = true;

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
    await Promise.all(
      [...this.panes.values()].map(({ session }) => session.open()),
    );
    this.fitAll();
    this.setActive(this.activeLeafId);
  }

  private createPane(leaf: PaneLeaf): void {
    const el = document.createElement("div");
    el.className = "pane-leaf";
    const session = this.cb.makeSession(leaf.id, el, {
      cwd: leaf.cwd,
      command: leaf.command,
      lastCommand: leaf.lastCommand,
    });
    session.onExit = () => this.closePane(leaf.id);
    el.addEventListener("mousedown", () => this.setActive(leaf.id), true);
    session.setVisible(this.visible);
    this.panes.set(leaf.id, { session, el });
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
      ?.session.open()
      .then(() => this.setActive(id));
  }

  closePane(id?: string): void {
    const target = id ?? this.activeLeafId;
    const next = closeLeaf(this.tree, target);
    const pane = this.panes.get(target);
    if (pane) {
      void pane.session.dispose();
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
    this.highlightActive();
    this.refreshActiveState();
    pane.session.fitAndResize();
    pane.session.focus();
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
    void this.panes.get(this.activeLeafId)?.session.reconnect();
  }

  killActive(): void {
    void this.panes.get(this.activeLeafId)?.session.killSession();
  }

  scrollActive(lines: number): void {
    this.panes.get(this.activeLeafId)?.session.scrollByLines(lines);
  }

  copyLineActive(): void {
    this.panes.get(this.activeLeafId)?.session.copyLine();
  }

  pasteActive(): void {
    this.panes.get(this.activeLeafId)?.session.paste();
  }

  private highlightActive(): void {
    const multi = this.panes.size > 1;
    for (const [id, { el }] of this.panes) {
      el.classList.toggle("active", multi && id === this.activeLeafId);
    }
  }

  private refreshActiveState(): void {
    for (const [id, { session }] of this.panes) {
      session.setCursorBlink(this.visible && id === this.activeLeafId);
      if (this.visible && id !== this.activeLeafId) session.markHot();
    }
    // Hidden panes keep their context instead of releasing it on every tab
    // switch: churning contexts is what exhausts WebKit and garbles panes.
    // The pool's LRU evicts the coldest only when live contexts exceed the cap.
    if (this.visible) this.panes.get(this.activeLeafId)?.session.markHot();
  }

  fitAll(): void {
    for (const { session } of this.panes.values()) session.fitAndResize();
  }

  recoverRenderers(hard: boolean): void {
    for (const { session } of this.panes.values()) void session.recover(hard);
  }

  show(visible: boolean): void {
    this.visible = visible;
    this.host.classList.toggle("active", visible);
    for (const { session } of this.panes.values()) session.setVisible(visible);
    this.refreshActiveState();
    if (visible) this.fitAll();
  }

  focus(): void {
    this.panes.get(this.activeLeafId)?.session.focus();
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
    for (const { session } of this.panes.values())
      session.applyLook(family, size, render, theme);
    this.refreshActiveState();
  }

  setAccent(color: string | null): void {
    if (color) this.host.style.setProperty("--tab-color", color);
    else this.host.style.removeProperty("--tab-color");
  }

  serialize(): PaneNode {
    return structuredClone(this.tree);
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
    for (const { session } of this.panes.values())
      total += session.scrollbackWeight();
    return total;
  }

  async dispose(): Promise<void> {
    await Promise.all(
      [...this.panes.values()].map(({ session }) => session.dispose()),
    );
    this.panes.clear();
    this.host.remove();
  }
}
