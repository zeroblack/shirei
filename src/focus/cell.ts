import {
  focusSessionEnd,
  focusSessionStart,
  focusSessionUpdate,
} from "../commands";
import type { FocusConfig, FocusPreset } from "../config";
import { t } from "../i18n";
import {
  CHEVRON_DOWN,
  CLOSE,
  PENCIL,
  REVERT,
  TIMER_BREAK_GLYPH,
  TIMER_IDLE_GLYPH,
  TIMER_OVERFLOW_GLYPH,
  TIMER_PAUSE,
  TIMER_PLAY,
  TIMER_SKIP,
} from "../icons";
import type { FocusLogEvent, FocusLogTransition, FocusStatus } from "./logging";
import { logEventsFor } from "./logging";
import {
  type Phase,
  TimerMachine,
  type TimerPreset,
  type TimerStartOptions,
  type TimerView,
} from "./machine";
import type { FocusPanelHandle, FocusPanelShortcuts } from "./panel";
import { openFocusPanel } from "./panel";
import { applyTimerTheme, deriveTimerColors } from "./theme";

export type FocusCellShortcuts = FocusPanelShortcuts;

const NO_SHORTCUTS: FocusCellShortcuts = {
  toggle: "",
  skip: "",
  reset: "",
  panel: "",
};

export interface FocusSessionContext {
  projectId?: string | null;
  shireiSessionId?: string | null;
}

export interface CellView {
  dataPhase: Phase;
  progress: number;
  label: string;
  timeText: string;
  glyph: string;
  metaText: string;
  metaCompactText: string;
}

const TICK_MS = 250;
const NUMERIC_REFRESH_MS = 1_000;
// The healthy-day rhythm ceiling the pips fill toward (~4 focused ultradian
// bouts). A future config candidate, not a hard product rule.
const RHYTHM_TARGET = 4;
// Ring diameter as a fraction of the cell's shorter side, and the width/height
// thresholds for the compact/expanded layout steps — the geometry the CSS used
// to encode as 42cqmin and the 260/220/420 @container breakpoints, relocated to
// JS because container-type:size collapses this cell in the shipped WKWebView.
const FOCUS_RING_SCALE = 0.42;
const FOCUS_COMPACT_MAX_W = 260;
const FOCUS_COMPACT_MAX_H = 220;
const FOCUS_EXPANDED_MIN = 420;

const PHASE_GLYPHS: Record<Phase, string> = {
  idle: TIMER_IDLE_GLYPH,
  running: TIMER_PLAY,
  paused: TIMER_PAUSE,
  break: TIMER_BREAK_GLYPH,
  overflow: TIMER_OVERFLOW_GLYPH,
};

function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatFocusDuration(totalSeconds: number): string {
  const minutes = Math.round(totalSeconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h${m.toString().padStart(2, "0")}m` : `${m}m`;
}

function presetFor(
  cfg: FocusConfig,
  presetId: string,
): FocusPreset | undefined {
  return cfg.presets.find((p) => p.id === presetId) ?? cfg.presets[0];
}

function formatMetaText(preset: TimerPreset): string {
  if (preset.breakMin === 0) {
    return t("ui.focus.metaFocusOnly", { focus: preset.focusMin });
  }
  if (preset.longBreakMin === 0) {
    return t("ui.focus.metaNoLong", {
      focus: preset.focusMin,
      break: preset.breakMin,
    });
  }
  return t("ui.focus.meta", {
    focus: preset.focusMin,
    break: preset.breakMin,
    long: preset.longBreakMin,
    every: preset.cyclesBeforeLong,
  });
}

function formatMetaCompactText(preset: TimerPreset): string {
  if (preset.breakMin === 0) {
    return t("ui.focus.metaCompactFocusOnly", { focus: preset.focusMin });
  }
  return t("ui.focus.metaCompact", {
    focus: preset.focusMin,
    break: preset.breakMin,
  });
}

export function renderView(view: TimerView, preset: TimerPreset): CellView {
  const label = preset.label;
  const glyph = PHASE_GLYPHS[view.phase];
  const metaText = formatMetaText(preset);
  const metaCompactText = formatMetaCompactText(preset);

  if (view.phase === "idle") {
    const plannedMs = preset.focusMin * 60_000;
    return {
      dataPhase: "idle",
      progress: view.progress,
      label,
      timeText: formatClock(plannedMs),
      glyph,
      metaText,
      metaCompactText,
    };
  }

  if (view.phase === "overflow") {
    return {
      dataPhase: "overflow",
      progress: view.progress,
      label,
      timeText: `+${formatClock(view.overflowMs)}`,
      glyph,
      metaText,
      metaCompactText,
    };
  }

  if (view.remainingMs === 0 && view.overflowMs === 0) {
    return {
      dataPhase: view.phase,
      progress: view.progress,
      label,
      timeText: "",
      glyph,
      metaText,
      metaCompactText,
    };
  }

  return {
    dataPhase: view.phase,
    progress: view.progress,
    label,
    timeText: formatClock(view.remainingMs),
    glyph,
    metaText,
    metaCompactText,
  };
}

interface ResolvedPreset extends TimerPreset {
  autoAdvance: boolean;
}

function toTimerPreset(preset: FocusPreset): ResolvedPreset {
  return {
    id: preset.id,
    label: preset.label,
    focusMin: preset.focus_min,
    breakMin: preset.break_min,
    longBreakMin: preset.long_break_min,
    cyclesBeforeLong: preset.cycles_before_long,
    autoAdvance: preset.auto_advance,
  };
}

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag: string): SVGElement {
  return document.createElementNS(SVG_NS, tag);
}

const FOCUS_LOG_PHASE = "focus";

function deriveMethod(preset: TimerPreset): string {
  return preset.focusMin > 0 ? "pomodoro" : "flowtime";
}

export interface PauseAccumState {
  blockPausedMs: number;
  pauseStartedAtMs: number | null;
}

export function accumulatePause(
  state: PauseAccumState,
  previousPhase: Phase,
  nextPhase: Phase,
  nowMs: number,
): PauseAccumState {
  if (previousPhase !== "paused" || nextPhase === "paused") return state;
  if (state.pauseStartedAtMs === null) return state;
  return {
    blockPausedMs: state.blockPausedMs + (nowMs - state.pauseStartedAtMs),
    pauseStartedAtMs: null,
  };
}

// The hourglass drives its two SVG cover rects off a single write on a
// shared ancestor, so progressEl isn't always an HTMLElement.
type StylableElement = HTMLElement | SVGElement;

// What a shape builder hands back to the cell: the viz element itself, the
// element that receives the live `--timer-progress` custom property (the
// property is declared `inherits: false`, so it must land on the exact node
// whose CSS reads it — never assumed to cascade from an ancestor), and where
// the mm:ss number belongs relative to that viz. Ring keeps it centered
// inside the viz; a shape like hourglass/bar will return "below" so the
// number renders as a body sibling instead.
interface ShapeBuild {
  viz: HTMLElement;
  progressEl: StylableElement;
  // A sibling of progressEl that also reads the live --timer-progress value.
  // inherits:false means the property never cascades down from progressEl,
  // so any other node whose CSS depends on it (the coffee steam, sitting
  // beside the fill rather than inside it) needs its own explicit mirror.
  progressMirror?: StylableElement;
  numberPlacement: "center" | "below";
}

const FOCUS_PHASES = new Set<Phase>(["running", "overflow"]);

// A phase-change alert fires only when the timer actually crosses the
// focus/break line — the transition a user cares about hearing. Pausing,
// resuming, resetting, and drifting into overflow (still the same focus
// block, just over its planned length) all stay silent.
export function isAlertBoundary(from: Phase, to: Phase): boolean {
  if (from === to) return false;
  if (to === "break") return FOCUS_PHASES.has(from);
  if (from === "break") return FOCUS_PHASES.has(to);
  return false;
}

export class FocusCell {
  readonly id: string;
  onCloseRequest?: () => void;
  onPhaseChange?: (from: Phase, to: Phase) => void;
  onPresetSaved?: () => void;
  onRename?: (name: string | null) => void;
  sessionName: string | null = null;
  private readonly container: HTMLElement;
  private readonly body: HTMLElement;
  private readonly core: HTMLElement;
  private readonly controlsEl: HTMLElement;
  // Assigned synchronously in the constructor via mountShape(), before any
  // other method can observe them — TS just can't trace that through a
  // private method call, hence the definite-assignment assertions.
  private viz!: HTMLElement;
  private progressEl!: StylableElement;
  private progressMirror: StylableElement | null = null;
  private numberPlacement!: "center" | "below";
  private cfg: FocusConfig;
  private readonly machine = new TimerMachine();
  private readonly glyphEl: HTMLElement;
  private readonly labelEl: HTMLButtonElement;
  private readonly labelTextEl: HTMLElement;
  private readonly idRow: HTMLElement;
  private readonly editBtn: HTMLButtonElement;
  private readonly nameEl: HTMLElement;
  private readonly nameInput: HTMLInputElement;
  private readonly timeEl: HTMLElement;
  private readonly metaSlot: HTMLElement;
  private readonly metaFullEl: HTMLElement;
  private readonly metaCompactEl: HTMLElement;
  private readonly modifiedDotEl: HTMLElement;
  private readonly pipsSlot: HTMLElement;
  private readonly cyclePips: HTMLElement[] = [];
  private readonly breakPips: HTMLElement[] = [];
  private readonly tallyEl: HTMLElement;
  private readonly tallyCountEl: HTMLElement;
  private readonly tallyCyclesLabelEl: HTMLElement;
  private readonly tallyTimeEl: HTMLElement;
  private readonly tallyFocusSuffixEl: HTMLElement;
  private lastCyclesDone = 0;
  private readonly toggleBtn: HTMLButtonElement;
  private readonly skipBtn: HTMLButtonElement;
  private readonly resetBtn: HTMLButtonElement;
  private shortcuts: FocusCellShortcuts;
  private panel: FocusPanelHandle | null = null;
  private intervalId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private ringMinPx = 0;
  private ringMaxPx = 0;
  private lastPhase: Phase = "idle";
  // The last non-paused active phase, so a mid-break pause keeps lighting the
  // break pip (TimerView collapses focus-pause and break-pause into "paused").
  private lastActivePhase: Phase = "running";
  private lastNumericUpdateMs = 0;
  private _presetId: string;
  private _stagedPresetId: string | null = null;
  // `undefined` means no staged change is pending — the override could
  // legitimately be staged to `null` (clearing it), so that value alone
  // can't double as the sentinel the way `_stagedPresetId` uses it.
  private _stagedFocusMinOverride: number | null | undefined = undefined;
  private focusMinOverride: number | null = null;
  private metricsEnabled: boolean;
  private readonly logContext: {
    projectId: string | null;
    shireiSessionId: string | null;
  };
  private sessionUuid: string | null = null;
  private blockStartTs = 0;
  private blockPauseCount = 0;
  private blockPausedMs = 0;
  private pauseStartedAtMs: number | null = null;
  // Chains every focusSessionStart/Update/End call onto the previous one so a
  // fast start->skip can never deliver the end update before the start insert
  // lands — the daemon-side rows would otherwise race and land out of order.
  private logChain: Promise<void> = Promise.resolve();

  constructor(
    id: string,
    container: HTMLElement,
    cfg: FocusConfig,
    paletteBg: string,
    metricsEnabled = false,
    logContext: FocusSessionContext = {},
    shortcuts: FocusCellShortcuts = NO_SHORTCUTS,
  ) {
    this.id = id;
    this.container = container;
    this.cfg = cfg;
    this._presetId = cfg.default_preset;
    this.metricsEnabled = metricsEnabled;
    this.shortcuts = shortcuts;
    this.logContext = {
      projectId: logContext.projectId ?? null,
      shireiSessionId: logContext.shireiSessionId ?? null,
    };

    this.container.classList.add("focus-cell");
    this.container.tabIndex = -1;
    this.container.dataset.phase = "idle";
    this.container.dataset.numericEmphasis = cfg.numeric_emphasis;
    this.container.dataset.shape = cfg.timer_shape;

    const core = document.createElement("div");
    core.className = "focus-core";
    this.core = core;
    this.glyphEl = document.createElement("span");
    this.glyphEl.className = "focus-glyph";
    this.labelEl = document.createElement("button");
    this.labelEl.type = "button";
    this.labelEl.className = "focus-preset";
    this.labelEl.tabIndex = -1;
    this.labelEl.title = this.withShortcut(
      t("ui.focus.panel.open"),
      this.shortcuts.panel,
    );
    this.labelEl.setAttribute("aria-haspopup", "dialog");
    this.labelEl.addEventListener("click", () => this.openPanel());
    this.labelTextEl = document.createElement("span");
    this.labelTextEl.className = "focus-preset-name";
    const chevron = document.createElement("span");
    chevron.className = "focus-preset-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.innerHTML = CHEVRON_DOWN;
    this.labelEl.append(this.labelTextEl, chevron);

    this.editBtn = document.createElement("button");
    this.editBtn.type = "button";
    this.editBtn.className = "focus-edit";
    this.editBtn.tabIndex = -1;
    this.editBtn.innerHTML = PENCIL;
    this.editBtn.title = t("ui.focus.nameSession");
    this.editBtn.setAttribute("aria-label", this.editBtn.title);
    this.editBtn.addEventListener("click", () => this.startRename());
    this.idRow = document.createElement("div");
    this.idRow.className = "focus-idrow";
    this.idRow.append(this.labelEl, this.editBtn);

    this.nameEl = document.createElement("span");
    this.nameEl.className = "focus-name";
    this.nameEl.hidden = true;

    this.nameInput = document.createElement("input");
    this.nameInput.type = "text";
    this.nameInput.className = "focus-name-input";
    this.nameInput.maxLength = 60;
    this.nameInput.placeholder = t("ui.focus.namePlaceholder");
    this.nameInput.hidden = true;
    this.nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.commitRename();
      else if (e.key === "Escape") this.cancelRename();
    });
    this.nameInput.addEventListener("blur", () => this.commitRename());

    this.timeEl = document.createElement("span");
    this.timeEl.className = "focus-time";
    core.append(this.glyphEl, this.timeEl);

    const controls = document.createElement("div");
    controls.className = "focus-controls";
    this.controlsEl = controls;
    this.toggleBtn = this.button(TIMER_PLAY, t("ui.focus.start"), () =>
      this.toggleStart(),
    );
    this.skipBtn = this.button(
      TIMER_SKIP,
      this.withShortcut(t("ui.focus.skip"), this.shortcuts.skip),
      () => this.skip(),
    );
    this.resetBtn = this.button(
      REVERT,
      this.withShortcut(t("ui.focus.reset"), this.shortcuts.reset),
      () => this.reset(),
    );
    const closeBtn = this.button(CLOSE, t("ui.focus.close"), () =>
      this.onCloseRequest?.(),
    );
    controls.append(this.toggleBtn, this.skipBtn, this.resetBtn, closeBtn);

    const body = document.createElement("div");
    body.className = "focus-body";
    this.body = body;
    const metaSlot = document.createElement("div");
    metaSlot.className = "focus-meta";
    this.metaFullEl = document.createElement("span");
    this.metaFullEl.className = "focus-meta-full";
    this.metaCompactEl = document.createElement("span");
    this.metaCompactEl.className = "focus-meta-compact";
    this.modifiedDotEl = document.createElement("span");
    this.modifiedDotEl.className = "focus-modified-dot";
    this.modifiedDotEl.setAttribute("aria-hidden", "true");
    this.modifiedDotEl.title = t("ui.focus.modified");
    metaSlot.append(this.metaFullEl, this.metaCompactEl, this.modifiedDotEl);
    this.metaSlot = metaSlot;

    const pipsSlot = document.createElement("div");
    pipsSlot.className = "focus-pips";
    pipsSlot.setAttribute("aria-hidden", "true");
    for (let i = 0; i < RHYTHM_TARGET; i++) {
      const cyclePip = document.createElement("span");
      cyclePip.className = "pip";
      cyclePip.dataset.kind = "cycle";
      cyclePip.dataset.state = "pending";
      pipsSlot.append(cyclePip);
      this.cyclePips.push(cyclePip);
      if (i < RHYTHM_TARGET - 1) {
        const breakPip = document.createElement("span");
        breakPip.className = "pip";
        breakPip.dataset.kind = "break";
        breakPip.dataset.state = "pending";
        pipsSlot.append(breakPip);
        this.breakPips.push(breakPip);
      }
    }
    this.pipsSlot = pipsSlot;

    const tallyEl = document.createElement("div");
    tallyEl.className = "focus-tally";
    tallyEl.style.display = "none";
    this.tallyCountEl = document.createElement("b");
    this.tallyCyclesLabelEl = document.createElement("span");
    const tallySep = document.createElement("span");
    tallySep.className = "sep";
    tallySep.textContent = "·";
    this.tallyTimeEl = document.createElement("b");
    this.tallyFocusSuffixEl = document.createElement("span");
    tallyEl.append(
      this.tallyCountEl,
      this.tallyCyclesLabelEl,
      tallySep,
      this.tallyTimeEl,
      this.tallyFocusSuffixEl,
    );
    this.tallyEl = tallyEl;

    this.mountShape(this.buildShape(cfg.timer_shape));
    this.assembleBody();
    this.container.append(body);

    this.applyRingBounds(cfg);
    this.observeSize();

    const colors = deriveTimerColors(paletteBg, cfg.theme, cfg.role_overrides);
    applyTimerTheme(this.container, colors, cfg);

    this.render(this.machine.tick(Date.now()), true);
    this.intervalId = window.setInterval(() => {
      this.render(this.machine.tick(Date.now()));
    }, TICK_MS);
  }

  // The ring: unchanged from before the shape-strategy split, just relocated.
  // `dataset.ringStyle` reads `this.cfg` directly since callers always set it
  // before building (constructor order, and setConfig assigning cfg first).
  private buildRing(): ShapeBuild {
    const ringWrap = document.createElement("div");
    ringWrap.className = "focus-ring-wrap";
    ringWrap.dataset.ringStyle = this.cfg.ring_style;
    const ring = document.createElement("div");
    ring.className = "focus-ring";
    const glow = document.createElement("div");
    glow.className = "focus-glow";
    ringWrap.append(ring, glow);
    return { viz: ringWrap, progressEl: ring, numberPlacement: "center" };
  }

  // A liquid fill and its meniscus share the same DOM shape whether they sit
  // inside the plain round clip (liquid) or the mug silhouette (coffee) — the
  // only difference between the two shapes is the container they fill.
  private createLiquidFill(): HTMLElement {
    const fill = document.createElement("div");
    fill.className = "focus-liquid-fill";
    const meniscus = document.createElement("div");
    meniscus.className = "focus-liquid-meniscus";
    fill.append(meniscus);
    return fill;
  }

  // A round clip with the fill draining as time runs down — full at progress 0,
  // empty at progress 1 — transform + overflow:hidden only, no mask, no rAF.
  private buildLiquid(): ShapeBuild {
    const wrap = document.createElement("div");
    wrap.className = "focus-liquid-wrap";
    const clip = document.createElement("div");
    clip.className = "focus-liquid-clip";
    const fill = this.createLiquidFill();
    clip.append(fill);
    wrap.append(clip);
    return { viz: wrap, progressEl: fill, numberPlacement: "center" };
  }

  // Same liquid engine as buildLiquid(), clipped by a mug silhouette (a
  // border-radius cup body + a border-arc handle) instead of a plain circle.
  // Pure CSS shapes, no SVG — the WKWebView transform-origin-on-SVG bug that
  // forces the hourglass into a translate-cover technique doesn't apply here.
  // The steam sits on `wrap`, not inside `cup` — the cup clips with
  // overflow:hidden to mask the liquid fill, and that same clip would cut
  // the rising wisps off at the rim.
  private buildCoffee(): ShapeBuild {
    const wrap = document.createElement("div");
    wrap.className = "focus-coffee-wrap";
    const cup = document.createElement("div");
    cup.className = "focus-coffee-cup";
    const fill = this.createLiquidFill();
    cup.append(fill);
    const handle = document.createElement("div");
    handle.className = "focus-coffee-handle";
    const steam = document.createElement("div");
    steam.className = "focus-coffee-steam";
    steam.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 3; i++) {
      const wisp = document.createElement("span");
      wisp.className = "focus-coffee-wisp";
      steam.append(wisp);
    }
    wrap.append(cup, handle, steam);
    return {
      viz: wrap,
      progressEl: fill,
      progressMirror: steam,
      numberPlacement: "center",
    };
  }

  // Sand triangles are static; only the covers move. Both bulbs share one
  // bounding-box size (viewBox units, not percent — CSS transform lengths on
  // an SVG element resolve against its local user-coordinate system, so a
  // plain `px` calc is exact regardless of the shape's rendered size, and it
  // sidesteps the transform-box ambiguity that percent-based SVG transforms
  // carry). The cover never gets `transform-origin`; a translate the full
  // bulb height is enough to slide it fully clear of its own clipped triangle.
  private static readonly HOURGLASS_BULB_H = 32;

  // Two static sand triangles, each clipped by an SVG clipPath and covered by
  // a field-colored rect translated straight over it (NEVER transform-origin
  // on an SVG node — it silently no-ops in the shipped WKWebView). Sand and
  // cover sit as DIRECT children of the shared progress group — `clip-path`
  // is set per-rect instead of on a wrapping `<g>` — because `--timer-progress`
  // is inherits:false: an `inherit` on the cover only reaches its immediate
  // parent, so an intermediate wrapper between the cover and the group that
  // carries the live value would stay stuck at the initial 0.
  private buildHourglass(): ShapeBuild {
    const uid = `hourglass-${crypto.randomUUID()}`;
    const wrap = document.createElement("div");
    wrap.className = "focus-hourglass-wrap";

    const svgRoot = svgEl("svg");
    svgRoot.setAttribute("class", "focus-hourglass-svg");
    svgRoot.setAttribute("viewBox", "0 0 75 100");
    svgRoot.setAttribute("aria-hidden", "true");

    const defs = svgEl("defs");
    const clipTop = svgEl("clipPath");
    clipTop.id = `${uid}-top`;
    const clipTopShape = svgEl("polygon");
    clipTopShape.setAttribute("points", "14,14 61,14 37.5,46");
    clipTop.append(clipTopShape);
    const clipBottom = svgEl("clipPath");
    clipBottom.id = `${uid}-bottom`;
    const clipBottomShape = svgEl("polygon");
    clipBottomShape.setAttribute("points", "14,86 61,86 37.5,54");
    clipBottom.append(clipBottomShape);
    defs.append(clipTop, clipBottom);

    const glass = svgEl("path");
    glass.setAttribute("class", "focus-hourglass-glass");
    glass.setAttribute("d", "M6,6 L69,6 L41,50 L69,94 L6,94 L34,50 Z");

    const progress = svgEl("g");
    progress.setAttribute("class", "focus-hourglass-progress");
    // Single source for the bulb height: the CSS cover translate reads it as a
    // custom prop (unregistered, so it inherits to the direct-child covers).
    progress.style.setProperty(
      "--hourglass-bulb-h",
      `${FocusCell.HOURGLASS_BULB_H}px`,
    );

    const sandTop = svgEl("rect");
    sandTop.setAttribute("class", "focus-hourglass-sand");
    sandTop.setAttribute("clip-path", `url(#${uid}-top)`);
    sandTop.setAttribute("x", "14");
    sandTop.setAttribute("y", "14");
    sandTop.setAttribute("width", "47");
    sandTop.setAttribute("height", `${FocusCell.HOURGLASS_BULB_H}`);
    const coverTop = svgEl("rect");
    coverTop.setAttribute("class", "focus-hourglass-cover-top");
    coverTop.setAttribute("clip-path", `url(#${uid}-top)`);
    coverTop.setAttribute("x", "14");
    coverTop.setAttribute("y", "14");
    coverTop.setAttribute("width", "47");
    coverTop.setAttribute("height", `${FocusCell.HOURGLASS_BULB_H}`);

    const sandBottom = svgEl("rect");
    sandBottom.setAttribute("class", "focus-hourglass-sand");
    sandBottom.setAttribute("clip-path", `url(#${uid}-bottom)`);
    sandBottom.setAttribute("x", "14");
    sandBottom.setAttribute("y", "54");
    sandBottom.setAttribute("width", "47");
    sandBottom.setAttribute("height", `${FocusCell.HOURGLASS_BULB_H}`);
    const coverBottom = svgEl("rect");
    coverBottom.setAttribute("class", "focus-hourglass-cover-bottom");
    coverBottom.setAttribute("clip-path", `url(#${uid}-bottom)`);
    coverBottom.setAttribute("x", "14");
    coverBottom.setAttribute("y", "54");
    coverBottom.setAttribute("width", "47");
    coverBottom.setAttribute("height", `${FocusCell.HOURGLASS_BULB_H}`);

    progress.append(sandTop, coverTop, sandBottom, coverBottom);
    svgRoot.append(defs, glass, progress);
    wrap.append(svgRoot);

    return { viz: wrap, progressEl: progress, numberPlacement: "below" };
  }

  // A single HTML column: a track background plus a fill that shrinks off
  // the bottom via scaleY. HTML is the one case where transform-origin is
  // safe — the WKWebView bug that rules it out is scoped to SVG elements.
  private buildBar(): ShapeBuild {
    const wrap = document.createElement("div");
    wrap.className = "focus-bar-wrap";
    const fill = document.createElement("div");
    fill.className = "focus-bar-fill";
    wrap.append(fill);
    return { viz: wrap, progressEl: fill, numberPlacement: "below" };
  }

  private buildShape(shape: string): ShapeBuild {
    switch (shape) {
      case "liquid":
        return this.buildLiquid();
      case "coffee":
        return this.buildCoffee();
      case "hourglass":
        return this.buildHourglass();
      case "bar":
        return this.buildBar();
      default:
        return this.buildRing();
    }
  }

  // Wires a freshly-built shape into the cell's own fields. Center placement
  // nests the shared `.focus-core` inside the viz (ring today); a "below"
  // shape leaves the viz core-less and assembleBody() seats the core as a
  // body sibling instead.
  private mountShape(build: ShapeBuild): void {
    this.viz = build.viz;
    this.progressEl = build.progressEl;
    this.progressMirror = build.progressMirror ?? null;
    this.numberPlacement = build.numberPlacement;
    if (build.numberPlacement === "center") this.viz.append(this.core);
  }

  private assembleBody(): void {
    const children =
      this.numberPlacement === "below" ? [this.viz, this.core] : [this.viz];
    children.push(
      this.idRow,
      this.nameEl,
      this.nameInput,
      this.metaSlot,
      this.pipsSlot,
      this.tallyEl,
      this.controlsEl,
    );
    this.body.replaceChildren(...children);
  }

  // Appends a resolved keymap binding to a control's label, e.g. "Reset (⌘⌃0)"
  // — never a hardcoded key string, and the binding is dropped entirely (not
  // shown as an empty pair of parens) when the action has no live binding.
  private withShortcut(label: string, shortcut: string): string {
    return shortcut ? t("ui.focus.shortcutHint", { label, shortcut }) : label;
  }

  private isPausable(phase: Phase): boolean {
    return phase === "running" || phase === "break" || phase === "overflow";
  }

  private toggleLabelForPhase(phase: Phase): string {
    if (this.isPausable(phase)) return t("ui.focus.pause");
    return phase === "paused" ? t("ui.focus.resume") : t("ui.focus.start");
  }

  private applyToggleTitle(phase: Phase): void {
    this.toggleBtn.title = this.withShortcut(
      this.toggleLabelForPhase(phase),
      this.shortcuts.toggle,
    );
    this.toggleBtn.setAttribute("aria-label", this.toggleBtn.title);
  }

  private button(
    glyph: string,
    label: string,
    run: () => void,
  ): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "focus-btn";
    b.innerHTML = glyph;
    b.title = label;
    b.setAttribute("aria-label", label);
    b.tabIndex = -1;
    b.addEventListener("click", run);
    return b;
  }

  private render(
    view: TimerView,
    forceNumeric = false,
    manualSkip = false,
  ): void {
    const previousPhase = this.lastPhase;
    if (previousPhase !== view.phase) {
      this.trackFocusSession(previousPhase, view.phase, Date.now(), manualSkip);
      if (isAlertBoundary(previousPhase, view.phase)) {
        this.onPhaseChange?.(previousPhase, view.phase);
      }
    }
    const out = renderView(view, this.displayPreset());
    this.lastPhase = view.phase;
    this.container.dataset.phase = out.dataPhase;
    this.container.dataset.staged = String(this.isStaged());
    this.progressEl.style.setProperty("--timer-progress", `${out.progress}`);
    this.progressMirror?.style.setProperty(
      "--timer-progress",
      `${out.progress}`,
    );
    this.labelTextEl.textContent = out.label;
    this.glyphEl.innerHTML = out.glyph;
    if (previousPhase !== view.phase) this.pulse(this.glyphEl, "is-ticking");

    const now = Date.now();
    if (forceNumeric || now - this.lastNumericUpdateMs >= NUMERIC_REFRESH_MS) {
      this.timeEl.textContent = out.timeText;
      this.lastNumericUpdateMs = now;
    }

    this.metaFullEl.textContent = out.metaText;
    this.metaCompactEl.textContent = out.metaCompactText;
    this.modifiedDotEl.dataset.visible = String(
      this.displayOverride() !== null,
    );
    this.renderSessionGlance({
      cyclesCompleted: view.cyclesCompleted,
      breaksCompleted: view.breaksCompleted,
      focusSeconds: view.focusSeconds,
      phase: view.phase,
    });

    this.toggleBtn.innerHTML = this.isPausable(view.phase)
      ? TIMER_PAUSE
      : TIMER_PLAY;
    this.applyToggleTitle(view.phase);
  }

  // Pips are a fixed RHYTHM_TARGET-length rhythm, built once in the
  // constructor — never rebuilt per tick, only their data-state flips. Past
  // RHYTHM_TARGET cycles, pips stay capped full and the tally carries the
  // true count; pips read the rhythm, the tally is the source of truth.
  private renderSessionGlance(input: {
    cyclesCompleted: number;
    breaksCompleted: number;
    focusSeconds: number;
    phase: Phase;
  }): void {
    const { cyclesCompleted, breaksCompleted, focusSeconds, phase } = input;
    const active = phase === "paused" ? this.lastActivePhase : phase;
    if (active === "running" || active === "overflow" || active === "break") {
      this.lastActivePhase = active;
    }
    const inFocus = active === "running" || active === "overflow";
    const inBreak = active === "break";

    const cyclesDone = Math.min(cyclesCompleted, RHYTHM_TARGET);
    for (let k = 0; k < this.cyclePips.length; k++) {
      this.cyclePips[k].dataset.state =
        k < cyclesDone
          ? "done"
          : k === cyclesDone && inFocus
            ? "current"
            : "pending";
    }

    const breaksDone = Math.min(breaksCompleted, RHYTHM_TARGET - 1);
    for (let k = 0; k < this.breakPips.length; k++) {
      this.breakPips[k].dataset.state =
        k < breaksDone
          ? "done"
          : k === breaksDone && inBreak
            ? "current"
            : "pending";
    }

    if (cyclesCompleted > this.lastCyclesDone && cyclesDone > 0) {
      const settledPip = this.cyclePips[cyclesDone - 1];
      settledPip.dataset.final = String(cyclesCompleted >= RHYTHM_TARGET);
      this.pulse(settledPip, "is-filling");
    }
    this.lastCyclesDone = cyclesCompleted;

    const showTally = cyclesCompleted >= 1;
    this.tallyEl.style.display = showTally ? "" : "none";
    this.metaSlot.style.display = showTally ? "none" : "";
    if (showTally) {
      this.tallyCountEl.textContent = String(cyclesCompleted);
      this.tallyCyclesLabelEl.textContent =
        cyclesCompleted === 1 ? t("ui.focus.cycle") : t("ui.focus.cycles");
      this.tallyTimeEl.textContent = formatFocusDuration(focusSeconds);
      this.tallyFocusSuffixEl.textContent = t("ui.focus.focusSuffix");
    }
  }

  // Adding the class again with no reflow in between would be a no-op (the
  // animation is already running/finished on that class), so force a reflow
  // between removing and re-adding to let it retrigger every time.
  private pulse(el: HTMLElement, className: string): void {
    el.classList.remove(className);
    void el.offsetWidth;
    el.classList.add(className);
  }

  private isStaged(): boolean {
    return (
      this._stagedPresetId !== null ||
      this._stagedFocusMinOverride !== undefined
    );
  }

  // The preset governing the machine: what start()/reset() commit to, and
  // what an already-running block keeps using until then.
  activePreset(): ResolvedPreset {
    const preset = presetFor(this.cfg, this._presetId);
    if (!preset) throw new Error("focus config has no presets");
    return this.withOverride(toTimerPreset(preset), this.focusMinOverride);
  }

  // What the cell shows right now: the staged preset/override while one is
  // pending (a preview only — the machine keeps running the active preset
  // and its committed override), else the active preset itself.
  private displayPreset(): TimerPreset {
    const id = this._stagedPresetId ?? this._presetId;
    const preset = presetFor(this.cfg, id);
    const base = preset ? toTimerPreset(preset) : this.activePreset();
    return this.withOverride(base, this.displayOverride());
  }

  private displayOverride(): number | null {
    return this._stagedFocusMinOverride !== undefined
      ? this._stagedFocusMinOverride
      : this.focusMinOverride;
  }

  private withOverride<T extends TimerPreset>(
    preset: T,
    override: number | null,
  ): T {
    if (override === null) return preset;
    return { ...preset, focusMin: override };
  }

  // Idle: applies immediately (label/meta/idle-planned-time update now).
  // Running/paused/break/overflow: stages the pick — the machine is never
  // touched mid-block, it only takes effect on the next start()/reset().
  setPreset(id: string): void {
    if (!this.cfg.presets.some((p) => p.id === id)) return;
    if (this.lastPhase === "idle") {
      this._presetId = id;
      this._stagedPresetId = null;
    } else {
      this._stagedPresetId = id;
    }
    this.render(this.machine.tick(Date.now()), true);
    this.pulse(this.timeEl, "is-nudging");
    this.pulse(this.metaSlot, "is-nudging");
  }

  // Mirrors setPreset's staging: idle applies the override right away,
  // running/paused/break/overflow only preview it until the block resets.
  // The override is transient by design (see reset()), so unlike a preset
  // pick it never survives past a reset even when it was staged there.
  setFocusMinOverride(min: number | null): void {
    if (this.lastPhase === "idle") {
      this.focusMinOverride = min;
      this._stagedFocusMinOverride = undefined;
    } else {
      this._stagedFocusMinOverride = min;
    }
    this.render(this.machine.tick(Date.now()), true);
    this.pulse(this.timeEl, "is-nudging");
    this.pulse(this.metaSlot, "is-nudging");
  }

  private commitStagedPreset(): void {
    if (this._stagedPresetId === null) return;
    this._presetId = this._stagedPresetId;
    this._stagedPresetId = null;
  }

  // Hydrates a name loaded back from the pin dock's saved state — never
  // fires onRename, since restoring isn't a fresh user action to log.
  restoreName(name: string | null): void {
    this.sessionName = name;
    this.applyName();
  }

  startRename(): void {
    this.nameInput.value = this.sessionName ?? "";
    this.nameEl.hidden = true;
    this.nameInput.hidden = false;
    this.nameInput.focus();
    this.nameInput.select();
  }

  private commitRename(): void {
    if (this.nameInput.hidden) return;
    const name = this.nameInput.value.trim();
    this.sessionName = name || null;
    this.nameInput.hidden = true;
    this.applyName();
    this.onRename?.(this.sessionName);
  }

  private cancelRename(): void {
    this.nameInput.hidden = true;
    this.applyName();
  }

  private applyName(): void {
    if (this.sessionName) {
      this.nameEl.textContent = this.sessionName;
      this.nameEl.hidden = false;
    } else {
      this.nameEl.hidden = true;
    }
  }

  openPanel(): void {
    if (this.panel) return;
    this.panel = openFocusPanel(
      this.labelEl,
      {
        presets: this.cfg.presets,
        activePresetId: this._stagedPresetId ?? this._presetId,
        focusMinOverride: this.displayOverride(),
        quickFocusSteps: this.cfg.quick_focus_steps,
        focusStepMin: this.cfg.focus_step_min,
        focusMinFloor: this.cfg.focus_min_floor,
        focusMinCeil: this.cfg.focus_min_ceil,
        shortcuts: this.shortcuts,
      },
      {
        onPickPreset: (id) => {
          this.setFocusMinOverride(null);
          this.setPreset(id);
        },
        onSetFocusMin: (min) => this.setFocusMinOverride(min),
        onSaveAsPreset: () => this.saveActiveAsPreset(),
        onClose: () => {
          this.panel = null;
        },
      },
    );
  }

  // Persists what the panel is actually showing as selected — the staged
  // pick and its staged override when one is pending, not the machine's
  // still-committed preset — as a brand-new preset. Both live in the same
  // shared `cfg.presets` array the app owns, so the push alone is visible
  // config-side; the caller still has to persist and re-propagate it
  // (mirrors how section-focus.ts saves presets).
  private saveActiveAsPreset(): void {
    const displayed = this.displayPreset();
    const base = presetFor(this.cfg, this._stagedPresetId ?? this._presetId);
    if (!base) throw new Error("focus config has no presets");
    const saved: FocusPreset = {
      id: crypto.randomUUID(),
      label: t("ui.focus.panel.savedLabel", {
        label: displayed.label,
        focus: displayed.focusMin,
      }),
      focus_min: displayed.focusMin,
      break_min: displayed.breakMin,
      long_break_min: displayed.longBreakMin,
      cycles_before_long: displayed.cyclesBeforeLong,
      auto_advance: base.auto_advance,
    };
    this.cfg.presets.push(saved);
    this.onPresetSaved?.();
  }

  private startOptions(): TimerStartOptions {
    return {
      overflowEnabled: this.cfg.overflow_enabled,
      autoAdvance: this.activePreset().autoAdvance,
      overflowCapMin: this.cfg.overflow_cap_min,
    };
  }

  // Stores the numeric ring bounds the ResizeObserver clamps against; guards a
  // hand-edited ring_min_px > ring_max_px so the max never falls below the min.
  private applyRingBounds(cfg: FocusConfig): void {
    this.ringMinPx = cfg.ring_min_px;
    this.ringMaxPx = Math.max(cfg.ring_min_px, cfg.ring_max_px);
    this.container.style.setProperty("--focus-ring-min", `${this.ringMinPx}px`);
    this.container.style.setProperty("--focus-ring-max", `${this.ringMaxPx}px`);
  }

  // Ring size and the compact/regular/expanded layout step are driven from the
  // cell's real box here, not container queries — container-type:size collapses
  // this inset-sized absolute host to zero block-size in the shipped WKWebView.
  private observeSize(): void {
    this.applyResponsiveSize(
      this.container.clientWidth,
      this.container.clientHeight,
    );
    this.resizeObserver = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1].contentRect;
      this.applyResponsiveSize(box.width, box.height);
    });
    this.resizeObserver.observe(this.container);
  }

  private applyResponsiveSize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    const size = Math.max(
      this.ringMinPx,
      Math.min(Math.min(width, height) * FOCUS_RING_SCALE, this.ringMaxPx),
    );
    this.container.style.setProperty("--focus-ring-size", `${size}px`);
    this.container.dataset.size =
      width <= FOCUS_COMPACT_MAX_W || height <= FOCUS_COMPACT_MAX_H
        ? "compact"
        : width >= FOCUS_EXPANDED_MIN && height >= FOCUS_EXPANDED_MIN
          ? "expanded"
          : "regular";
  }

  // Re-derives everything a live cell would otherwise only pick up on the
  // next reopen (theme, ring look, metrics gating) without touching the
  // running TimerMachine — a config save must never reset an in-flight block.
  setConfig(
    cfg: FocusConfig,
    paletteBg: string,
    metricsEnabled: boolean,
    shortcuts: FocusCellShortcuts = this.shortcuts,
  ): void {
    const shapeChanged = cfg.timer_shape !== this.cfg.timer_shape;
    this.cfg = cfg;
    this.metricsEnabled = metricsEnabled;
    this.container.dataset.numericEmphasis = cfg.numeric_emphasis;
    this.container.dataset.shape = cfg.timer_shape;
    if (shapeChanged) {
      this.mountShape(this.buildShape(cfg.timer_shape));
      this.assembleBody();
    }
    if (cfg.timer_shape === "ring") {
      this.viz.dataset.ringStyle = cfg.ring_style;
    }
    this.applyRingBounds(cfg);
    this.applyResponsiveSize(
      this.container.clientWidth,
      this.container.clientHeight,
    );
    const colors = deriveTimerColors(paletteBg, cfg.theme, cfg.role_overrides);
    applyTimerTheme(this.container, colors, cfg);
    this.applyShortcuts(shortcuts);
  }

  // Refreshes every control's tooltip from the live keymap — called on every
  // config apply (a rebind is just another config save) so a cell that has
  // been open since before a rebind never shows a stale key hint.
  private applyShortcuts(shortcuts: FocusCellShortcuts): void {
    this.shortcuts = shortcuts;
    this.applyToggleTitle(this.lastPhase);
    this.skipBtn.title = this.withShortcut(t("ui.focus.skip"), shortcuts.skip);
    this.skipBtn.setAttribute("aria-label", this.skipBtn.title);
    this.resetBtn.title = this.withShortcut(
      t("ui.focus.reset"),
      shortcuts.reset,
    );
    this.resetBtn.setAttribute("aria-label", this.resetBtn.title);
    this.labelEl.title = this.withShortcut(
      t("ui.focus.panel.open"),
      shortcuts.panel,
    );
  }

  get presetId(): string {
    return this._presetId;
  }

  private trackFocusSession(
    previousPhase: Phase,
    nextPhase: Phase,
    now: number,
    manualSkip = false,
  ): void {
    const hadActivePause = this.pauseStartedAtMs !== null;
    const pauseState = accumulatePause(
      {
        blockPausedMs: this.blockPausedMs,
        pauseStartedAtMs: this.pauseStartedAtMs,
      },
      previousPhase,
      nextPhase,
      now,
    );
    this.blockPausedMs = pauseState.blockPausedMs;
    this.pauseStartedAtMs = pauseState.pauseStartedAtMs;
    const resumedFromPause = hadActivePause && this.pauseStartedAtMs === null;

    if (
      nextPhase === "running" &&
      (previousPhase === "idle" || previousPhase === "break")
    ) {
      this.beginFocusBlock(now);
      return;
    }
    if (resumedFromPause) {
      this.emitPauseUpdate();
    }
    if (nextPhase === "paused") {
      this.pauseFocusBlock(now);
      return;
    }
    if (nextPhase === "break" && previousPhase !== "idle") {
      this.endFocusBlock(manualSkip ? "skipped" : "completed", now);
      return;
    }
    if (nextPhase === "idle") {
      this.endFocusBlock("abandoned", now);
    }
  }

  private beginFocusBlock(now: number): void {
    const preset = this.activePreset();
    this.sessionUuid = crypto.randomUUID();
    this.blockStartTs = now;
    this.blockPauseCount = 0;
    this.blockPausedMs = 0;
    this.pauseStartedAtMs = null;
    this.emitLog({
      kind: "start",
      uuid: this.sessionUuid,
      presetId: this._presetId,
      method: deriveMethod(preset),
      phase: FOCUS_LOG_PHASE,
      plannedDurationS: preset.focusMin * 60,
      startTs: Math.round(now / 1000),
      projectId: this.logContext.projectId,
      shireiSessionId: this.logContext.shireiSessionId,
      agentId: null,
    });
  }

  private pauseFocusBlock(now: number): void {
    if (this.sessionUuid === null) return;
    this.pauseStartedAtMs = now;
    this.blockPauseCount += 1;
    this.emitPauseUpdate();
  }

  private emitPauseUpdate(): void {
    if (this.sessionUuid === null) return;
    this.emitLog({
      kind: "pause",
      uuid: this.sessionUuid,
      pauseCount: this.blockPauseCount,
      pausedDurationS: Math.round(this.blockPausedMs / 1000),
    });
  }

  private endFocusBlock(status: FocusStatus, now: number): void {
    if (this.sessionUuid === null) return;
    if (this.pauseStartedAtMs !== null) {
      this.blockPausedMs += now - this.pauseStartedAtMs;
      this.pauseStartedAtMs = null;
      this.emitPauseUpdate();
    }
    const actualDurationS = Math.max(
      0,
      Math.round((now - this.blockStartTs - this.blockPausedMs) / 1000),
    );
    const uuid = this.sessionUuid;
    this.sessionUuid = null;
    this.emitLog({
      kind: "end",
      uuid,
      endTs: Math.round(now / 1000),
      actualDurationS,
      status,
      note: this.sessionName ?? undefined,
    });
  }

  private emitLog(transition: FocusLogTransition): void {
    // session_note gates the (not yet built) end-of-block reflection prompt
    // — an unrelated, opt-in "what did you work on" note. A name the user
    // deliberately typed into the pill is a different act and must never be
    // silently dropped by that toggle, so it always clears the gate here.
    const sessionNoteGate =
      transition.kind === "end" && this.sessionName !== null
        ? true
        : this.cfg.session_note;
    const events = logEventsFor(transition, {
      metrics: { enabled: this.metricsEnabled },
      focus: { session_note: sessionNoteGate },
    });
    for (const event of events) {
      this.logChain = this.logChain
        .then(() => this.sendLogEvent(event))
        .catch(() => {});
    }
  }

  private sendLogEvent(event: FocusLogEvent): Promise<void> {
    if (event.cmd === "start") return focusSessionStart(event.payload);
    if (event.cmd === "update")
      return focusSessionUpdate(event.uuid, event.patch);
    return focusSessionEnd(event.uuid, event.end);
  }

  toggleStart(): void {
    const now = Date.now();
    if (this.lastPhase === "idle") {
      // A staged pick only exists while running/paused/break/overflow — idle
      // is reached solely through reset(), which already commits it there.
      this.machine.start(this.activePreset(), this.startOptions(), now);
    } else if (this.lastPhase === "paused") {
      this.machine.resume(now);
    } else {
      this.machine.pause(now);
    }
    this.render(this.machine.tick(now), true);
  }

  skip(): void {
    const now = Date.now();
    this.machine.skip(now);
    this.render(this.machine.tick(now), true, true);
  }

  // Resets abandon the whole in-progress block, including any duration
  // override — transient by design, so a fresh block always starts back at
  // its preset's own length unless the user dials in a new override.
  reset(): void {
    this.machine.reset();
    this.commitStagedPreset();
    this.focusMinOverride = null;
    this._stagedFocusMinOverride = undefined;
    this.render(this.machine.tick(Date.now()), true);
  }

  // Pauses a running/overflowing block on an external idle signal without
  // ever resuming it on its own — resuming past an idle span is a deliberate
  // user action, not automatic.
  pauseIfRunning(): void {
    const canPause =
      this.lastPhase === "running" ||
      this.lastPhase === "break" ||
      this.lastPhase === "overflow";
    if (!canPause) return;
    const now = Date.now();
    this.machine.pause(now);
    this.render(this.machine.tick(now), true);
  }

  focus(): void {
    this.toggleBtn.focus();
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.panel) {
      void this.panel.close();
      this.panel = null;
    }
    this.endFocusBlock("abandoned", Date.now());
    this.container.remove();
  }
}
