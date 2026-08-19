import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { createFile, gitFileHead, readDir, revealInFinder } from "./commands";
import type { GitStatusReport } from "./config";
import {
  deletedIn,
  type FolderSummary,
  fileMark,
  folderMark,
  folderSummaries,
  type GitFileStatus,
  type MarkView,
  statusMap,
} from "./gitstatus";
import { t } from "./i18n";
import {
  CHEVRON,
  CONFLICT_GLYPH,
  COPY,
  EXTERNAL,
  fileIcon,
  NEW_FILE,
} from "./icons";
import { promptText } from "./prompt";
import { showToast } from "./toast";
import type { DirEntry, DirListing } from "./types";

export interface FileTreeCallbacks {
  onOpenFile: (path: string, newTab?: boolean) => void;
  onOpenGhost?: (path: string, content: string | null) => void;
  onEscape?: () => void;
}

interface Row {
  el: HTMLElement;
  icon: HTMLElement;
  mark: HTMLElement;
  entry: DirEntry;
  depth: number;
  expanded: boolean;
  ghost: boolean;
  note?: HTMLElement;
  markState?: MarkView;
}

interface GhostListing extends DirListing {
  ghosts: ReadonlySet<string>;
}

const NO_GHOSTS: ReadonlySet<string> = new Set();

function ghostEntry(path: string): DirEntry {
  return { name: path.slice(path.lastIndexOf("/") + 1), path, is_dir: false };
}

// Mirrors the backend's own order (fs.rs: dirs first, then
// name.to_lowercase() in code-point order) so a deleted file merging into a
// listing never reorders it — a locale-aware collation (Intl/localeCompare)
// diverges from that ordinal comparison on accented names.
function compareEntries(a: DirEntry, b: DirEntry): number {
  if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  return an < bn ? -1 : an > bn ? 1 : 0;
}

function insertGhosts(entries: DirEntry[], ghosts: DirEntry[]): DirEntry[] {
  if (ghosts.length === 0) return entries;
  const merged = entries.slice();
  for (const ghost of ghosts.slice().sort(compareEntries)) {
    let i = merged.length;
    while (i > 0 && compareEntries(merged[i - 1], ghost) > 0) i--;
    merged.splice(i, 0, ghost);
  }
  return merged;
}

export class FileTree {
  private readonly root: HTMLElement;
  private readonly cb: FileTreeCallbacks;
  private readonly header: HTMLElement;
  private readonly focusHintEl: HTMLElement;
  private readonly newFileBtn: HTMLButtonElement;
  private readonly list: HTMLElement;
  private rootPath = "";
  private home = "";
  private rows: Row[] = [];
  private selected = 0;
  private highlightedEl: HTMLElement | null = null;
  private menu: HTMLElement | null = null;
  private refreshing = false;
  private showDeleted = false;
  private statusFiles: GitFileStatus[] = [];
  private statusTruncated = false;
  private statusRoot = "";
  private hasStatuses = false;
  private statusByPath: Map<string, GitFileStatus> = new Map();
  private statusFolders: Map<string, FolderSummary> = new Map();

  constructor(root: HTMLElement, cb: FileTreeCallbacks) {
    this.root = root;
    this.root.tabIndex = -1;
    this.cb = cb;
    this.header = document.createElement("div");
    this.header.className = "tree-header";
    this.focusHintEl = document.createElement("kbd");
    this.focusHintEl.className = "tree-focus-hint";
    this.focusHintEl.style.display = "none";
    this.newFileBtn = document.createElement("button");
    this.newFileBtn.type = "button";
    this.newFileBtn.className = "tree-new-file";
    this.newFileBtn.title = t("ui.filetree.newFile");
    this.newFileBtn.setAttribute("aria-label", t("ui.filetree.newFile"));
    this.newFileBtn.innerHTML = NEW_FILE;
    this.newFileBtn.addEventListener("click", () => void this.newFile());
    this.list = document.createElement("div");
    this.list.className = "tree-list";
    this.list.setAttribute("role", "tree");
    this.root.append(this.header, this.list);
    this.root.addEventListener("keydown", (e) => this.onKey(e));
    document.addEventListener("click", () => this.closeMenu());
  }

  setHome(home: string): void {
    this.home = home;
  }

  setShowDeleted(value: boolean): void {
    this.showDeleted = value;
  }

  /** Applies a git status report to every row in place, touching only the
   *  DOM of rows whose computed mark actually changed (see applyMark). */
  setStatuses(report: GitStatusReport, root: string): void {
    this.statusFiles = report.files;
    this.statusTruncated = report.truncated;
    this.statusRoot = root;
    this.hasStatuses = true;
    this.statusByPath = statusMap(report.files);
    this.statusFolders = folderSummaries(report.files, root);
    for (const row of this.rows) this.applyMark(row, this.markFor(row));
  }

  // A folder with its own entry in statusByPath is an untracked directory
  // (recurse_untracked_dirs(false) reports it as one entry rather than its
  // contents), so it renders that entry's chip instead of the roll-up count.
  private markFor(row: Row): MarkView {
    const own = this.statusTruncated
      ? undefined
      : this.statusByPath.get(row.entry.path);
    if (!row.entry.is_dir) return fileMark(own);
    return own
      ? fileMark(own)
      : folderMark(this.statusFolders.get(row.entry.path), row.expanded);
  }

  selectedPath(): string | null {
    return this.rows[this.selected]?.entry.path ?? null;
  }

  private async listWithGhosts(path: string): Promise<GhostListing> {
    const listing = await readDir(path);
    if (!this.showDeleted || !this.hasStatuses) {
      return { ...listing, ghosts: NO_GHOSTS };
    }
    const ghostPaths = deletedIn(this.statusFiles, path);
    if (ghostPaths.length === 0) return { ...listing, ghosts: NO_GHOSTS };
    const entries = insertGhosts(listing.entries, ghostPaths.map(ghostEntry));
    return {
      entries,
      truncated: listing.truncated,
      ghosts: new Set(ghostPaths),
    };
  }

  async setRoot(path: string): Promise<void> {
    this.rootPath = path;
    // A fresh root means fresh (or not-yet-fetched) statuses: never carry a
    // previous project's report into a new one's ghost rows or marks.
    this.hasStatuses = false;
    this.statusFiles = [];
    this.statusTruncated = false;
    this.statusRoot = "";
    this.statusByPath = new Map();
    this.statusFolders = new Map();
    this.renderHeader(path);
    this.list.replaceChildren();
    this.selected = 0;
    this.highlightedEl = null;
    const { entries, truncated, ghosts } = await this.listWithGhosts(path);
    this.rows = entries.map((e) => this.makeRow(e, 0, ghosts.has(e.path)));
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
      this.reapplyStatuses();
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
    const listing = await this.listWithGhosts(path).catch(() => null);
    if (!listing) return null;
    for (const e of listing.entries) {
      const row = this.reuseOrMake(
        e,
        depth,
        byPath,
        listing.ghosts.has(e.path),
      );
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
    ghost: boolean,
  ): Row {
    const prev = byPath.get(entry.path);
    if (prev && prev.entry.is_dir === entry.is_dir) {
      prev.entry = entry;
      if (prev.depth !== depth) {
        prev.depth = depth;
        prev.el.style.paddingLeft = `${6 + depth * 12}px`;
        prev.el.setAttribute("aria-level", String(depth + 1));
      }
      if (prev.ghost !== ghost) {
        prev.ghost = ghost;
        if (ghost) prev.el.dataset.ghost = "true";
        else delete prev.el.dataset.ghost;
      }
      return prev;
    }
    return this.makeRow(entry, depth, ghost);
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
    this.header.replaceChildren(icon, name, this.newFileBtn, this.focusHintEl);
  }

  private async newFile(): Promise<void> {
    if (!this.rootPath) return;
    const name = await promptText(t("ui.filetree.newFilePrompt"));
    if (!name) return;
    const path = `${this.rootPath.replace(/\/+$/, "")}/${name}`;
    try {
      await createFile(path);
    } catch {
      showToast(t("ui.filetree.createFailed"));
      return;
    }
    await this.refresh();
    this.cb.onOpenFile(path);
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

  private makeRow(entry: DirEntry, depth: number, ghost = false): Row {
    const el = document.createElement("div");
    el.className = "tree-row";
    el.style.paddingLeft = `${6 + depth * 12}px`;
    el.setAttribute("role", "treeitem");
    el.setAttribute("aria-level", String(depth + 1));
    el.setAttribute("aria-selected", "false");
    el.setAttribute("aria-label", entry.name);
    if (entry.is_dir) el.setAttribute("aria-expanded", "false");
    if (ghost) el.dataset.ghost = "true";

    const twist = document.createElement("span");
    twist.className = "tree-twist";
    if (entry.is_dir) twist.innerHTML = CHEVRON;

    const icon = document.createElement("span");
    icon.className = "tree-icon";
    icon.innerHTML = fileIcon(entry.name, entry.is_dir, false);

    const name = document.createElement("span");
    name.className = "tree-name";
    name.textContent = entry.name;

    const mark = document.createElement("span");
    mark.className = "git-mark";
    mark.setAttribute("aria-hidden", "true");

    el.append(twist, icon, name, mark);
    const row: Row = { el, icon, mark, entry, depth, expanded: false, ghost };
    el.addEventListener("click", (e) => {
      this.selected = this.rows.indexOf(row);
      this.highlight();
      void this.activate(row, e.shiftKey);
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.selected = this.rows.indexOf(row);
      this.highlight();
      this.openMenu(e.clientX, e.clientY, row.entry.path);
    });
    // Marks the row while it is still detached from the document, so its
    // first paint already carries the final data-kind/opacity: applying
    // them only after insertion lets the browser commit an unmarked frame
    // first, and the later mark then reads as an unwanted fade-in.
    if (this.hasStatuses) this.applyMark(row, this.markFor(row));
    return row;
  }

  private openMenu(x: number, y: number, path: string): void {
    this.closeMenu();
    const menu = document.createElement("div");
    menu.className = "context-menu";
    menu.setAttribute("role", "menu");
    menu.addEventListener("click", (e) => e.stopPropagation());
    const add = (icon: string, label: string, run: () => void): void => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "context-menu-item";
      item.setAttribute("role", "menuitem");
      const glyph = document.createElement("span");
      glyph.className = "context-menu-icon";
      glyph.setAttribute("aria-hidden", "true");
      glyph.innerHTML = icon;
      const text = document.createElement("span");
      text.textContent = label;
      item.append(glyph, text);
      item.addEventListener("click", () => {
        run();
        this.closeMenu();
      });
      menu.appendChild(item);
    };
    const separator = (): void => {
      const sep = document.createElement("div");
      sep.className = "context-menu-sep";
      sep.setAttribute("role", "separator");
      menu.appendChild(sep);
    };
    add(
      EXTERNAL,
      t("ui.filetree.openInFinder"),
      () => void revealInFinder(path).catch(() => {}),
    );
    separator();
    add(COPY, t("ui.filetree.copyPath"), () => this.copyPath(path));
    add(COPY, t("ui.filetree.copyRelPath"), () =>
      this.copyPath(this.relativePath(path)),
    );
    document.body.appendChild(menu);
    const margin = 8;
    const rect = menu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - margin);
    const flippedY = y + rect.height > window.innerHeight - margin;
    const top = Math.min(y, window.innerHeight - rect.height - margin);
    menu.style.left = `${Math.max(margin, left)}px`;
    menu.style.top = `${Math.max(margin, top)}px`;
    menu.style.transformOrigin = flippedY ? "bottom left" : "top left";
    if (flippedY) menu.dataset.flip = "up";
    this.menu = menu;
  }

  private relativePath(path: string): string {
    const base = this.rootPath.replace(/\/$/, "");
    if (base && (path === base || path.startsWith(`${base}/`)))
      return path.slice(base.length + 1) || ".";
    return path;
  }

  private copyPath(value: string): void {
    void writeText(value)
      .then(() => showToast(t("ui.filetree.pathCopied")))
      .catch(() => {});
  }

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
  }

  private async activate(row: Row, newTab = false): Promise<void> {
    if (row.ghost) {
      const content = await gitFileHead(row.entry.path);
      this.cb.onOpenGhost?.(row.entry.path, content);
      return;
    }
    if (!row.entry.is_dir) {
      this.cb.onOpenFile(row.entry.path, newTab);
      return;
    }
    if (row.expanded) this.collapse(row);
    else await this.expand(row);
  }

  private async expand(row: Row): Promise<void> {
    row.expanded = true;
    row.el.classList.add("expanded");
    row.el.setAttribute("aria-expanded", "true");
    row.icon.innerHTML = fileIcon(row.entry.name, true, true);
    const { entries, truncated, ghosts } = await this.listWithGhosts(
      row.entry.path,
    );
    const index = this.rows.indexOf(row);
    const children = entries.map((e) =>
      this.makeRow(e, row.depth + 1, ghosts.has(e.path)),
    );
    const frag = document.createDocumentFragment();
    for (const c of children) frag.appendChild(c.el);
    if (truncated) {
      row.note = this.makeNote(row.depth + 1);
      frag.appendChild(row.note);
    }
    row.el.after(frag);
    this.rows.splice(index + 1, 0, ...children);
    this.reapplyStatuses();
    this.highlight();
  }

  private collapse(row: Row): void {
    row.expanded = false;
    row.el.classList.remove("expanded");
    row.el.setAttribute("aria-expanded", "false");
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
    this.reapplyStatuses();
    this.highlight();
  }

  private reapplyStatuses(): void {
    if (!this.hasStatuses) return;
    this.setStatuses(
      { files: this.statusFiles, truncated: this.statusTruncated },
      this.statusRoot,
    );
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
      if (row) void this.activate(row, e.shiftKey);
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
      this.highlightedEl?.setAttribute("aria-selected", "false");
      el?.classList.add("selected");
      el?.setAttribute("aria-selected", "true");
      this.highlightedEl = el;
    }
    el?.scrollIntoView({ block: "nearest" });
  }

  /** Mirrors highlight()'s discipline: writes to the DOM only when the
   *  computed mark differs from what is already there, so the opacity
   *  transition on .git-mark fires solely for rows whose status changed. */
  private applyMark(row: Row, next: MarkView): void {
    const prev = row.markState;
    if (
      prev &&
      prev.text === next.text &&
      prev.kind === next.kind &&
      prev.stage === next.stage &&
      prev.conflicted === next.conflicted &&
      prev.label === next.label
    ) {
      return;
    }
    row.markState = next;
    row.mark.textContent = next.text;
    if (next.kind) row.mark.dataset.kind = next.kind;
    else delete row.mark.dataset.kind;
    if (next.stage) row.mark.dataset.stage = next.stage;
    else delete row.mark.dataset.stage;
    row.mark.title = next.label;
    if (next.conflicted) row.el.dataset.git = "conflicted";
    else delete row.el.dataset.git;
    row.el.setAttribute(
      "aria-label",
      next.label ? `${row.entry.name}, ${next.label}` : row.entry.name,
    );
    row.icon.innerHTML = next.conflicted
      ? CONFLICT_GLYPH
      : fileIcon(row.entry.name, row.entry.is_dir, row.expanded);
  }
}
