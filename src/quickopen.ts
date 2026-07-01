import { indexDir } from "./commands";
import type { Project } from "./config";
import { fuzzyMatch, fuzzyPositions, topK } from "./fuzzy";
import { t } from "./i18n";
import { fileIcon } from "./icons";
import { createOverlay } from "./overlay";
import {
  cycleScope,
  rootForScope,
  type Scope,
  type ScopeRoots,
} from "./searchscope";
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

interface OpenOpts {
  defaultScope: Scope;
  toggleKey: string;
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
  private scopeChip!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private roots: ScopeRoots = {
    project: null,
    home: "",
    projectLabel: "",
    projectColor: null,
  };
  private scope: Scope = "project";
  private toggleKey = "Tab";
  private projects: Project[] = [];
  private entries: IndexEntry[] = [];
  private readonly cache = new Map<
    Scope,
    { entries: IndexEntry[]; truncated: boolean }
  >();
  private generation = 0;
  private loading = false;
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
    roots: ScopeRoots,
    projects: Project[],
    limit: number,
    opts: OpenOpts,
  ): Promise<void> {
    this.roots = roots;
    this.projects = projects;
    this.limit = limit;
    this.toggleKey = opts.toggleKey || "Tab";
    this.scope = opts.defaultScope;
    this.cache.clear();
    this.generation = 0;
    this.entries = [];
    this.truncated = false;
    this.loading = false;
    this.render();
    this.renderScopeChip();
    this.filter("");
    await this.ensureIndex(this.scope);
  }

  private async ensureIndex(scope: Scope): Promise<void> {
    const cached = this.cache.get(scope);
    if (cached) {
      this.entries = cached.entries;
      this.truncated = cached.truncated;
      this.setLoading(false);
      this.filter(this.query);
      return;
    }
    const root = rootForScope(scope, this.roots);
    if (!root) {
      this.entries = [];
      this.truncated = false;
      this.setLoading(false);
      this.filter(this.query);
      return;
    }
    const gen = ++this.generation;
    this.setLoading(true);
    let index: { entries: IndexEntry[]; truncated: boolean };
    try {
      index = await indexDir(root);
    } catch {
      index = { entries: [], truncated: false };
    }
    // Discard a walk that finished after the user switched scope or closed the
    // palette: without this, a slow $HOME walk dumps home files into the
    // project view a second later.
    if (gen !== this.generation || !this.overlay || this.scope !== scope)
      return;
    this.cache.set(scope, index);
    this.entries = index.entries;
    this.truncated = index.truncated;
    this.setLoading(false);
    this.filter(this.query);
  }

  private toggleScope(dir: 1 | -1): void {
    this.scope = cycleScope(this.scope, dir);
    this.generation += 1;
    const cached = this.cache.get(this.scope);
    if (!cached) {
      this.entries = [];
      this.truncated = false;
    }
    this.renderScopeChip();
    this.announceScope();
    void this.ensureIndex(this.scope);
  }

  private setLoading(loading: boolean): void {
    this.loading = loading;
    this.renderScopeChip();
    this.renderList();
  }

  private render(): void {
    this.close();
    const { overlay, box } = createOverlay({
      className: "quickopen",
      label: "Quick open",
      onDismiss: () => this.close(),
    });

    const row = document.createElement("div");
    row.className = "qo-input-row";

    this.input = document.createElement("input");
    this.input.className = "quickopen-input";
    this.input.placeholder = t("ui.quickopen.placeholder");
    this.input.addEventListener("input", () =>
      this.scheduleFilter(this.input.value),
    );
    this.input.addEventListener("keydown", (e) => this.onKey(e));

    this.scopeChip = document.createElement("button");
    this.scopeChip.type = "button";
    this.scopeChip.className = "qo-scope";
    this.scopeChip.tabIndex = -1;
    this.scopeChip.setAttribute("aria-label", t("ui.quickopen.scopeAria"));
    this.scopeChip.addEventListener("click", (e) => {
      e.preventDefault();
      this.toggleScope(1);
      this.input.focus();
    });
    row.append(this.input, this.scopeChip);

    this.statusEl = document.createElement("div");
    this.statusEl.className = "qo-status";
    this.statusEl.setAttribute("aria-live", "polite");

    this.list = document.createElement("div");
    this.list.className = "quickopen-list";

    box.append(
      row,
      this.list,
      this.statusEl,
      hintFooter(this.scope, this.toggleKey),
    );
    document.body.appendChild(overlay);
    this.overlay = overlay;
    this.input.focus();
  }

  private renderScopeChip(): void {
    if (!this.scopeChip) return;
    this.scopeChip.dataset.scope = this.scope;
    this.scopeChip.replaceChildren();
    if (this.loading) {
      const spin = document.createElement("span");
      spin.className = "qo-scope-spin";
      this.scopeChip.appendChild(spin);
    }
    if (this.scope === "project") {
      if (this.roots.projectColor) {
        const dot = document.createElement("span");
        dot.className = "qo-project-dot";
        dot.style.background = this.roots.projectColor;
        this.scopeChip.appendChild(dot);
      }
      this.scopeChip.appendChild(
        document.createTextNode(this.roots.projectLabel || "project"),
      );
    } else {
      const glyph = document.createElement("span");
      glyph.className = "qo-scope-glyph";
      glyph.textContent = "~";
      this.scopeChip.append(
        glyph,
        document.createTextNode(t("ui.quickopen.scopeHome")),
      );
    }
  }

  private announceScope(): void {
    if (!this.statusEl) return;
    this.statusEl.textContent =
      this.scope === "home"
        ? t("ui.quickopen.announceHome")
        : t("ui.quickopen.announceProject");
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
    if (this.loading) {
      const line = document.createElement("div");
      line.className = "quickopen-note qo-loading";
      line.textContent = t("ui.quickopen.indexing");
      this.list.appendChild(line);
    }
    if (this.truncated) {
      const note = document.createElement("div");
      note.className =
        this.scope === "home"
          ? "quickopen-note qo-note-muted"
          : "quickopen-note";
      note.textContent =
        this.scope === "home"
          ? t("ui.quickopen.truncatedHome")
          : t("ui.quickopen.truncated");
      this.list.appendChild(note);
    }
    if (!this.loading && this.query && this.matches.length === 0) {
      this.list.appendChild(this.emptyState());
      return;
    }
    this.matches.forEach((item, i) => {
      const rowEl = document.createElement("div");
      rowEl.className =
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
        rowEl.append(icon, name, tag);
      } else if (item.kind === "command") {
        icon.textContent = "⌘";
        this.fillName(name, item.name);
        const tag = document.createElement("span");
        tag.className = "qo-tag";
        tag.textContent = t("ui.quickopen.tagCommand");
        rowEl.append(icon, name, tag);
      } else {
        icon.innerHTML = fileIcon(item.name, item.isDir, false);
        this.fillName(name, item.name);
        rowEl.append(icon, name);
        const slash = item.rel.lastIndexOf("/");
        if (slash > 0) {
          const dir = document.createElement("span");
          dir.className = "qo-dir";
          dir.textContent = item.rel.slice(0, slash);
          rowEl.append(dir);
        }
      }

      rowEl.addEventListener("click", () => this.choose(item));
      this.list.appendChild(rowEl);
    });
    this.list
      .querySelector(".quickopen-row.selected")
      ?.scrollIntoView({ block: "nearest" });
  }

  private emptyState(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "qo-empty";
    const title = document.createElement("div");
    title.className = "qo-empty-title";
    title.textContent = t("ui.quickopen.empty");
    const nudge = document.createElement("div");
    nudge.className = "qo-empty-nudge";
    const kbd = document.createElement("kbd");
    kbd.textContent = this.toggleKey === "Tab" ? "⇥" : this.toggleKey;
    nudge.append(
      kbd,
      document.createTextNode(
        this.scope === "project"
          ? t("ui.quickopen.nudgeHome")
          : t("ui.quickopen.nudgeProject"),
      ),
    );
    wrap.append(title, nudge);
    return wrap;
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
    if (e.key === this.toggleKey) {
      e.preventDefault();
      e.stopPropagation();
      this.toggleScope(e.shiftKey ? -1 : 1);
      return;
    }
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
    if (item.kind === "project") {
      this.close();
      this.cb.onOpenProject(item.id);
      return;
    }
    if (item.kind === "command") {
      this.close();
      item.run();
      return;
    }
    const root = rootForScope(this.scope, this.roots);
    this.close();
    if (!root) return;
    const base = root.replace(/\/+$/, "");
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

function hintFooter(scope: Scope, toggleKey: string): HTMLElement {
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
  add(
    [toggleKey === "Tab" ? "⇥" : toggleKey],
    scope === "project"
      ? t("ui.quickopen.hintScopeHome")
      : t("ui.quickopen.hintScopeProject"),
  );
  add(["esc"], t("ui.quickopen.hintClose"));
  return footer;
}
