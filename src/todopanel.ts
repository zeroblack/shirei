import { errorMessage } from "./errors";
import { onLocaleChange, t } from "./i18n";
import { showToast } from "./toast";
import type { Todo } from "./todos";
import {
  todoAdd,
  todoDelete,
  todoList,
  todoReorder,
  todoToggle,
  todoUpdate,
} from "./todos";

export interface TodoPanelOptions {
  onRequestModal: () => void;
  onRequestDetail?: (todo: Todo) => void;
}

// Unicode glyphs per spec §7.3
const GLYPH_EMPTY = "☐";
const GLYPH_DONE = "☑";

// Priority dot colors map to CSS tokens (spec §7.2)
const PRIO_COLORS: Record<number, string> = {
  3: "var(--todo-prio-high)",
  2: "var(--todo-prio-mid)",
  1: "var(--fg-dim)",
};

// Timeout for dd sequence detection (ms)
const DD_TIMEOUT = 400;

const shortcuts = (): { keys: string[]; label: string }[] => [
  { keys: ["o"], label: t("ui.todo.shortcut.add") },
  { keys: ["j", "k"], label: t("ui.todo.shortcut.move") },
  { keys: [t("ui.todo.keySpace")], label: t("ui.todo.shortcut.toggle") },
  { keys: ["e"], label: t("ui.todo.shortcut.edit") },
  { keys: ["i"], label: t("ui.todo.shortcut.detail") },
  { keys: ["d", "d"], label: t("ui.todo.shortcut.delete") },
  { keys: ["⌥", "↑↓"], label: t("ui.todo.shortcut.reorder") },
];

function kbd(label: string): HTMLElement {
  const el = document.createElement("kbd");
  el.className = "todo-kbd";
  el.textContent = label;
  return el;
}

interface Row {
  el: HTMLElement;
  todo: Todo;
}

export class TodoPanel {
  private readonly root: HTMLElement;
  private readonly opts: TodoPanelOptions;
  private readonly header: HTMLElement;
  private readonly focusHint: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly list: HTMLElement;
  private readonly addRow: HTMLElement;

  private items: Todo[] = [];
  private rows: Row[] = [];
  private selected = 0;
  private projectId: string | null = null;
  private focused = false;

  private pendingD = false;
  private ddTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(root: HTMLElement, opts: TodoPanelOptions) {
    this.root = root;
    this.root.classList.add("todo-panel");
    this.root.tabIndex = -1;
    this.opts = opts;

    this.header = document.createElement("div");
    this.header.className = "todo-header";
    const headerLabel = document.createElement("span");
    headerLabel.textContent = t("ui.todo.header");
    this.focusHint = document.createElement("kbd");
    this.focusHint.className = "todo-focus-hint";
    this.countEl = document.createElement("span");
    this.countEl.className = "todo-count";
    this.header.append(headerLabel, this.focusHint, this.countEl);

    this.list = document.createElement("div");
    this.list.className = "todo-list";

    this.addRow = document.createElement("div");
    this.addRow.className = "todo-add";
    const addLabel = document.createElement("span");
    addLabel.textContent = t("ui.todo.addTask");
    this.addRow.append(addLabel, kbd("o"));
    this.addRow.addEventListener("click", () => this.opts.onRequestModal());

    this.root.append(this.header, this.list, this.addRow);

    onLocaleChange(() => {
      headerLabel.textContent = t("ui.todo.header");
      addLabel.textContent = t("ui.todo.addTask");
      if (this.projectId === null) this.renderEmptyNoProject();
      else this.renderList();
    });
  }

  async setProject(projectId: string | null): Promise<void> {
    this.projectId = projectId;
    this.selected = 0;

    if (projectId === null) {
      this.items = [];
      this.renderEmptyNoProject();
      return;
    }

    try {
      const items = await todoList(projectId);
      this.items = sortItems(items);
      this.renderList();
    } catch (err) {
      showToast(t("ui.todo.error.load", { error: errorMessage(err) }));
    }
  }

  setFocusHint(stroke: string): void {
    this.focusHint.textContent = stroke;
    this.focusHint.style.display = stroke ? "" : "none";
  }

  focus(): void {
    this.focused = true;
    // Move DOM focus off the terminal: xterm consumes plain keys and stops their
    // propagation, so they never reach the app's window-level key router unless
    // focus leaves the terminal first.
    this.root.focus();
    this.updateSelectedOpacity();
  }

  blur(): void {
    this.focused = false;
    this.updateSelectedOpacity();
  }

  handleKey(e: KeyboardEvent): boolean {
    // While a quick-add or inline-edit field is focused, every key is text:
    // the shortcuts only apply in navigation mode, not mid-typing.
    const target = e.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement
    ) {
      return false;
    }

    if (e.key === "j" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      this.move(1);
      return true;
    }

    if (e.key === "k" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      this.move(-1);
      return true;
    }

    if (e.key === "o" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      this.startQuickAdd();
      return true;
    }

    if (e.key === " " && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      void this.toggleSelected();
      return true;
    }

    if (e.key === "e" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      void this.editSelectedText();
      return true;
    }

    if (e.key === "i" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const row = this.rows[this.selected];
      if (row) this.opts.onRequestDetail?.(row.todo);
      return true;
    }

    if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      void this.editSelectedText();
      return true;
    }

    if (e.key === "d" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      return this.handleD();
    }

    if (e.altKey && e.key === "ArrowUp") {
      void this.reorderSelected(-1);
      return true;
    }

    if (e.altKey && e.key === "ArrowDown") {
      void this.reorderSelected(1);
      return true;
    }

    return false;
  }

  private renderList(): void {
    this.addRow.style.display = "";
    this.list.replaceChildren();
    this.rows = [];

    if (this.items.length === 0) {
      this.renderEmptyList();
      this.updateCount();
      return;
    }

    for (const todo of this.items) {
      const row = this.makeRow(todo);
      this.rows.push(row);
      this.list.appendChild(row.el);
    }

    this.clampSelected();
    this.updateCount();
    this.highlightSelected();
  }

  private renderEmptyList(): void {
    const note = document.createElement("div");
    note.className = "todo-empty";
    note.textContent = t("ui.todo.empty");

    const legend = document.createElement("div");
    legend.className = "todo-legend";
    for (const { keys, label } of shortcuts()) {
      const row = document.createElement("div");
      row.className = "todo-legend-row";
      const combo = document.createElement("span");
      combo.className = "todo-legend-keys";
      for (const key of keys) combo.appendChild(kbd(key));
      const desc = document.createElement("span");
      desc.className = "todo-legend-label";
      desc.textContent = label;
      row.append(combo, desc);
      legend.appendChild(row);
    }

    this.list.append(note, legend);
  }

  private renderEmptyNoProject(): void {
    this.list.replaceChildren();
    this.rows = [];
    this.addRow.style.display = "none";
    const note = document.createElement("div");
    note.className = "todo-empty";
    note.textContent = t("ui.todo.noProject");
    this.list.appendChild(note);
    this.updateCount();
  }

  private makeRow(todo: Todo): Row {
    const el = document.createElement("div");
    el.className = `todo-row${todo.done ? " done" : ""}`;

    if (todo.priority !== null && todo.priority !== undefined) {
      const prio = document.createElement("span");
      prio.className = "todo-prio";
      prio.textContent = "●";
      prio.style.color = PRIO_COLORS[todo.priority] ?? "var(--fg-dim)";
      el.appendChild(prio);
    }

    const check = document.createElement("span");
    check.className = "todo-check";
    check.textContent = todo.done ? GLYPH_DONE : GLYPH_EMPTY;

    const text = document.createElement("span");
    text.className = "todo-text";
    text.textContent = todo.text;

    el.append(check, text);

    if (todo.dueDate) {
      const badge = document.createElement("span");
      badge.className = `todo-date${isOverdue(todo.dueDate) ? " overdue" : isDueToday(todo.dueDate) ? " today" : ""}`;
      badge.textContent = formatDate(todo.dueDate);
      el.appendChild(badge);
    }

    el.addEventListener("click", () => {
      const idx = this.rows.findIndex((r) => r.todo.id === todo.id);
      if (idx >= 0) {
        this.selected = idx;
        this.highlightSelected();
      }
    });

    el.addEventListener("dblclick", () => {
      const idx = this.rows.findIndex((r) => r.todo.id === todo.id);
      if (idx >= 0) {
        this.selected = idx;
        this.highlightSelected();
        void this.toggleSelected();
      }
    });

    return { el, todo };
  }

  private updateCount(): void {
    const done = this.items.filter((t) => t.done).length;
    const total = this.items.length;
    this.countEl.textContent = total > 0 ? `${done}/${total}` : "";
  }

  private highlightSelected(): void {
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      row.el.classList.toggle("selected", i === this.selected);
    }
    this.updateSelectedOpacity();
    this.rows[this.selected]?.el.scrollIntoView({ block: "nearest" });
  }

  private updateSelectedOpacity(): void {
    const selectedRow = this.rows[this.selected];
    if (!selectedRow) return;
    // Active region: rgba(255,255,255,.1); dormant: rgba(255,255,255,.05) — spec §6
    // The CSS class .selected already handles this via the focused class on the panel root.
    // We drive focus state by adding/removing a class on root so CSS can differentiate.
    this.root.classList.toggle("todo-panel--focused", this.focused);
  }

  private move(delta: number): void {
    if (this.rows.length === 0) return;
    this.selected = Math.max(
      0,
      Math.min(this.rows.length - 1, this.selected + delta),
    );
    this.highlightSelected();
  }

  private clampSelected(): void {
    if (this.rows.length === 0) {
      this.selected = 0;
      return;
    }
    this.selected = Math.max(0, Math.min(this.rows.length - 1, this.selected));
  }

  private handleD(): boolean {
    if (this.pendingD) {
      this.clearDdTimer();
      this.pendingD = false;
      void this.deleteSelected();
      return true;
    }
    this.pendingD = true;
    this.ddTimer = setTimeout(() => {
      this.pendingD = false;
      this.ddTimer = null;
    }, DD_TIMEOUT);
    return true;
  }

  private clearDdTimer(): void {
    if (this.ddTimer !== null) {
      clearTimeout(this.ddTimer);
      this.ddTimer = null;
    }
  }

  private startQuickAdd(): void {
    if (this.projectId === null) return;

    const inputRow = document.createElement("div");
    inputRow.className = "todo-add";
    inputRow.style.height = "28px";
    inputRow.style.padding = "0 10px";

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = t("ui.todo.newTaskPlaceholder");
    input.style.cssText = [
      "flex: 1",
      "background: transparent",
      "border: none",
      "color: var(--fg)",
      "font: inherit",
      "font-size: 12.5px",
      "outline: none",
      "padding: 0",
    ].join(";");

    inputRow.appendChild(input);
    this.list.appendChild(inputRow);
    input.focus();

    const cleanup = () => {
      document.removeEventListener("mousedown", onOutside);
    };

    const commit = async () => {
      cleanup();
      const text = input.value.trim();
      inputRow.remove();
      if (text && this.projectId) {
        try {
          await todoAdd(this.projectId, text);
          await this.reload();
        } catch (err) {
          showToast(t("ui.todo.error.create", { error: errorMessage(err) }));
        }
      }
    };

    const cancel = () => {
      cleanup();
      inputRow.remove();
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    });

    const onOutside = (e: MouseEvent) => {
      if (!inputRow.contains(e.target as Node)) {
        cancel();
      }
    };
    document.addEventListener("mousedown", onOutside);
  }

  private async toggleSelected(): Promise<void> {
    const row = this.rows[this.selected];
    if (!row) return;

    const { todo, el } = row;

    const wasDone = todo.done;
    todo.done = !wasDone;
    const check = el.querySelector(".todo-check");
    if (check) check.textContent = todo.done ? GLYPH_DONE : GLYPH_EMPTY;

    // Capture positions of all rows before reorder (FLIP first step)
    const beforeRects = this.rows.map((r) => r.el.getBoundingClientRect());

    this.items = sortItems(this.items);

    const oldOrder = this.rows.map((r) => r.todo.id);
    const newOrder = this.items.map((t) => t.id);

    const rowMap = new Map(this.rows.map((r) => [r.todo.id, r]));
    const newRows: Row[] = [];
    for (const id of newOrder) {
      const r = rowMap.get(id);
      if (r) newRows.push(r);
    }

    const frag = document.createDocumentFragment();
    for (const r of newRows) frag.appendChild(r.el);
    this.list.appendChild(frag);

    const afterRects = newRows.map((r) => r.el.getBoundingClientRect());

    const oldIdx = new Map(oldOrder.map((id, i) => [id, i]));

    // Apply FLIP: invert (set translateY to delta), then play (transition to 0)
    // Only transform and opacity — spec §8.1
    for (let i = 0; i < newRows.length; i++) {
      const r = newRows[i];
      const oi = oldIdx.get(r.todo.id);
      if (oi === undefined) continue;
      const dy = beforeRects[oi].top - afterRects[i].top;
      if (dy === 0) continue;
      r.el.style.transition = "none";
      r.el.style.transform = `translateY(${dy}px)`;
    }

    // Force reflow to commit the inverted transforms before starting transitions.
    // Reading offsetHeight flushes pending style recalculations synchronously.
    void this.list.offsetHeight;

    // Play: transition to natural position (translateY 0)
    // Duration comes from CSS var --task-sink set by Task 10; fallback to 220ms
    for (const r of newRows) {
      r.el.style.transition =
        "transform var(--task-sink, 220ms) var(--ease-in-out), opacity var(--task-sink, 220ms) var(--ease-in-out)";
      r.el.style.transform = "";
    }

    for (const r of newRows) {
      r.el.classList.toggle("done", r.todo.done);
      const c = r.el.querySelector(".todo-check");
      if (c) c.textContent = r.todo.done ? GLYPH_DONE : GLYPH_EMPTY;
    }

    this.rows = newRows;
    this.clampSelected();
    this.highlightSelected();
    this.updateCount();

    try {
      await todoToggle(todo.id);
    } catch (err) {
      showToast(t("ui.todo.error.update", { error: errorMessage(err) }));
      todo.done = wasDone;
      await this.reload();
    }
  }

  private async editSelectedText(): Promise<void> {
    const row = this.rows[this.selected];
    if (!row) return;

    const { todo, el } = row;
    const textSpan = el.querySelector<HTMLElement>(".todo-text");
    if (!textSpan) return;

    const original = todo.text;
    const input = document.createElement("input");
    input.type = "text";
    input.value = original;
    input.style.cssText = [
      "flex: 1",
      "background: transparent",
      "border: none",
      "border-bottom: 1px solid var(--fg-dim)",
      "color: var(--fg)",
      "font: inherit",
      "font-size: 13px",
      "outline: none",
      "padding: 0",
      "width: 100%",
    ].join(";");

    textSpan.replaceWith(input);
    input.focus();
    input.select();

    let committed = false;

    const commit = async () => {
      if (committed) return;
      committed = true;
      input.removeEventListener("blur", onBlur);
      const text = input.value.trim();
      if (text && text !== original) {
        try {
          const updated = await todoUpdate(todo.id, { text });
          todo.text = updated.text;
        } catch (err) {
          showToast(t("ui.todo.error.edit", { error: errorMessage(err) }));
          todo.text = original;
        }
      } else {
        todo.text = original;
      }
      input.replaceWith(textSpan);
      textSpan.textContent = todo.text;
    };

    const cancel = () => {
      if (committed) return;
      committed = true;
      input.removeEventListener("blur", onBlur);
      input.replaceWith(textSpan);
      textSpan.textContent = original;
    };

    const onBlur = () => {
      void commit();
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    });

    input.addEventListener("blur", onBlur);
  }

  private async deleteSelected(): Promise<void> {
    const row = this.rows[this.selected];
    if (!row) return;

    const id = row.todo.id;
    try {
      await todoDelete(id);
      await this.reload();
    } catch (err) {
      showToast(t("ui.todo.error.delete", { error: errorMessage(err) }));
    }
  }

  private async reorderSelected(direction: -1 | 1): Promise<void> {
    const idx = this.selected;
    const targetIdx = idx + direction;

    if (targetIdx < 0 || targetIdx >= this.rows.length) return;

    const todo = this.rows[idx].todo;
    const neighbor = this.rows[targetIdx].todo;

    const beyondIdx = targetIdx + direction;
    const beyond = this.rows[beyondIdx]?.todo;

    let newPosition: number;
    if (beyond === undefined) {
      newPosition = neighbor.position + direction * 1.0;
    } else {
      newPosition = (neighbor.position + beyond.position) / 2;
    }

    todo.position = newPosition;
    this.items = sortItems(this.items);

    // Derive rows from sorted items — single source of truth prevents rows/items drift
    const rowMap = new Map(this.rows.map((r) => [r.todo.id, r]));
    this.rows = this.items
      .map((t) => rowMap.get(t.id))
      .filter((r): r is Row => r !== undefined);

    this.selected = this.rows.findIndex((r) => r.todo.id === todo.id);
    this.renderFromRows();

    try {
      await todoReorder(todo.id, newPosition);
    } catch (err) {
      showToast(t("ui.todo.error.reorder", { error: errorMessage(err) }));
      await this.reload();
    }
  }

  private renderFromRows(): void {
    const frag = document.createDocumentFragment();
    for (const r of this.rows) {
      r.el.classList.remove("selected");
      frag.appendChild(r.el);
    }
    this.list.replaceChildren(frag);
    this.highlightSelected();
    this.updateCount();
  }

  private async reload(): Promise<void> {
    if (this.projectId === null) return;
    try {
      const items = await todoList(this.projectId);
      this.items = sortItems(items);
      this.renderList();
    } catch (err) {
      showToast(t("ui.todo.error.reload", { error: errorMessage(err) }));
    }
  }
}

function sortItems(items: Todo[]): Todo[] {
  const pending = items
    .filter((t) => !t.done)
    .sort((a, b) => a.position - b.position);
  const done = items
    .filter((t) => t.done)
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  return [...pending, ...done];
}

function parseDateLocal(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, (m as number) - 1, d as number);
}

function isOverdue(dateStr: string): boolean {
  const today = new Date();
  const due = parseDateLocal(dateStr);
  return due < new Date(today.getFullYear(), today.getMonth(), today.getDate());
}

function isDueToday(dateStr: string): boolean {
  const today = new Date();
  const due = parseDateLocal(dateStr);
  return (
    due.getFullYear() === today.getFullYear() &&
    due.getMonth() === today.getMonth() &&
    due.getDate() === today.getDate()
  );
}

function formatDate(dateStr: string): string {
  const d = parseDateLocal(dateStr);
  const today = new Date();
  if (d.getFullYear() === today.getFullYear()) {
    return d.toLocaleDateString("es-CL", { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString("es-CL", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
