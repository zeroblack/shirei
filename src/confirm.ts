import { t } from "./i18n";
import { createOverlay } from "./overlay";

interface ConfirmOpts {
  title: string;
  detail?: string;
  confirmLabel: string;
  danger?: boolean;
}

interface MessageOpts {
  title: string;
  detail?: string;
}

interface Choice<T extends string> {
  label: string;
  value: T;
  danger?: boolean;
}

interface ChoiceOpts<T extends string> {
  title: string;
  detail?: string;
  choices: Choice<T>[];
}

interface DialogButton<R> {
  label: string;
  value: R;
  danger?: boolean;
}

interface DialogOpts<R> {
  title: string;
  detail?: string;
  buttons: DialogButton<R>[];
  cancelValue: R;
  defaultIndex?: number;
}

let dialogSeq = 0;

function appendText(box: HTMLElement, title: string, detail?: string): void {
  const titleEl = document.createElement("div");
  titleEl.className = "confirm-title";
  titleEl.textContent = title;
  box.append(titleEl);
  if (detail) {
    const detailEl = document.createElement("div");
    detailEl.className = "confirm-detail";
    detailEl.textContent = detail;
    box.append(detailEl);
  }
}

// Selection lives on the box (a tabindex=-1 div, always programmatically
// focusable) rather than on the buttons: on macOS WebKit a <button> ignores
// element.focus() unless Full Keyboard Access is on, so focusing a button would
// leave focus stranded on the terminal — where Claude's kitty keymap eats the
// arrows and Enter. Driving a selected index keeps the dialog keyboard-first
// regardless of that system setting, and the .selected class shows the cursor
// since :focus-visible never matches programmatic focus.
function runDialog<R>(opts: DialogOpts<R>): Promise<R> {
  return new Promise((resolve) => {
    const done = (value: R): void => {
      void close();
      resolve(value);
    };
    const { overlay, box, close } = createOverlay({
      className: "confirm",
      role: "alertdialog",
      label: opts.title,
      onDismiss: () => done(opts.cancelValue),
    });
    appendText(box, opts.title, opts.detail);

    const group = ++dialogSeq;
    const buttons = opts.buttons.map((choice, i) => {
      const el = document.createElement("button");
      el.type = "button";
      el.id = `confirm-action-${group}-${i}`;
      el.className = `confirm-btn${choice.danger ? " confirm-danger" : ""}`;
      el.textContent = choice.label;
      el.addEventListener("click", () => done(choice.value));
      el.addEventListener("mouseenter", () => select(i));
      return el;
    });

    const actions = document.createElement("div");
    actions.className = "confirm-actions";
    actions.append(...buttons);
    box.append(actions);

    let selected = -1;
    const select = (i: number): void => {
      selected = (i + buttons.length) % buttons.length;
      buttons.forEach((el, idx) => {
        el.classList.toggle("selected", idx === selected);
      });
      box.setAttribute("aria-activedescendant", buttons[selected].id);
    };

    box.tabIndex = -1;
    box.addEventListener("keydown", (e) => {
      switch (e.key) {
        case "Tab":
          e.preventDefault();
          e.stopPropagation();
          select(selected + (e.shiftKey ? -1 : 1));
          break;
        case "ArrowRight":
        case "ArrowDown":
          e.preventDefault();
          e.stopPropagation();
          select(selected + 1);
          break;
        case "ArrowLeft":
        case "ArrowUp":
          e.preventDefault();
          e.stopPropagation();
          select(selected - 1);
          break;
        case "Enter":
          e.preventDefault();
          e.stopPropagation();
          done(opts.buttons[selected].value);
          break;
      }
    });

    document.body.appendChild(overlay);
    select(opts.defaultIndex ?? 0);
    box.focus();
  });
}

export function confirmDialog(opts: ConfirmOpts): Promise<boolean> {
  return runDialog<boolean>({
    title: opts.title,
    detail: opts.detail,
    buttons: [
      { label: t("ui.dialog.cancel"), value: false },
      { label: opts.confirmLabel, value: true, danger: opts.danger ?? true },
    ],
    cancelValue: false,
  });
}

export function choiceDialog<T extends string>(
  opts: ChoiceOpts<T>,
): Promise<T | null> {
  return runDialog<T | null>({
    title: opts.title,
    detail: opts.detail,
    buttons: [
      { label: t("ui.dialog.cancel"), value: null },
      ...opts.choices.map((choice) => ({
        label: choice.label,
        value: choice.value as T | null,
        danger: choice.danger,
      })),
    ],
    cancelValue: null,
  });
}

export function messageDialog(opts: MessageOpts): Promise<void> {
  return runDialog<void>({
    title: opts.title,
    detail: opts.detail,
    buttons: [{ label: t("ui.dialog.ok"), value: undefined }],
    cancelValue: undefined,
  });
}
