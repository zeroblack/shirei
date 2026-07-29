import type { FocusPreset } from "../config";
import { t } from "../i18n";
import { CHECK } from "../icons";
import { createOverlay } from "../overlay";

export interface FocusPanelShortcuts {
  toggle: string;
  skip: string;
  reset: string;
  panel: string;
}

export interface FocusPanelState {
  presets: FocusPreset[];
  activePresetId: string;
  focusMinOverride: number | null;
  quickFocusSteps: number[];
  focusStepMin: number;
  focusMinFloor: number;
  focusMinCeil: number;
  shortcuts: FocusPanelShortcuts;
}

export interface FocusPanelCallbacks {
  onPickPreset: (id: string) => void;
  onSetFocusMin: (min: number | null) => void;
  onSaveAsPreset: () => void;
  onClose: () => void;
}

export interface FocusPanelHandle {
  close: () => Promise<void>;
}

export interface PresetRow {
  id: string;
  label: string;
  summary: string;
  active: boolean;
}

export function presetRows(
  presets: FocusPreset[],
  activePresetId: string,
): PresetRow[] {
  return presets.map((preset) => ({
    id: preset.id,
    label: preset.label,
    summary: t("ui.focus.panel.presetSummary", {
      focus: preset.focus_min,
      break: preset.break_min,
    }),
    active: preset.id === activePresetId,
  }));
}

export function effectiveFocusMin(state: FocusPanelState): number {
  if (state.focusMinOverride !== null) return state.focusMinOverride;
  const active = state.presets.find((p) => p.id === state.activePresetId);
  return active?.focus_min ?? 0;
}

export function clampFocusMin(
  min: number,
  step: number,
  floor: number,
  ceil: number,
): number {
  const effectiveFloor = Math.max(floor, step);
  return Math.min(ceil, Math.max(effectiveFloor, min));
}

function row(className: string, tag = "div"): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  return el;
}

function groupLabel(text: string): HTMLElement {
  const el = row("focus-panel-group-label");
  el.textContent = text;
  return el;
}

function buildPresetSection(
  state: FocusPanelState,
  onPick: (id: string) => void,
): HTMLElement {
  const section = row("focus-panel-section");
  const list = row("focus-panel-presets");
  for (const preset of presetRows(state.presets, state.activePresetId)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "focus-panel-preset";
    btn.dataset.presetRow = preset.id;
    btn.dataset.active = String(preset.active);
    btn.setAttribute("aria-pressed", String(preset.active));

    const label = row("focus-panel-preset-label", "span");
    label.textContent = preset.label;

    const meta = row("focus-panel-preset-meta", "span");
    const summary = row("focus-panel-preset-summary", "span");
    summary.textContent = preset.summary;
    const check = row("focus-panel-preset-check", "span");
    check.innerHTML = CHECK;
    check.setAttribute("aria-hidden", "true");
    meta.append(summary, check);

    btn.append(label, meta);
    btn.addEventListener("click", () => onPick(preset.id));
    list.append(btn);
  }
  section.append(groupLabel(t("ui.focus.panel.presetsGroup")), list);
  return section;
}

function buildQuickFocusSection(
  state: FocusPanelState,
  onSetFocusMin: (min: number | null) => void,
): HTMLElement {
  const section = row("focus-panel-section");
  const chips = row("focus-panel-chips");
  const current = effectiveFocusMin(state);

  for (const step of state.quickFocusSteps) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "focus-panel-chip";
    chip.dataset.chip = String(step);
    const active = current === step;
    chip.dataset.active = String(active);
    chip.setAttribute("aria-pressed", String(active));
    chip.textContent = t("ui.focus.panel.chip", { min: step });
    chip.addEventListener("click", () => {
      if (state.focusMinOverride === step) {
        onSetFocusMin(null);
        return;
      }
      onSetFocusMin(
        clampFocusMin(
          step,
          state.focusStepMin,
          state.focusMinFloor,
          state.focusMinCeil,
        ),
      );
    });
    chips.append(chip);
  }

  const stepper = row("focus-panel-stepper");
  const dec = document.createElement("button");
  dec.type = "button";
  dec.className = "focus-panel-stepper-btn";
  dec.textContent = "−";
  dec.setAttribute("aria-label", t("ui.focus.panel.stepperDec"));
  dec.addEventListener("click", () => {
    onSetFocusMin(
      clampFocusMin(
        current - state.focusStepMin,
        state.focusStepMin,
        state.focusMinFloor,
        state.focusMinCeil,
      ),
    );
  });

  const value = row("focus-panel-stepper-value", "span");
  value.dataset.stepperValue = "";
  value.textContent = t("ui.focus.panel.stepperValue", { min: current });

  const inc = document.createElement("button");
  inc.type = "button";
  inc.className = "focus-panel-stepper-btn";
  inc.textContent = "+";
  inc.setAttribute("aria-label", t("ui.focus.panel.stepperInc"));
  inc.addEventListener("click", () => {
    onSetFocusMin(
      clampFocusMin(
        current + state.focusStepMin,
        state.focusStepMin,
        state.focusMinFloor,
        state.focusMinCeil,
      ),
    );
  });

  stepper.append(dec, value, inc);
  section.append(groupLabel(t("ui.focus.panel.lengthGroup")), chips, stepper);
  return section;
}

function buildSaveSection(onSave: () => void): HTMLElement {
  const section = row("focus-panel-section");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "focus-panel-save";
  btn.dataset.save = "";
  btn.textContent = t("ui.focus.panel.save");
  btn.addEventListener("click", onSave);
  section.append(btn);
  return section;
}

// A quiet, single-line reminder of the bindings this panel and its cell
// already respond to — no new shortcuts, just discoverability. Any entry
// whose binding was cleared in the keymap drops out instead of showing a
// dangling label with nothing after it.
function buildLegend(shortcuts: FocusPanelShortcuts): HTMLElement | null {
  const entries = [
    { label: t("ui.focus.panel.legend.startPause"), key: shortcuts.toggle },
    { label: t("ui.focus.panel.legend.skip"), key: shortcuts.skip },
    { label: t("ui.focus.panel.legend.reset"), key: shortcuts.reset },
    { label: t("ui.focus.panel.legend.change"), key: shortcuts.panel },
  ].filter((entry) => entry.key.length > 0);
  if (entries.length === 0) return null;

  const legend = row("focus-panel-legend");
  entries.forEach((entry, index) => {
    if (index > 0) {
      const sep = row("focus-panel-legend-sep", "span");
      sep.textContent = "·";
      sep.setAttribute("aria-hidden", "true");
      legend.append(sep);
    }
    const item = row("focus-panel-legend-item", "span");
    item.textContent = `${entry.label} ${entry.key}`;
    legend.append(item);
  });
  return legend;
}

function positionPanel(box: HTMLElement, anchor: HTMLElement): void {
  const margin = 8;
  const anchorRect = anchor.getBoundingClientRect();
  const boxRect = box.getBoundingClientRect();

  let left = anchorRect.left + anchorRect.width / 2 - boxRect.width / 2;
  left = Math.max(
    margin,
    Math.min(left, window.innerWidth - boxRect.width - margin),
  );

  let top = anchorRect.bottom + margin;
  if (top + boxRect.height > window.innerHeight - margin) {
    top = anchorRect.top - boxRect.height - margin;
  }
  top = Math.max(margin, top);

  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
}

// Mounted at document.body like every other overlay, so it escapes the
// dock cell's `container-type: size` (which would otherwise pin a fixed
// descendant's containing block to the tiny cell instead of the viewport).
// That means it falls outside the `.focus-cell` subtree the timer skin's
// `--timer-*` custom properties are set on — snapshot the one role this
// panel actually needs onto the box itself so it still reads the live skin.
export function openFocusPanel(
  anchor: HTMLElement,
  initialState: FocusPanelState,
  cb: FocusPanelCallbacks,
): FocusPanelHandle {
  const {
    overlay,
    box,
    close: closeOverlay,
  } = createOverlay({
    className: "focus-panel",
    label: t("ui.focus.panel.title"),
    onDismiss: () => void close(),
    // Worst-case duration is the "lively" timer-motion scalar (1.4x) over the
    // panel's 160ms open/close transition; the fallback only matters if
    // transitionend never fires (e.g. reduced motion collapses it to 0ms).
    closeDurationMs: 230,
  });

  const anchorStyle = getComputedStyle(anchor);
  const timerFocus = anchorStyle.getPropertyValue("--timer-focus").trim();
  if (timerFocus) box.style.setProperty("--timer-focus", timerFocus);
  const timerMotion = anchorStyle.getPropertyValue("--timer-motion").trim();
  if (timerMotion) box.style.setProperty("--timer-motion", timerMotion);

  let state = initialState;
  let closed = false;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await closeOverlay();
    cb.onClose();
    anchor.focus();
  };

  const title = row("focus-panel-title");
  title.textContent = t("ui.focus.panel.title");

  const renderBody = (focusSelector?: string): void => {
    const children = [
      title,
      buildPresetSection(state, (id) => {
        cb.onPickPreset(id);
        state = { ...state, activePresetId: id, focusMinOverride: null };
        renderBody(`[data-preset-row="${id}"]`);
      }),
      buildQuickFocusSection(state, (min) => {
        cb.onSetFocusMin(min);
        state = { ...state, focusMinOverride: min };
        renderBody(
          min === null ? "[data-stepper-value]" : `[data-chip="${min}"]`,
        );
      }),
      buildSaveSection(() => {
        cb.onSaveAsPreset();
        void close();
      }),
      buildLegend(state.shortcuts),
    ].filter((child): child is HTMLElement => child !== null);
    box.replaceChildren(...children);
    positionPanel(box, anchor);
    const target = focusSelector
      ? box.querySelector<HTMLElement>(focusSelector)
      : null;
    (target ?? box.querySelector<HTMLElement>("button"))?.focus();
  };

  document.body.appendChild(overlay);
  renderBody();

  return { close };
}
