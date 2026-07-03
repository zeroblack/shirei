import { t } from "./i18n";
import { createOverlay } from "./overlay";
import type { UpdateState, UpdateStateKind } from "./updatestate";

export interface UpdateModalHandle {
  render(state: UpdateState): void;
}

interface UpdateModalOpts {
  version: string;
  currentVersion: string;
  notes: string;
  onInstall: () => void;
  onDismiss: () => void;
}

interface ButtonSpec {
  label: string;
  onActivate: () => void;
}

function appendInline(parent: HTMLElement, text: string): void {
  const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let match: RegExpExecArray | null = linkPattern.exec(text);
  while (match !== null) {
    if (match.index > last) parent.append(text.slice(last, match.index));
    const span = document.createElement("span");
    span.className = "update-notes-link";
    span.textContent = match[1];
    parent.append(span);
    last = match.index + match[0].length;
    match = linkPattern.exec(text);
  }
  if (last < text.length) parent.append(text.slice(last));
}

function renderNotes(notes: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  if (!notes.trim()) {
    const empty = document.createElement("div");
    empty.className = "update-notes-line";
    empty.textContent = t("ui.update.noNotes");
    frag.append(empty);
    return frag;
  }
  let list: HTMLUListElement | null = null;
  for (const raw of notes.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("- ")) {
      if (!list) {
        list = document.createElement("ul");
        list.className = "update-notes-list";
        frag.append(list);
      }
      const li = document.createElement("li");
      appendInline(li, line.slice(2));
      list.append(li);
      continue;
    }
    list = null;
    if (/^#{1,6}\s+/.test(line)) {
      const heading = document.createElement("div");
      heading.className = "update-notes-heading";
      appendInline(heading, line.replace(/^#{1,6}\s+/, ""));
      frag.append(heading);
      continue;
    }
    if (line === "") {
      frag.append(document.createElement("br"));
      continue;
    }
    const p = document.createElement("div");
    p.className = "update-notes-line";
    appendInline(p, line);
    frag.append(p);
  }
  return frag;
}

export function openUpdateModal(opts: UpdateModalOpts): UpdateModalHandle {
  let locked = false;
  let lastKind: UpdateStateKind = "available";
  let buttons: HTMLButtonElement[] = [];
  let selected = -1;
  let buttonSeq = 0;
  let actionsEl: HTMLElement | null = null;
  let progressWrap: HTMLElement | null = null;
  let progressFill: HTMLElement | null = null;
  let progressPct: HTMLElement | null = null;

  const dismiss = (): void => {
    if (locked) return;
    opts.onDismiss();
    void overlay.close();
  };

  const overlay = createOverlay({
    className: "update",
    role: "alertdialog",
    label: t("ui.update.available", { version: opts.version }),
    onDismiss: dismiss,
  });
  const { box } = overlay;
  box.tabIndex = -1;

  const stateRegion = document.createElement("div");
  stateRegion.className = "update-state";
  stateRegion.setAttribute("aria-live", "polite");
  box.append(stateRegion);

  const select = (i: number): void => {
    if (buttons.length === 0) {
      selected = -1;
      return;
    }
    selected = (i + buttons.length) % buttons.length;
    buttons.forEach((el, idx) => {
      el.classList.toggle("selected", idx === selected);
    });
    box.setAttribute("aria-activedescendant", buttons[selected].id);
  };

  const notesEl = (): HTMLElement | null =>
    box.querySelector<HTMLElement>(".update-notes");

  box.addEventListener("keydown", (e) => {
    switch (e.key) {
      case "Tab":
        e.preventDefault();
        e.stopPropagation();
        select(selected + (e.shiftKey ? -1 : 1));
        break;
      case "ArrowRight":
        e.preventDefault();
        e.stopPropagation();
        select(selected + 1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        e.stopPropagation();
        select(selected - 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        e.stopPropagation();
        notesEl()?.scrollBy({ top: -40 });
        break;
      case "ArrowDown":
        e.preventDefault();
        e.stopPropagation();
        notesEl()?.scrollBy({ top: 40 });
        break;
      case "PageUp":
      case "PageDown": {
        e.preventDefault();
        e.stopPropagation();
        const el = notesEl();
        if (el)
          el.scrollBy({
            top: (e.key === "PageUp" ? -1 : 1) * el.clientHeight * 0.9,
          });
        break;
      }
      case "Home":
      case "End": {
        e.preventDefault();
        e.stopPropagation();
        const el = notesEl();
        if (el) el.scrollTop = e.key === "Home" ? 0 : el.scrollHeight;
        break;
      }
      case "Enter":
        e.preventDefault();
        e.stopPropagation();
        if (selected >= 0 && buttons[selected]) buttons[selected].click();
        break;
    }
  });

  function buildButtons(specs: ButtonSpec[], defaultIndex: number): void {
    buttonSeq += 1;
    buttons = specs.map((spec, i) => {
      const el = document.createElement("button");
      el.type = "button";
      el.id = `update-action-${buttonSeq}-${i}`;
      el.className = "update-btn";
      el.textContent = spec.label;
      el.addEventListener("click", spec.onActivate);
      el.addEventListener("mouseenter", () => select(i));
      return el;
    });
    if (!actionsEl) {
      actionsEl = document.createElement("div");
      actionsEl.className = "update-actions";
    }
    actionsEl.replaceChildren(...buttons);
    box.append(actionsEl);
    select(specs.length > 0 ? defaultIndex : -1);
  }

  function clearProgress(): void {
    progressWrap?.remove();
    progressWrap = null;
    progressFill = null;
    progressPct = null;
  }

  function setTitle(text: string): void {
    box.setAttribute("aria-label", text);
  }

  function renderAvailable(): void {
    locked = false;
    clearProgress();
    stateRegion.replaceChildren();
    const titleText = t("ui.update.available", { version: opts.version });
    const title = document.createElement("div");
    title.className = "update-title";
    title.textContent = titleText;
    const caption = document.createElement("div");
    caption.className = "update-caption";
    caption.textContent = opts.currentVersion
      ? t("ui.update.modalCaption", {
          version: opts.version,
          current: opts.currentVersion,
        })
      : t("ui.update.modalCaptionNoCurrent", { version: opts.version });
    const group = document.createElement("div");
    group.className = "update-group-label";
    group.textContent = t("ui.update.whatsNew");
    const notes = document.createElement("div");
    notes.className = "update-notes";
    notes.append(renderNotes(opts.notes));
    stateRegion.append(title, caption, group, notes);
    setTitle(titleText);
    requestAnimationFrame(() => {
      notes.classList.toggle(
        "scrollable",
        notes.scrollHeight > notes.clientHeight + 1,
      );
    });
    buildButtons(
      [
        { label: t("ui.update.later"), onActivate: dismiss },
        { label: t("ui.update.updateNow"), onActivate: opts.onInstall },
      ],
      1,
    );
  }

  function updateProgress(state: UpdateState): void {
    if (!progressWrap || !progressFill || !progressPct) return;
    const progress = state.progress ?? 0;
    const indeterminate = progress === 0;
    progressWrap.classList.toggle(
      "update-progress-indeterminate",
      indeterminate,
    );
    if (indeterminate) {
      progressWrap.removeAttribute("aria-valuenow");
      progressFill.style.width = "";
      progressPct.textContent = "";
    } else {
      const pct = Math.round(progress * 100);
      progressWrap.setAttribute("aria-valuenow", String(pct));
      progressFill.style.width = `${pct}%`;
      progressPct.textContent = `${pct}%`;
    }
  }

  function renderDownloading(state: UpdateState): void {
    locked = true;
    clearProgress();
    stateRegion.replaceChildren();
    const titleText = t("ui.update.downloadingTitle", {
      version: state.version ?? opts.version,
    });
    const title = document.createElement("div");
    title.className = "update-title";
    title.textContent = titleText;
    const hint = document.createElement("div");
    hint.className = "update-caption";
    hint.textContent = t("ui.update.willRestart");
    stateRegion.append(title, hint);
    setTitle(titleText);

    progressWrap = document.createElement("div");
    progressWrap.className = "update-progress";
    progressWrap.setAttribute("role", "progressbar");
    progressWrap.setAttribute("aria-valuemin", "0");
    progressWrap.setAttribute("aria-valuemax", "100");

    const track = document.createElement("div");
    track.className = "update-progress-track";
    progressFill = document.createElement("div");
    progressFill.className = "update-progress-fill";
    track.append(progressFill);

    progressPct = document.createElement("span");
    progressPct.className = "update-progress-pct";

    const staticLabel = document.createElement("span");
    staticLabel.className = "update-progress-static";
    staticLabel.textContent = t("ui.update.downloadingStatic");

    progressWrap.append(track, progressPct, staticLabel);
    box.append(progressWrap);
    buildButtons([], -1);
    updateProgress(state);
  }

  function renderReady(): void {
    locked = true;
    clearProgress();
    stateRegion.replaceChildren();
    const wrap = document.createElement("div");
    wrap.className = "update-ready";
    const spinner = document.createElement("span");
    spinner.className = "update-spinner";
    spinner.setAttribute("aria-hidden", "true");
    const labelText = t("ui.update.restarting");
    const label = document.createElement("div");
    label.className = "update-title";
    label.textContent = labelText;
    wrap.append(spinner, label);
    stateRegion.append(wrap);
    setTitle(labelText);
    buildButtons([], -1);
  }

  function renderError(message: string): void {
    locked = false;
    clearProgress();
    stateRegion.replaceChildren();
    const titleText = t("ui.update.failedTitle");
    const title = document.createElement("div");
    title.className = "update-title update-title-danger";
    title.textContent = titleText;
    const detail = document.createElement("div");
    detail.className = "update-caption";
    detail.textContent = message.trim();
    stateRegion.append(title, detail);
    setTitle(titleText);
    buildButtons(
      [
        { label: t("ui.update.close"), onActivate: dismiss },
        { label: t("ui.update.retry"), onActivate: opts.onInstall },
      ],
      1,
    );
  }

  function render(state: UpdateState): void {
    if (state.kind === "downloading" && lastKind === "downloading") {
      updateProgress(state);
      return;
    }
    lastKind = state.kind;
    if (state.kind === "downloading") renderDownloading(state);
    else if (state.kind === "ready") renderReady();
    else if (state.kind === "error") renderError(state.message ?? "");
  }

  renderAvailable();
  document.body.append(overlay.overlay);
  box.focus();

  return { render };
}
