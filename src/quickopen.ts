import { indexDir } from "./commands";
import type { Project } from "./config";
import { fuzzyMatch, fuzzyPositions, topK } from "./fuzzy";
import { t } from "./i18n";
import { fileIcon } from "./icons";
import { createOverlay } from "./overlay";
import type { IndexEntry } from "./types";

const FILTER_DEBOUNCE_MS = 40;

export interface PaletteCommand {
  id: string;
  name: string;
  run: () => void;
}

export interface QuickOpenCallbacks {
  onOpenFile: (path: string) => void;
  onRevealDir: (path: string) => void;
  onOpenProject: (id: string) => void;
  commands?: () => PaletteCommand[];
}

type Item =
  | { kind: "project"; id: string; name: string; color: string }
  | { kind: "command"; id: string; name: string; run: () => void }
  | { kind: "file"; rel: string; name: string; isDir: boolean };

export class QuickOpen {
  private readonly cb: QuickOpenCallbacks;
  private overlay: HTMLElement | null = null;
  private input!: HTMLInputElement;
  private list!: HTMLElement;
  private root = "";
  private projects: Project[] = [];
  private entries: IndexEntry[] = [];
  private matches: Item[] = [];
  private query = "";
  private selected = 0;
  private truncated = false;
  private limit = 50;
  private filterTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(cb: QuickOpenCallbacks) {
    this.cb = cb;
  }

  private scheduleFilter(query: string): void {
    if (this.filterTimer !== null) clearTimeout(this.filterTimer);
    this.filterTimer = setTimeout(() => {
      this.filterTimer = null;
      this.filter(query);
    }, FILTER_DEBOUNCE_MS);
  }

  async open(
    root: string | null,
    projects: Project[],
    limit: number,
  ): Promise<void> {
    this.root = root ?? "";
    this.projects = projects;
    this.limit = limit;
    this.entries = [];
    this.truncated = false;
    this.render();
    this.filter("");
    if (root) {
      const index = await indexDir(root);
      if (!this.overlay) return;
      this.entries = index.entries;
      this.truncated = index.truncated;
      this.filter(this.input.value);
    }
  }

  private render(): void {
    this.close();
    const { overlay, box } = createOverlay({
      className: "quickopen",
      label: "Quick open",
      onDismiss: () => this.close(),
    });

    this.input = document.createElement("input");
    this.input.className = "quickopen-input";
    this.input.placeholder = t("ui.quickopen.placeholder");
    this.input.addEventListener("input", () =>
      this.scheduleFilter(this.input.value),
    );
    this.input.addEventListener("keydown", (e) => this.onKey(e));

    this.list = document.createElement("div");
    this.list.className = "quickopen-list";

    box.append(this.input, this.list, hintFooter());
    document.body.appendChild(overlay);
    this.overlay = overlay;
    this.input.focus();
  }

  private filter(query: string): void {
    this.query = query;
    const projects: Array<{ p: Project; s: number }> = [];
    for (const p of this.projects) {
      const s = query ? fuzzyMatch(query, p.name) : 0;
      if (s !== null) projects.push({ p, s });
    }
    projects.sort((a, b) => b.s - a.s || a.p.name.localeCompare(b.p.name));

    const commands: Array<{ c: PaletteCommand; s: number }> = [];
    for (const c of this.cb.commands?.() ?? []) {
      const s = query ? fuzzyMatch(query, c.name) : 0;
      if (s !== null) commands.push({ c, s });
    }
    commands.sort((a, b) => b.s - a.s || a.c.name.localeCompare(b.c.name));

    let files: Array<{ e: IndexEntry; s: number }> = [];
    if (query) {
      const scored = (function* (entries: IndexEntry[]) {
        for (const e of entries) {
          const s = fuzzyMatch(query, e.rel);
          if (s !== null) yield { e, s };
        }
      })(this.entries);
      // Higher score first; ties break on shorter, then alphabetical paths so
      // equally-scored results never reorder between keystrokes.
      files = topK(
        scored,
        this.limit,
        (a, b) =>
          b.s - a.s ||
          a.e.rel.length - b.e.rel.length ||
          a.e.rel.localeCompare(b.e.rel),
      );
    }

    this.matches = [
      ...projects.map(
        ({ p }): Item => ({
          kind: "project",
          id: p.id,
          name: p.name,
          color: p.color,
        }),
      ),
      ...commands.map(
        ({ c }): Item => ({
          kind: "command",
          id: c.id,
          name: c.name,
          run: c.run,
        }),
      ),
      ...files.map(
        ({ e }): Item => ({
          kind: "file",
          rel: e.rel,
          name: e.name,
          isDir: e.is_dir,
        }),
      ),
    ].slice(0, this.limit);
    this.selected = 0;
    this.renderList();
  }

  private renderList(): void {
    this.list.replaceChildren();
    if (this.truncated) {
      const note = document.createElement("div");
      note.className = "quickopen-note";
      note.textContent = t("ui.quickopen.truncated");
      this.list.appendChild(note);
    }
    this.matches.forEach((item, i) => {
      const row = document.createElement("div");
      row.className =
        i === this.selected ? "quickopen-row selected" : "quickopen-row";

      const icon = document.createElement("span");
      icon.className = "qo-icon";
      const name = document.createElement("span");
      name.className = "qo-name";

      if (item.kind === "project") {
        const dot = document.createElement("span");
        dot.className = "qo-project-dot";
        dot.style.background = item.color;
        icon.appendChild(dot);
        this.fillName(name, item.name);
        const tag = document.createElement("span");
        tag.className = "qo-tag";
        tag.textContent = t("ui.quickopen.tagProject");
        row.append(icon, name, tag);
      } else if (item.kind === "command") {
        icon.textContent = "⌘";
        this.fillName(name, item.name);
        const tag = document.createElement("span");
        tag.className = "qo-tag";
        tag.textContent = t("ui.quickopen.tagCommand");
        row.append(icon, name, tag);
      } else {
        icon.innerHTML = fileIcon(item.name, item.isDir, false);
        this.fillName(name, item.name);
        row.append(icon, name);
        const slash = item.rel.lastIndexOf("/");
        if (slash > 0) {
          const dir = document.createElement("span");
          dir.className = "qo-dir";
          dir.textContent = item.rel.slice(0, slash);
          row.append(dir);
        }
      }

      row.addEventListener("click", () => this.choose(item));
      this.list.appendChild(row);
    });
    this.list
      .querySelector(".quickopen-row.selected")
      ?.scrollIntoView({ block: "nearest" });
  }

  private fillName(el: HTMLElement, text: string): void {
    el.replaceChildren();
    const pos = this.query ? fuzzyPositions(this.query, text) : null;
    if (!pos || pos.length === 0) {
      el.textContent = text;
      return;
    }
    const hit = new Set(pos);
    let i = 0;
    while (i < text.length) {
      const on = hit.has(i);
      let j = i;
      while (j < text.length && hit.has(j) === on) j++;
      const chunk = text.slice(i, j);
      if (on) {
        const mark = document.createElement("mark");
        mark.className = "qo-hl";
        mark.textContent = chunk;
        el.appendChild(mark);
      } else {
        el.appendChild(document.createTextNode(chunk));
      }
      i = j;
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.selected = Math.min(this.matches.length - 1, this.selected + 1);
      this.renderList();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.selected = Math.max(0, this.selected - 1);
      this.renderList();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = this.matches[this.selected];
      if (item) this.choose(item);
    }
  }

  private choose(item: Item): void {
    this.close();
    if (item.kind === "project") {
      this.cb.onOpenProject(item.id);
      return;
    }
    if (item.kind === "command") {
      item.run();
      return;
    }
    const base = this.root.replace(/\/+$/, "");
    const abs = `${base}/${item.rel}`;
    if (item.isDir) this.cb.onRevealDir(abs);
    else this.cb.onOpenFile(abs);
  }

  private close(): void {
    if (this.filterTimer !== null) {
      clearTimeout(this.filterTimer);
      this.filterTimer = null;
    }
    this.overlay?.remove();
    this.overlay = null;
    this.entries = [];
  }
}

function hintFooter(): HTMLElement {
  const footer = document.createElement("div");
  footer.className = "quickopen-footer";
  const add = (keys: string[], label: string): void => {
    const item = document.createElement("span");
    item.className = "qo-hint";
    for (const k of keys) {
      const kbd = document.createElement("kbd");
      kbd.textContent = k;
      item.appendChild(kbd);
    }
    item.append(document.createTextNode(label));
    footer.appendChild(item);
  };
  add(["↑", "↓"], t("ui.quickopen.hintNavigate"));
  add(["↵"], t("ui.quickopen.hintOpen"));
  add(["esc"], t("ui.quickopen.hintClose"));
  return footer;
}
