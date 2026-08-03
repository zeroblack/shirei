import { compactAge } from "./dates";
import { t } from "./i18n";
import { createOverlay } from "./overlay";
import {
  buildWorkingMark,
  type SessionState,
  type SessionStateEntry,
  STATE_GLYPH,
  stateTitle,
} from "./sessionstate";

export interface BoardRow {
  id: string;
  tab: string;
  color: string | null;
  label: string;
  entry: SessionStateEntry;
}

export interface BoardHints {
  gotoWaiting: string;
  next: string;
  prev: string;
}

export interface OrchestrationCallbacks {
  onActivate: (id: string) => void;
}

// The design's own "one waiting 5 min is flagged-but-quiet" threshold: a
// static marker on the row, never a re-triggering animation.
const AGED_WAITING_MS = 5 * 60 * 1000;

type NavItem =
  | { kind: "session"; id: string; el: HTMLElement }
  | { kind: "toggle"; el: HTMLElement };

export class OrchestrationBoard {
  private readonly cb: OrchestrationCallbacks;
  private overlay: HTMLElement | null = null;
  private overlayClose: (() => Promise<void>) | null = null;
  private list!: HTMLElement;
  private rows: BoardRow[] = [];
  private hints: BoardHints = { gotoWaiting: "", next: "", prev: "" };
  private nav: NavItem[] = [];
  private selected = 0;
  private doneExpanded = false;
  // Kept across opens/closes: a flip that happened while the board was
  // closed still earns the one-shot flash the next time it's opened, so the
  // board can answer "what changed since I last looked".
  private readonly lastKind = new Map<string, SessionState["kind"]>();

  constructor(cb: OrchestrationCallbacks) {
    this.cb = cb;
  }

  isOpen(): boolean {
    return this.overlay !== null;
  }

  open(rows: BoardRow[], hints: BoardHints): void {
    this.hints = hints;
    this.doneExpanded = false;
    this.mount();
    this.setRows(rows);
  }

  refresh(rows: BoardRow[]): void {
    if (!this.overlay) return;
    this.setRows(rows);
  }

  refreshAges(): void {
    if (!this.overlay) return;
    const now = Date.now();
    for (const row of this.list.querySelectorAll<HTMLElement>(
      ".orch-row[data-since]",
    )) {
      const since = Number(row.dataset.since);
      if (Number.isNaN(since)) continue;
      const age = row.querySelector<HTMLElement>(".orch-age");
      if (age) age.textContent = compactAge(since / 1000);
      const isWaiting = row.classList.contains("kind-waiting");
      row.classList.toggle("aged", isWaiting && now - since > AGED_WAITING_MS);
    }
  }

  close(): void {
    void this.overlayClose?.();
    this.overlayClose = null;
    this.overlay = null;
    this.rows = [];
    this.nav = [];
  }

  private mount(): void {
    this.close();
    const { overlay, box, close } = createOverlay({
      className: "orchestration",
      label: t("ui.orchestration.title"),
      onDismiss: () => this.close(),
    });
    this.overlayClose = close;

    const title = document.createElement("div");
    title.className = "orch-title";
    title.textContent = t("ui.orchestration.title");

    this.list = document.createElement("div");
    this.list.className = "orch-list";
    this.list.tabIndex = -1;
    this.list.addEventListener("keydown", (e) => this.onKey(e));

    box.append(title, this.list, this.footer());
    document.body.appendChild(overlay);
    this.overlay = overlay;
    this.list.focus();
  }

  private footer(): HTMLElement {
    const footer = document.createElement("div");
    footer.className = "orch-footer";
    const add = (keys: string[], label: string): void => {
      const strokes = keys.filter(Boolean);
      if (strokes.length === 0 || !label) return;
      const item = document.createElement("span");
      item.className = "orch-hint";
      for (const k of strokes) {
        const kbd = document.createElement("kbd");
        kbd.textContent = k;
        item.appendChild(kbd);
      }
      item.append(document.createTextNode(label));
      footer.appendChild(item);
    };
    add(["↑", "↓"], t("ui.orchestration.hintNavigate"));
    add(["↵"], t("ui.orchestration.hintOpen"));
    add([this.hints.gotoWaiting], t("ui.orchestration.hintGoto"));
    add([this.hints.prev, this.hints.next], t("ui.orchestration.hintCycle"));
    add(["esc"], t("ui.orchestration.hintClose"));
    return footer;
  }

  private setRows(rows: BoardRow[]): void {
    const flashing = new Set<string>();
    for (const row of rows) {
      const kind = row.entry.state.kind;
      const prev = this.lastKind.get(row.id);
      if (prev && prev !== kind && (kind === "waiting" || kind === "errored")) {
        flashing.add(row.id);
      }
      this.lastKind.set(row.id, kind);
    }
    const liveIds = new Set(rows.map((r) => r.id));
    for (const id of this.lastKind.keys()) {
      if (!liveIds.has(id)) this.lastKind.delete(id);
    }
    this.rows = rows;
    this.renderList(flashing);
  }

  private renderList(flashing: Set<string>): void {
    this.list.replaceChildren();
    this.nav = [];

    if (this.rows.length === 0) {
      this.list.appendChild(this.emptyState());
      return;
    }

    const byKind = (kind: SessionState["kind"]): BoardRow[] =>
      this.rows.filter((r) => r.entry.state.kind === kind);

    const waiting = byKind("waiting").sort(
      (a, b) => a.entry.since - b.entry.since,
    );
    const errored = byKind("errored").sort(
      (a, b) => a.entry.since - b.entry.since,
    );
    const working = byKind("working").sort(
      (a, b) => a.entry.since - b.entry.since,
    );
    const done = byKind("done").sort((a, b) => b.entry.since - a.entry.since);

    this.appendGroup(waiting, t("ui.orchestration.groupWaiting"), flashing);
    this.appendGroup(errored, t("ui.orchestration.groupErrored"), flashing);
    this.appendGroup(working, t("ui.orchestration.groupWorking"), flashing);
    this.appendDoneGroup(done, flashing);

    this.selected = Math.max(0, Math.min(this.selected, this.nav.length - 1));
    this.highlightSelected();
  }

  private appendGroup(
    rows: BoardRow[],
    label: string,
    flashing: Set<string>,
  ): void {
    if (rows.length === 0) return;
    const head = document.createElement("div");
    head.className = "orch-group-head";
    head.textContent = `${label} · ${rows.length}`;
    this.list.appendChild(head);
    const group = document.createElement("div");
    group.className = "orch-group";
    for (const row of rows) group.appendChild(this.rowEl(row, flashing));
    this.list.appendChild(group);
  }

  private appendDoneGroup(rows: BoardRow[], flashing: Set<string>): void {
    if (rows.length === 0) return;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "orch-group-head orch-toggle";
    const chevron = this.doneExpanded ? "▾" : "▸";
    toggle.textContent = `${chevron} ${t("ui.orchestration.groupDone")} · ${rows.length}`;
    toggle.addEventListener("click", () => this.toggleDone());
    this.list.appendChild(toggle);
    this.nav.push({ kind: "toggle", el: toggle });

    if (!this.doneExpanded) return;
    const group = document.createElement("div");
    group.className = "orch-group";
    for (const row of rows) group.appendChild(this.rowEl(row, flashing));
    this.list.appendChild(group);
  }

  private toggleDone(): void {
    this.doneExpanded = !this.doneExpanded;
    this.renderList(new Set());
  }

  private rowEl(row: BoardRow, flashing: Set<string>): HTMLElement {
    const el = document.createElement("div");
    el.className = `orch-row kind-${row.entry.state.kind}`;
    if (row.entry.confidence === "low") el.classList.add("state-low");
    if (row.entry.confidence === "tentative")
      el.classList.add("state-tentative");
    if (flashing.has(row.id)) el.classList.add("flash");
    if (
      row.entry.state.kind === "waiting" &&
      Date.now() - row.entry.since > AGED_WAITING_MS
    ) {
      el.classList.add("aged");
    }
    el.dataset.since = String(row.entry.since);
    el.title = stateTitle(row.entry);

    const kind = row.entry.state.kind;
    const glyph = document.createElement("span");
    glyph.className = "orch-glyph";
    if (kind === "working") buildWorkingMark(glyph);
    else glyph.textContent = STATE_GLYPH[kind];

    const identity = document.createElement("span");
    identity.className = "orch-tab";
    const chip = document.createElement("span");
    chip.className = "orch-chip";
    if (row.color) chip.style.background = row.color;
    const name = document.createElement("span");
    name.className = "orch-tabname";
    name.textContent = row.tab;
    identity.append(chip, name);

    const detail = document.createElement("span");
    detail.className = "orch-detail";
    detail.textContent = this.detailText(row);

    const age = document.createElement("span");
    age.className = "orch-age";
    age.textContent = compactAge(row.entry.since / 1000);

    el.append(glyph, identity, detail, age);
    el.addEventListener("click", () => this.activate(row.id));

    this.nav.push({ kind: "session", id: row.id, el });
    return el;
  }

  // The board leads with the owning tab so identical commands across sessions
  // (three "claude --continue") stay distinguishable; the command trails as
  // secondary context.
  private detailText(row: BoardRow): string {
    const tail = row.entry.payload || stateTitle(row.entry);
    if (row.label && row.label !== row.tab) return `${row.label} · ${tail}`;
    return tail;
  }

  private emptyState(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "orch-empty overlay-empty";
    wrap.textContent = t("ui.orchestration.empty");
    return wrap;
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      this.move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      this.move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      this.activateSelected();
    }
  }

  private move(delta: number): void {
    if (this.nav.length === 0) return;
    this.selected = (this.selected + delta + this.nav.length) % this.nav.length;
    this.highlightSelected();
  }

  private highlightSelected(): void {
    this.nav.forEach((item, i) => {
      item.el.classList.toggle("selected", i === this.selected);
    });
    this.nav[this.selected]?.el.scrollIntoView({ block: "nearest" });
  }

  private activateSelected(): void {
    const item = this.nav[this.selected];
    if (!item) return;
    if (item.kind === "toggle") {
      this.toggleDone();
      return;
    }
    this.activate(item.id);
  }

  private activate(id: string): void {
    this.close();
    this.cb.onActivate(id);
  }
}
