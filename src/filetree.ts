import { readDir, revealInFinder } from "./commands";
import { t } from "./i18n";
import { CHEVRON, fileIcon } from "./icons";
import type { DirEntry } from "./types";

export interface FileTreeCallbacks {
  onOpenFile: (path: string) => void;
  onEscape?: () => void;
}

interface Row {
  el: HTMLElement;
  icon: HTMLElement;
  entry: DirEntry;
  depth: number;
  expanded: boolean;
  note?: HTMLElement;
}

export class FileTree {
  private readonly root: HTMLElement;
  private readonly cb: FileTreeCallbacks;
  private readonly header: HTMLElement;
  private readonly focusHintEl: HTMLElement;
  private readonly list: HTMLElement;
  private rootPath = "";
  private home = "";
  private rows: Row[] = [];
  private selected = 0;
  private highlightedEl: HTMLElement | null = null;
  private menu: HTMLElement | null = null;
  private refreshing = false;

  constructor(root: HTMLElement, cb: FileTreeCallbacks) {
    this.root = root;
    this.root.tabIndex = -1;
    this.cb = cb;
    this.header = document.createElement("div");
    this.header.className = "tree-header";
    this.focusHintEl = document.createElement("kbd");
    this.focusHintEl.className = "tree-focus-hint";
    this.focusHintEl.style.display = "none";
    this.list = document.createElement("div");
    this.list.className = "tree-list";
    this.root.append(this.header, this.list);
    this.root.addEventListener("keydown", (e) => this.onKey(e));
    document.addEventListener("click", () => this.closeMenu());
  }

  setHome(home: string): void {
    this.home = home;
  }

  selectedPath(): string | null {
    return this.rows[this.selected]?.entry.path ?? null;
  }

  async setRoot(path: string): Promise<void> {
    this.rootPath = path;
    this.renderHeader(path);
    this.list.replaceChildren();
    this.selected = 0;
    this.highlightedEl = null;
    const { entries, truncated } = await readDir(path);
    this.rows = entries.map((e) => this.makeRow(e, 0));
    for (const r of this.rows) this.list.appendChild(r.el);
    if (truncated) this.list.appendChild(this.makeNote(0));
    this.highlight();
  }

  /** Re-reads the root and every expanded folder, reconciling against the
   *  current rows so new files appear and deleted ones vanish without
   *  collapsing folders, dropping the selection, or jumping the scroll. */
  async refresh(): Promise<void> {
    if (!this.rootPath || this.refreshing) return;
    this.refreshing = true;
    try {
      const selPath = this.selectedPath();
      const scrollTop = this.list.scrollTop;
      const byPath = new Map(this.rows.map((r) => [r.entry.path, r] as const));
      const rows: Row[] = [];
      const els: HTMLElement[] = [];
      const rootNote = await this.collectChildren(
        this.rootPath,
        0,
        byPath,
        rows,
        els,
      );
      if (rootNote) els.push(rootNote);
      this.rows = rows;
      this.patchList(els);
      const idx = selPath
        ? rows.findIndex((r) => r.entry.path === selPath)
        : -1;
      this.selected =
        idx >= 0
          ? idx
          : Math.min(Math.max(this.selected, 0), Math.max(rows.length - 1, 0));
      this.highlightedEl?.classList.remove("selected");
      this.highlightedEl = null;
      this.highlight();
      this.list.scrollTop = scrollTop;
    } finally {
      this.refreshing = false;
    }
  }

  private async collectChildren(
    path: string,
    depth: number,
    byPath: Map<string, Row>,
    rows: Row[],
    els: HTMLElement[],
  ): Promise<HTMLElement | null> {
    const listing = await readDir(path).catch(() => null);
    if (!listing) return null;
    for (const e of listing.entries) {
      const row = this.reuseOrMake(e, depth, byPath);
      rows.push(row);
      els.push(row.el);
      if (e.is_dir && row.expanded) {
        const note = await this.collectChildren(
          e.path,
          depth + 1,
          byPath,
          rows,
          els,
        );
        row.note = note ?? undefined;
        if (note) els.push(note);
      } else {
        row.note = undefined;
      }
    }
    return listing.truncated ? this.makeNote(depth) : null;
  }

  private reuseOrMake(
    entry: DirEntry,
    depth: number,
    byPath: Map<string, Row>,
  ): Row {
    const prev = byPath.get(entry.path);
    if (prev && prev.entry.is_dir === entry.is_dir) {
      prev.entry = entry;
      if (prev.depth !== depth) {
        prev.depth = depth;
        prev.el.style.paddingLeft = `${6 + depth * 12}px`;
      }
      return prev;
    }
    return this.makeRow(entry, depth);
  }

  /** Keyed reconcile: reuses surviving nodes (no flicker), drops the gone,
   *  inserts the new in sorted position. */
  private patchList(next: HTMLElement[]): void {
    const keep = new Set<HTMLElement>(next);
    for (const child of Array.from(this.list.children)) {
      if (!keep.has(child as HTMLElement)) this.list.removeChild(child);
    }
    next.forEach((el, i) => {
      const current = this.list.children[i];
      if (current !== el) this.list.insertBefore(el, current ?? null);
    });
  }

  private makeNote(depth: number): HTMLElement {
    const note = document.createElement("div");
    note.className = "tree-note";
    note.style.paddingLeft = `${6 + depth * 12}px`;
    note.textContent = t("ui.filetree.truncated");
    return note;
  }

  private renderHeader(path: string): void {
    const icon = document.createElement("span");
    icon.className = "tree-header-icon";
    icon.innerHTML = fileIcon("", true, true);
    const name = document.createElement("span");
    name.className = "tree-header-name";
    name.textContent = this.shortPath(path);
    this.header.title = this.fullDisplay(path);
    this.header.replaceChildren(icon, name, this.focusHintEl);
  }

  setFocusHint(stroke: string): void {
    this.focusHintEl.textContent = stroke;
    this.focusHintEl.style.display = stroke ? "" : "none";
  }

  focus(): void {
    this.root.focus();
  }

  hasFocus(): boolean {
    return this.root.contains(document.activeElement);
  }

  private fullDisplay(path: string): string {
    const p = path.replace(/\/$/, "");
    if (this.home && (p === this.home || p.startsWith(`${this.home}/`))) {
      return `~${p.slice(this.home.length)}`;
    }
    return p || "/";
  }

  private shortPath(path: string): string {
    const full = this.fullDisplay(path);
    const segs = full.split("/").filter(Boolean);
    if (segs.length > 3) return `…/${segs.slice(-2).join("/")}`;
    return full;
  }

  private makeRow(entry: DirEntry, depth: number): Row {
    const el = document.createElement("div");
    el.className = "tree-row";
    el.style.paddingLeft = `${6 + depth * 12}px`;

    const twist = document.createElement("span");
    twist.className = "tree-twist";
    if (entry.is_dir) twist.innerHTML = CHEVRON;

    const icon = document.createElement("span");
    icon.className = "tree-icon";
    icon.innerHTML = fileIcon(entry.name, entry.is_dir, false);

    const name = document.createElement("span");
    name.className = "tree-name";
    name.textContent = entry.name;

    el.append(twist, icon, name);
    const row: Row = { el, icon, entry, depth, expanded: false };
    el.addEventListener("click", () => {
      this.selected = this.rows.indexOf(row);
      this.highlight();
      void this.activate(row);
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.selected = this.rows.indexOf(row);
      this.highlight();
      this.openMenu(e.clientX, e.clientY, row.entry.path);
    });
    return row;
  }

  private openMenu(x: number, y: number, path: string): void {
    this.closeMenu();
    const menu = document.createElement("div");
    menu.className = "context-menu";
    menu.addEventListener("click", (e) => e.stopPropagation());
    const item = document.createElement("button");
    item.className = "context-menu-item";
    item.textContent = t("ui.filetree.openInFinder");
    item.addEventListener("click", () => {
      void revealInFinder(path).catch(() => {});
      this.closeMenu();
    });
    menu.appendChild(item);
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = Math.min(y, window.innerHeight - rect.height - 8);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${Math.max(8, top)}px`;
    this.menu = menu;
  }

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
  }

  private async activate(row: Row): Promise<void> {
    if (!row.entry.is_dir) {
      this.cb.onOpenFile(row.entry.path);
      return;
    }
    if (row.expanded) this.collapse(row);
    else await this.expand(row);
  }

  private async expand(row: Row): Promise<void> {
    row.expanded = true;
    row.el.classList.add("expanded");
    row.icon.innerHTML = fileIcon(row.entry.name, true, true);
    const { entries, truncated } = await readDir(row.entry.path);
    const index = this.rows.indexOf(row);
    const children = entries.map((e) => this.makeRow(e, row.depth + 1));
    const frag = document.createDocumentFragment();
    for (const c of children) frag.appendChild(c.el);
    if (truncated) {
      row.note = this.makeNote(row.depth + 1);
      frag.appendChild(row.note);
    }
    row.el.after(frag);
    this.rows.splice(index + 1, 0, ...children);
    this.highlight();
  }

  private collapse(row: Row): void {
    row.expanded = false;
    row.el.classList.remove("expanded");
    row.icon.innerHTML = fileIcon(row.entry.name, true, false);
    const start = this.rows.indexOf(row) + 1;
    let end = start;
    while (end < this.rows.length && this.rows[end].depth > row.depth) end++;
    for (const r of this.rows.slice(start, end)) {
      r.el.remove();
      r.note?.remove();
    }
    this.rows.splice(start, end - start);
    row.note?.remove();
    row.note = undefined;
    if (this.selected >= start && this.selected < end)
      this.selected = start - 1;
    else if (this.selected >= end) this.selected -= end - start;
    if (this.selected < 0) this.selected = 0;
    this.highlight();
  }

  async revealPath(absPath: string): Promise<void> {
    if (!absPath.startsWith(this.rootPath)) return;
    const rel = absPath.slice(this.rootPath.length).replace(/^\//, "");
    const parts = rel.split("/").filter(Boolean);
    let prefix = this.rootPath;
    for (const part of parts.slice(0, -1)) {
      prefix = `${prefix}/${part}`;
      const row = this.rows.find((r) => r.entry.path === prefix);
      if (row && !row.expanded) await this.expand(row);
    }
    const target = this.rows.findIndex((r) => r.entry.path === absPath);
    if (target >= 0) {
      this.selected = target;
      this.highlight();
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (e.metaKey) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.move(-1);
    } else if (e.key === "Enter" || e.key === "ArrowRight" || e.key === " ") {
      e.preventDefault();
      const row = this.rows[this.selected];
      if (row) void this.activate(row);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      const row = this.rows[this.selected];
      if (row?.entry.is_dir && row.expanded) this.collapse(row);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (this.menu) this.closeMenu();
      else this.cb.onEscape?.();
    }
  }

  private move(delta: number): void {
    if (this.rows.length === 0) return;
    this.selected = Math.max(
      0,
      Math.min(this.rows.length - 1, this.selected + delta),
    );
    this.highlight();
  }

  /** Tracks the highlighted element by identity (indices shift on
   *  expand/collapse) and touches only the two rows that change. */
  private highlight(): void {
    const el = this.rows[this.selected]?.el ?? null;
    if (this.highlightedEl !== el) {
      this.highlightedEl?.classList.remove("selected");
      el?.classList.add("selected");
      this.highlightedEl = el;
    }
    el?.scrollIntoView({ block: "nearest" });
  }
}
