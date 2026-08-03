import { Channel } from "@tauri-apps/api/core";
import { recordOpen, searchClose, searchQuery, searchStart } from "./commands";
import type { Project } from "./config";
import { fuzzyMatch, fuzzyPositions } from "./fuzzy";
import { t } from "./i18n";
import { fileIcon } from "./icons";
import { createOverlay } from "./overlay";
import {
  cycleScope,
  rootForScope,
  type Scope,
  type ScopeRoots,
} from "./searchscope";
import type { MatchItem, SearchEvent } from "./types";

const FILTER_DEBOUNCE_MS = 40;

export interface PaletteCommand {
  id: string;
  name: string;
  run: () => void;
}

export interface QuickOpenCallbacks {
  onOpenFile: (path: string, newTab?: boolean) => void;
  onRevealDir: (path: string) => void;
  onOpenProject: (id: string) => void;
  commands?: () => PaletteCommand[];
}

interface OpenOpts {
  defaultScope: Scope;
  toggleKey: string;
}

type Item =
  | {
      kind: "project";
      id: string;
      name: string;
      color: string;
      positions: number[];
    }
  | {
      kind: "command";
      id: string;
      name: string;
      run: () => void;
      positions: number[];
    }
  | {
      kind: "file";
      rel: string;
      name: string;
      isDir: boolean;
      positions: number[];
    };

export interface SearchState {
  items: MatchItem[];
  indexing: boolean;
  indexingCount: number;
  partial: boolean;
}

export const initialSearchState: SearchState = {
  items: [],
  indexing: false,
  indexingCount: 0,
  partial: false,
};

/**
 * Pure reducer over backend search events, kept DOM-free so it is
 * unit-testable on its own. `results` carries the generation it answers;
 * a slow query for an older generation can resolve after a newer one, so
 * anything not matching the live generation is dropped rather than applied.
 */
export function applyEvent(
  state: SearchState,
  ev: SearchEvent,
  generation: number,
): SearchState {
  switch (ev.kind) {
    case "indexing":
      return { ...state, indexing: true, indexingCount: ev.count };
    case "results":
      if (ev.generation !== generation) return state;
      return { ...state, items: ev.items, partial: ev.partial };
    case "done":
      return { ...state, indexing: false, partial: ev.partial };
  }
}

function byScoreThenName(
  a: { item: Item; score: number },
  b: { item: Item; score: number },
): number {
  return b.score - a.score || a.item.name.localeCompare(b.item.name);
}

export class QuickOpen {
  private readonly cb: QuickOpenCallbacks;
  private overlayClose: (() => Promise<void>) | null = null;
  private input!: HTMLInputElement;
  private list!: HTMLElement;
  private metaEl!: HTMLElement;
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
  private generation = 0;
  // Fresh per search_start (open / scope toggle): `indexing`/`done` events
  // carry no generation, so a superseded channel's late events can only be
  // told apart from the live one by object identity, not by number.
  private channel: Channel<SearchEvent> | null = null;
  private search: SearchState = initialSearchState;
  private matches: Item[] = [];
  private query = "";
  private selected = 0;
  private limit = 50;
  private filterTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(cb: QuickOpenCallbacks) {
    this.cb = cb;
  }

  private scheduleFilter(query: string): void {
    if (this.filterTimer !== null) clearTimeout(this.filterTimer);
    this.filterTimer = setTimeout(() => {
      this.filterTimer = null;
      this.runQuery(query);
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
    this.query = "";
    this.render();
    this.renderScopeChip();
    this.recomputeMatches();
    this.startSearch();
  }

  private startSearch(): void {
    if (this.channel) void searchClose(this.generation).catch(() => {});
    this.generation += 1;
    const generation = this.generation;
    const channel = new Channel<SearchEvent>();
    channel.onmessage = (ev) => {
      if (this.channel !== channel) return;
      this.search = applyEvent(this.search, ev, this.generation);
      this.renderScopeChip();
      this.recomputeMatches();
    };
    this.channel = channel;
    this.search = initialSearchState;
    this.renderScopeChip();
    this.recomputeMatches();

    const root = rootForScope(this.scope, this.roots);
    if (!root) return;
    void searchStart(root, this.scope, generation, channel).catch(() => {});
    void searchQuery(generation, this.query).catch(() => {});
  }

  private runQuery(query: string): void {
    this.query = query;
    this.recomputeMatches();
    if (!this.channel) return;
    // generation identifies the search SESSION (bumped only in startSearch,
    // where a fresh session/Channel is born), not the keystroke: the backend
    // gates search_query on strict equality against session.generation, so
    // bumping here would desync from it and every query after the first
    // would be silently dropped. Superseded results are already filtered by
    // the fresh-Channel-per-search_start identity guard in startSearch.
    void searchQuery(this.generation, query).catch(() => {});
  }

  private toggleScope(dir: 1 | -1): void {
    this.scope = cycleScope(this.scope, dir);
    this.announceScope();
    this.startSearch();
  }

  private render(): void {
    this.close();
    const { overlay, box, close } = createOverlay({
      className: "quickopen",
      label: "Quick open",
      onDismiss: () => this.close(),
    });
    this.overlayClose = close;

    const row = document.createElement("div");
    row.className = "qo-input-row";

    this.input = document.createElement("input");
    this.input.className = "quickopen-input";
    this.input.addEventListener("input", () =>
      this.scheduleFilter(this.input.value),
    );
    this.input.addEventListener("keydown", (e) => this.onKey(e));

    this.scopeChip = document.createElement("button");
    this.scopeChip.type = "button";
    this.scopeChip.className = "qo-scope";
    this.scopeChip.tabIndex = -1;
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

    this.metaEl = document.createElement("div");

    box.append(
      row,
      this.list,
      this.metaEl,
      this.statusEl,
      hintFooter(this.scope, this.toggleKey),
    );
    document.body.appendChild(overlay);
    this.input.focus();
  }

  private renderScopeChip(): void {
    if (!this.scopeChip) return;
    this.input.placeholder =
      this.scope === "home"
        ? t("ui.quickopen.placeholderHome")
        : t("ui.quickopen.placeholderProject");
    this.scopeChip.dataset.scope = this.scope;
    const other = cycleScope(this.scope, 1);
    this.scopeChip.setAttribute(
      "aria-label",
      this.scope === "home"
        ? t("ui.quickopen.scopeAriaHome")
        : t("ui.quickopen.scopeAriaProject"),
    );

    const current = document.createElement("span");
    current.className = "qo-scope-seg qo-scope-current";
    this.fillScopeSeg(current, this.scope, this.search.indexing);

    const key = document.createElement("kbd");
    key.className = "qo-scope-key";
    key.textContent = this.toggleKey === "Tab" ? "⇥" : this.toggleKey;

    const target = document.createElement("span");
    target.className = "qo-scope-seg qo-scope-target";
    this.fillScopeSeg(target, other, false);

    this.scopeChip.replaceChildren(current, key, target);
  }

  private fillScopeSeg(el: HTMLElement, scope: Scope, loading: boolean): void {
    if (loading) {
      const spin = document.createElement("span");
      spin.className = "qo-scope-spin";
      el.appendChild(spin);
    } else if (scope === "home") {
      const glyph = document.createElement("span");
      glyph.className = "qo-scope-glyph";
      glyph.textContent = "~";
      el.appendChild(glyph);
    } else if (this.roots.projectColor) {
      const dot = document.createElement("span");
      dot.className = "qo-project-dot";
      dot.style.background = this.roots.projectColor;
      el.appendChild(dot);
    }
    el.appendChild(
      document.createTextNode(
        scope === "home"
          ? t("ui.quickopen.scopeHome")
          : this.roots.projectLabel || t("ui.quickopen.scopeProject"),
      ),
    );
  }

  private announceScope(): void {
    if (!this.statusEl) return;
    this.statusEl.textContent =
      this.scope === "home"
        ? t("ui.quickopen.announceHome")
        : t("ui.quickopen.announceProject");
  }

  private recomputeMatches(): void {
    const projects: Array<{ item: Item; score: number }> = [];
    for (const p of this.projects) {
      const score = fuzzyMatch(this.query, p.name);
      if (score === null) continue;
      projects.push({
        item: {
          kind: "project",
          id: p.id,
          name: p.name,
          color: p.color,
          positions: fuzzyPositions(this.query, p.name) ?? [],
        },
        score,
      });
    }
    projects.sort(byScoreThenName);

    const commands: Array<{ item: Item; score: number }> = [];
    for (const c of this.cb.commands?.() ?? []) {
      const score = fuzzyMatch(this.query, c.name);
      if (score === null) continue;
      commands.push({
        item: {
          kind: "command",
          id: c.id,
          name: c.name,
          run: c.run,
          positions: fuzzyPositions(this.query, c.name) ?? [],
        },
        score,
      });
    }
    commands.sort(byScoreThenName);

    const files: Item[] = this.search.items.map((m) => ({
      kind: "file",
      rel: m.rel,
      name: m.name,
      isDir: m.is_dir,
      positions: m.positions,
    }));

    this.matches = [
      ...projects.map((x) => x.item),
      ...commands.map((x) => x.item),
      ...files,
    ].slice(0, this.limit);
    this.selected = 0;
    this.renderList();
  }

  private renderList(): void {
    this.list.replaceChildren();
    if (this.search.partial) {
      this.metaEl.className = "quickopen-note";
      this.metaEl.textContent = t("ui.quickopen.partial");
    } else {
      this.metaEl.className = "";
      this.metaEl.textContent = "";
    }
    if (this.search.indexing && this.matches.length === 0) {
      const line = document.createElement("div");
      line.className = "qo-loading";
      line.textContent = t("ui.quickopen.indexing");
      this.list.appendChild(line);
      return;
    }
    if (!this.search.indexing && this.query && this.matches.length === 0) {
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
        this.fillName(name, item.name, item.positions);
        const tag = document.createElement("span");
        tag.className = "qo-tag";
        tag.textContent = t("ui.quickopen.tagProject");
        rowEl.append(icon, name, tag);
      } else if (item.kind === "command") {
        icon.textContent = "⌘";
        this.fillName(name, item.name, item.positions);
        const tag = document.createElement("span");
        tag.className = "qo-tag";
        tag.textContent = t("ui.quickopen.tagCommand");
        rowEl.append(icon, name, tag);
      } else {
        icon.innerHTML = fileIcon(item.name, item.isDir, false);
        this.fillName(name, item.name, item.positions);
        rowEl.append(icon, name);
        const slash = item.rel.lastIndexOf("/");
        if (slash > 0) {
          const dir = document.createElement("span");
          dir.className = "qo-dir";
          dir.textContent = item.rel.slice(0, slash);
          rowEl.append(dir);
        }
      }

      rowEl.addEventListener("click", (e) => this.choose(item, e.shiftKey));
      this.list.appendChild(rowEl);
    });
    this.list
      .querySelector(".quickopen-row.selected")
      ?.scrollIntoView({ block: "nearest" });
  }

  private emptyState(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "qo-empty overlay-empty";
    const title = document.createElement("div");
    title.className = "qo-empty-title";
    title.textContent = t("ui.quickopen.empty");
    const nudge = document.createElement("div");
    nudge.className = "qo-empty-nudge overlay-empty-hint";
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

  private fillName(el: HTMLElement, text: string, positions: number[]): void {
    el.replaceChildren();
    if (positions.length === 0) {
      el.textContent = text;
      return;
    }
    const hit = new Set(positions);
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
      if (item) this.choose(item, e.shiftKey);
    }
  }

  private choose(item: Item, newTab = false): void {
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
    void recordOpen(abs).catch(() => {});
    if (item.isDir) this.cb.onRevealDir(abs);
    else this.cb.onOpenFile(abs, newTab);
  }

  private close(): void {
    if (this.filterTimer !== null) {
      clearTimeout(this.filterTimer);
      this.filterTimer = null;
    }
    if (this.channel) {
      void searchClose(this.generation).catch(() => {});
      this.channel = null;
    }
    // Must go through the overlay's own close so the global overlay count is
    // decremented; a bare remove() leaks the count and permanently gates the
    // native browser pane's visibility off (it stays hidden -> black).
    void this.overlayClose?.();
    this.overlayClose = null;
    this.search = initialSearchState;
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
