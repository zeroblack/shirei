import { parseNaturalDate } from "./dates";
import { t } from "./i18n";
import { createOverlay } from "./overlay";
import { showToast } from "./toast";
import { type Todo, todoAdd, todoUpdate } from "./todos";

export interface TodoModalOpts {
  project: { id: string; name: string; color: string } | null;
  onSaved: () => void;
  editing?: Todo;
  listVisible?: boolean;
}

const priorityLabel = (priority: number): string =>
  priority === 3
    ? t("ui.todomodal.priorityHigh")
    : priority === 2
      ? t("ui.todomodal.priorityMid")
      : t("ui.todomodal.priorityLow");

export function openTodoModal(opts: TodoModalOpts): void {
  let priority: number | null = opts.editing?.priority ?? null;
  let dueDate: string | null = opts.editing?.dueDate ?? null;
  let note: string | null = opts.editing?.note ?? null;

  let priorityRow: HTMLElement | null = null;
  let dateRow: HTMLElement | null = null;
  let noteRow: HTMLElement | null = null;
  let dateEcho: HTMLElement | null = null;
  let revealIndex = 0;

  const { overlay, box, close } = createOverlay({
    className: "todo-modal",
    label: opts.editing
      ? t("ui.todomodal.labelEdit")
      : t("ui.todomodal.labelNew"),
    closeDurationMs: 130,
    onDismiss: () => void close(),
  });

  const chip = document.createElement("div");
  chip.className = "todo-modal-chip";

  if (opts.project) {
    const dot = document.createElement("span");
    dot.className = "todo-modal-chip-dot";
    dot.style.background = opts.project.color;

    const chipName = document.createElement("span");
    chipName.className = "todo-modal-chip-name";
    chipName.textContent = opts.project.name;

    chip.append(dot, chipName);
  } else {
    chip.className = "todo-modal-chip todo-modal-chip--no-project";
    chip.textContent = t("ui.todomodal.noProject");
  }

  const input = document.createElement("input");
  input.className = "todo-modal-input";
  input.type = "text";
  input.placeholder = t("ui.todomodal.titlePlaceholder");
  if (opts.editing) input.value = opts.editing.text;

  const hints = document.createElement("div");
  hints.className = "todo-modal-hints";

  const hintP = makeHint("⌃P", t("ui.todomodal.hintPriority"));
  const hintD = makeHint("⌃D", t("ui.todomodal.hintDate"));
  const hintN = makeHint("⌃N", t("ui.todomodal.hintNote"));
  hints.append(hintP, hintD, hintN);

  const fields = document.createElement("div");
  fields.className = "todo-modal-fields";

  const footer = document.createElement("div");
  footer.className = "todo-modal-footer";

  const saveHint = document.createElement("span");
  saveHint.className = "todo-modal-footer-hint";
  saveHint.textContent = t("ui.todomodal.saveHint");
  footer.append(saveHint);

  box.append(chip, input, hints, fields, footer);
  document.body.appendChild(overlay);
  input.focus();

  if (opts.editing) {
    if (opts.editing.priority !== null && opts.editing.priority !== undefined) {
      revealPriority(false);
    }
    if (opts.editing.dueDate) {
      revealDate(false);
    }
    if (opts.editing.note) {
      revealNote(false);
    }
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "p" && e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      revealPriority(true);
      return;
    }
    if (e.key === "d" && e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      revealDate(true);
      return;
    }
    if (e.key === "n" && e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      revealNote(true);
      return;
    }
    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      void save();
    }
  });

  function makeHint(key: string, label: string): HTMLElement {
    const el = document.createElement("span");
    el.className = "todo-modal-hint";
    const kbd = document.createElement("kbd");
    kbd.textContent = key;
    const txt = document.createTextNode(` ${label}`);
    el.append(kbd, txt);
    return el;
  }

  function revealPriority(animate: boolean): void {
    if (priorityRow) {
      cycleOrFocusPriority();
      return;
    }

    priorityRow = document.createElement("div");
    priorityRow.className = revealClass(animate);

    const label = document.createElement("span");
    label.className = "todo-modal-field-label";
    label.textContent = t("ui.todomodal.priorityLabel");

    const cycleBtn = document.createElement("button");
    cycleBtn.className = "todo-modal-field-value";
    cycleBtn.type = "button";
    cycleBtn.textContent = priority ? priorityLabel(priority) : "—";

    const nextPriority = () => {
      if (priority === null) priority = 3;
      else if (priority === 3) priority = 2;
      else if (priority === 2) priority = 1;
      else priority = null;
      cycleBtn.textContent = priority ? priorityLabel(priority) : "—";
    };

    cycleBtn.addEventListener("click", nextPriority);
    cycleBtn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        nextPriority();
      }
    });

    priorityRow.append(label, cycleBtn);
    appendField(priorityRow, animate);
  }

  function cycleOrFocusPriority(): void {
    if (!priorityRow) return;
    const btn = priorityRow.querySelector("button");
    if (btn) btn.click();
  }

  function revealDate(animate: boolean): void {
    if (dateRow) {
      dateRow.querySelector("input")?.focus();
      return;
    }

    dateRow = document.createElement("div");
    dateRow.className = revealClass(animate);

    const label = document.createElement("span");
    label.className = "todo-modal-field-label";
    label.textContent = t("ui.todomodal.dateLabel");

    const dateInput = document.createElement("input");
    dateInput.className = "todo-modal-field-input";
    dateInput.type = "text";
    dateInput.placeholder = t("ui.todomodal.datePlaceholder");
    if (dueDate) dateInput.value = dueDate;

    dateEcho = document.createElement("span");
    dateEcho.className = "todo-modal-date-echo";

    const updateEcho = () => {
      const parsed = parseNaturalDate(dateInput.value, new Date());
      if (!dateEcho) return;
      if (parsed) {
        dueDate = parsed;
        dateEcho.textContent = t("ui.todomodal.dateEcho", { date: parsed });
        dateEcho.classList.remove("todo-modal-date-echo--invalid");
      } else if (dateInput.value.trim()) {
        dueDate = null;
        dateEcho.textContent = t("ui.todomodal.dateUnrecognized");
        dateEcho.classList.add("todo-modal-date-echo--invalid");
      } else {
        dueDate = null;
        dateEcho.textContent = "";
        dateEcho.classList.remove("todo-modal-date-echo--invalid");
      }
    };

    dateInput.addEventListener("input", updateEcho);
    dateInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.focus();
      }
    });

    if (dueDate) {
      dateInput.value = dueDate;
      updateEcho();
    }

    dateRow.append(label, dateInput, dateEcho);
    appendField(dateRow, animate);
    dateInput.focus();
  }

  function revealNote(animate: boolean): void {
    if (noteRow) {
      noteRow.querySelector("textarea")?.focus();
      return;
    }

    noteRow = document.createElement("div");
    noteRow.className = `${revealClass(animate)} todo-modal-field--note`;

    const label = document.createElement("span");
    label.className = "todo-modal-field-label";
    label.textContent = t("ui.todomodal.noteLabel");

    const textarea = document.createElement("textarea");
    textarea.className = "todo-modal-field-textarea";
    textarea.placeholder = t("ui.todomodal.notePlaceholder");
    textarea.rows = 2;
    if (note) textarea.value = note;

    textarea.addEventListener("input", () => {
      note = textarea.value.trim() || null;
    });
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void save();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        input.focus();
      }
    });

    noteRow.append(label, textarea);
    appendField(noteRow, animate);
    textarea.focus();
  }

  function revealClass(animate: boolean): string {
    if (!animate) return "todo-modal-field";
    return "todo-modal-field todo-modal-field--reveal";
  }

  function appendField(el: HTMLElement, animated: boolean): void {
    if (animated) {
      const staggerRaw = getComputedStyle(document.documentElement)
        .getPropertyValue("--reveal-stagger")
        .trim();
      const staggerMs = staggerRaw.endsWith("ms")
        ? parseFloat(staggerRaw)
        : parseFloat(staggerRaw) * 1000;
      const delay = Number.isFinite(staggerMs) ? staggerMs : 40;
      el.style.animationDelay = `${revealIndex * delay}ms`;
      revealIndex++;
    }
    fields.appendChild(el);
  }

  async function save(): Promise<void> {
    if (!opts.project) return;

    const text = input.value.trim();
    if (!text) return;

    const patch = {
      priority: priority ?? null,
      dueDate: dueDate ?? null,
      note: note ?? null,
    };

    if (opts.editing) {
      await todoUpdate(opts.editing.id, { text, ...patch });
    } else {
      const created = await todoAdd(opts.project.id, text);
      const hasMeta =
        patch.priority !== null ||
        patch.dueDate !== null ||
        patch.note !== null;
      if (hasMeta) {
        await todoUpdate(created.id, patch);
      }
      if (!opts.listVisible) {
        showToast(t("ui.todomodal.taskAdded"));
      }
    }

    opts.onSaved();
    void close();
  }
}
