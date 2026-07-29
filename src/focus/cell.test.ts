// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import * as commands from "../commands";
import type { FocusConfig } from "../config";
import {
  accumulatePause,
  FocusCell,
  isAlertBoundary,
  renderView,
} from "./cell";
import type { Phase, TimerPreset, TimerView } from "./machine";

vi.mock("../commands", () => ({
  focusSessionStart: vi.fn(() => Promise.resolve()),
  focusSessionUpdate: vi.fn(() => Promise.resolve()),
  focusSessionEnd: vi.fn(() => Promise.resolve()),
}));

// jsdom lacks ResizeObserver; the cell only needs it to exist to construct.
globalThis.ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver;

function cfgWith(overrides: Partial<FocusConfig> = {}): FocusConfig {
  return {
    presets: [
      {
        id: "pomodoro",
        label: "Pomodoro",
        focus_min: 25,
        break_min: 5,
        long_break_min: 20,
        cycles_before_long: 4,
        auto_advance: true,
      },
      {
        id: "flowtime",
        label: "Flowtime",
        focus_min: 0,
        break_min: 0,
        long_break_min: 0,
        cycles_before_long: 1,
        auto_advance: false,
      },
      {
        id: "deep_work",
        label: "Deep Work",
        focus_min: 10,
        break_min: 5,
        long_break_min: 0,
        cycles_before_long: 1,
        auto_advance: false,
      },
    ],
    default_preset: "pomodoro",
    theme: "sumi",
    role_overrides: {},
    timer_shape: "ring",
    ring_style: "solid",
    ring_width: 3,
    glow_intensity: 0.12,
    motion: "calm",
    numeric_emphasis: "ambient",
    overflow_enabled: true,
    overflow_cap_min: 30,
    start_on_open: false,
    pause_on_idle: false,
    session_note: true,
    alert_channel: "os",
    alert_sound: true,
    alert_timbre: "soft",
    ring_min_px: 96,
    ring_max_px: 200,
    quick_focus_steps: [25, 50, 90],
    focus_step_min: 5,
    focus_min_floor: 5,
    focus_min_ceil: 180,
    ...overrides,
  };
}

const cyclePos = { focus: 0, total: 4 };
const SESSION_ZERO = {
  cyclesCompleted: 0,
  breaksCompleted: 0,
  focusSeconds: 0,
};

const POMODORO_PRESET: TimerPreset = {
  id: "pomodoro",
  label: "Pomodoro",
  focusMin: 25,
  breakMin: 5,
  longBreakMin: 20,
  cyclesBeforeLong: 4,
};

const FLOWTIME_PRESET: TimerPreset = {
  id: "flowtime",
  label: "Flowtime",
  focusMin: 0,
  breakMin: 0,
  longBreakMin: 0,
  cyclesBeforeLong: 1,
};

describe("renderView", () => {
  it("maps a running view to dataPhase running with progress and mm:ss remaining", () => {
    const view: TimerView = {
      phase: "running",
      progress: 0.4,
      remainingMs: 90_000,
      overflowMs: 0,
      cyclePos,
      ...SESSION_ZERO,
    };
    const out = renderView(view, POMODORO_PRESET);
    expect(out.dataPhase).toBe("running");
    expect(out.progress).toBe(0.4);
    expect(out.timeText).toBe("1:30");
    expect(out.label).toBe("Pomodoro");
  });

  it("maps overflow to dataPhase overflow with a +mm:ss over-counter", () => {
    const view: TimerView = {
      phase: "overflow",
      progress: 1.2,
      remainingMs: 0,
      overflowMs: 65_000,
      cyclePos,
      ...SESSION_ZERO,
    };
    const out = renderView(view, POMODORO_PRESET);
    expect(out.dataPhase).toBe("overflow");
    expect(out.progress).toBe(1.2);
    expect(out.timeText).toBe("+1:05");
    expect(out.label).toBe("Pomodoro");
  });

  it("maps idle to the planned focus duration of the given preset", () => {
    const view: TimerView = {
      phase: "idle",
      progress: 0,
      remainingMs: 0,
      overflowMs: 0,
      cyclePos: { focus: 0, total: 0 },
      ...SESSION_ZERO,
    };
    const out = renderView(view, POMODORO_PRESET);
    expect(out.dataPhase).toBe("idle");
    expect(out.timeText).toBe("25:00");
    expect(out.label).toBe("Pomodoro");
  });

  it("maps paused to dataPhase paused and keeps the frozen remaining time", () => {
    const view: TimerView = {
      phase: "paused",
      progress: 0.5,
      remainingMs: 30_000,
      overflowMs: 0,
      cyclePos,
      ...SESSION_ZERO,
    };
    const out = renderView(view, POMODORO_PRESET);
    expect(out.dataPhase).toBe("paused");
    expect(out.timeText).toBe("0:30");
  });

  it("maps break to dataPhase break with mm:ss remaining", () => {
    const view: TimerView = {
      phase: "break",
      progress: 0.2,
      remainingMs: 240_000,
      overflowMs: 0,
      cyclePos,
      ...SESSION_ZERO,
    };
    const out = renderView(view, POMODORO_PRESET);
    expect(out.dataPhase).toBe("break");
    expect(out.timeText).toBe("4:00");
  });

  it("hides the numeric readout for an open-ended flowtime segment", () => {
    const view: TimerView = {
      phase: "running",
      progress: 0.12,
      remainingMs: 0,
      overflowMs: 0,
      cyclePos: { focus: 0, total: 1 },
      ...SESSION_ZERO,
    };
    const out = renderView(view, FLOWTIME_PRESET);
    expect(out.dataPhase).toBe("running");
    expect(out.timeText).toBe("");
    expect(out.label).toBe("Flowtime");
  });

  it("builds metaText from the given preset's break structure", () => {
    const view: TimerView = {
      phase: "idle",
      progress: 0,
      remainingMs: 0,
      overflowMs: 0,
      cyclePos: { focus: 0, total: 0 },
      ...SESSION_ZERO,
    };
    const out = renderView(view, POMODORO_PRESET);
    expect(out.metaText).toBe("25 focus · 5 break · long 20 every 4");
  });

  it("builds a collapsed metaCompactText with just focus/break", () => {
    const view: TimerView = {
      phase: "idle",
      progress: 0,
      remainingMs: 0,
      overflowMs: 0,
      cyclePos: { focus: 0, total: 0 },
      ...SESSION_ZERO,
    };
    const out = renderView(view, POMODORO_PRESET);
    expect(out.metaCompactText).toBe("25 · 5");
  });

  it("drops the break and long-every clauses for a no-break preset", () => {
    const view: TimerView = {
      phase: "idle",
      progress: 0,
      remainingMs: 0,
      overflowMs: 0,
      cyclePos: { focus: 0, total: 1 },
      ...SESSION_ZERO,
    };
    const out = renderView(view, FLOWTIME_PRESET);
    expect(out.metaText).toBe("0 focus");
    expect(out.metaCompactText).toBe("0");
  });

  it("drops only the long-every clause for a preset with breaks but no long break", () => {
    const preset: TimerPreset = {
      id: "deep_work",
      label: "Deep Work",
      focusMin: 90,
      breakMin: 5,
      longBreakMin: 0,
      cyclesBeforeLong: 1,
    };
    const view: TimerView = {
      phase: "idle",
      progress: 0,
      remainingMs: 0,
      overflowMs: 0,
      cyclePos: { focus: 0, total: 1 },
      ...SESSION_ZERO,
    };
    const out = renderView(view, preset);
    expect(out.metaText).toBe("90 focus · 5 break");
    expect(out.metaCompactText).toBe("90 · 5");
  });
});

describe("accumulatePause", () => {
  it("accumulates the paused span when resuming into running", () => {
    const state = { blockPausedMs: 0, pauseStartedAtMs: 1_000 };
    const next = accumulatePause(state, "paused", "running", 6_000);
    expect(next).toEqual({ blockPausedMs: 5_000, pauseStartedAtMs: null });
  });

  it("accumulates the paused span when resuming into overflow", () => {
    const state = { blockPausedMs: 0, pauseStartedAtMs: 1_000 };
    const next = accumulatePause(state, "paused", "overflow", 4_500);
    expect(next).toEqual({ blockPausedMs: 3_500, pauseStartedAtMs: null });
  });

  it("accumulates the paused span when resuming straight into break", () => {
    const state = { blockPausedMs: 0, pauseStartedAtMs: 2_000 };
    const next = accumulatePause(state, "paused", "break", 9_000);
    expect(next).toEqual({ blockPausedMs: 7_000, pauseStartedAtMs: null });
  });

  it("sums two separate pause/resume cycles", () => {
    let state: { blockPausedMs: number; pauseStartedAtMs: number | null } = {
      blockPausedMs: 0,
      pauseStartedAtMs: 1_000,
    };
    state = accumulatePause(state, "paused", "running", 3_000);
    expect(state).toEqual({ blockPausedMs: 2_000, pauseStartedAtMs: null });

    state = { ...state, pauseStartedAtMs: 10_000 };
    state = accumulatePause(state, "paused", "overflow", 10_800);
    expect(state).toEqual({ blockPausedMs: 2_800, pauseStartedAtMs: null });
  });

  it("leaves state untouched when the transition stays inside paused", () => {
    const state = { blockPausedMs: 100, pauseStartedAtMs: 1_000 };
    const next = accumulatePause(state, "paused", "paused", 5_000);
    expect(next).toBe(state);
  });

  it("leaves state untouched when the previous phase was not paused", () => {
    const state = { blockPausedMs: 100, pauseStartedAtMs: null };
    const next = accumulatePause(state, "running", "overflow", 5_000);
    expect(next).toBe(state);
  });

  it("is a no-op when there is no active pause span to close", () => {
    const state = { blockPausedMs: 100, pauseStartedAtMs: null };
    const next = accumulatePause(state, "paused", "running", 5_000);
    expect(next).toBe(state);
  });
});

describe("isAlertBoundary", () => {
  it("fires when a focus block ends and break starts", () => {
    expect(isAlertBoundary("running", "break")).toBe(true);
  });

  it("fires when overflow finally rolls into break", () => {
    expect(isAlertBoundary("overflow", "break")).toBe(true);
  });

  it("fires when a break ends and focus resumes", () => {
    expect(isAlertBoundary("break", "running")).toBe(true);
  });

  it("stays silent on pause", () => {
    expect(isAlertBoundary("running", "paused")).toBe(false);
  });

  it("stays silent on resume", () => {
    expect(isAlertBoundary("paused", "running")).toBe(false);
  });

  it("stays silent when drifting into overflow", () => {
    expect(isAlertBoundary("running", "overflow")).toBe(false);
  });

  it("stays silent on the initial start from idle", () => {
    expect(isAlertBoundary("idle", "running")).toBe(false);
  });

  it("stays silent on reset back to idle", () => {
    expect(isAlertBoundary("running", "idle")).toBe(false);
  });

  it("stays silent when nothing actually changed", () => {
    const phases: Phase[] = ["idle", "running", "paused", "break", "overflow"];
    for (const phase of phases) {
      expect(isAlertBoundary(phase, phase)).toBe(false);
    }
  });
});

describe("FocusCell (FSM to metrics glue)", () => {
  let cell: FocusCell | undefined;
  let lastContainer: HTMLElement;

  function newCell(overrides: Partial<FocusConfig> = {}): FocusCell {
    lastContainer = document.createElement("div");
    return new FocusCell(
      "test-cell",
      lastContainer,
      cfgWith(overrides),
      "#000000",
      true,
      { projectId: "proj-1", shireiSessionId: "sess-1" },
    );
  }

  function labelText(): string | null | undefined {
    return lastContainer.querySelector(".focus-preset-name")?.textContent;
  }

  function timeText(): string | null | undefined {
    return lastContainer.querySelector(".focus-time")?.textContent;
  }

  afterEach(async () => {
    cell?.dispose();
    cell = undefined;
    // dispose() chains one more "abandoned" end onto logChain; let it fully
    // drain past a macrotask boundary before the next test clears the mocks,
    // or its call would otherwise bleed into whichever test runs next.
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.clearAllMocks();
  });

  it("applies a preset switch immediately while idle", () => {
    cell = newCell();
    cell.setPreset("flowtime");
    expect(cell.activePreset().id).toBe("flowtime");
    expect(cell.presetId).toBe("flowtime");
    expect(labelText()).toBe("Flowtime");
    expect(timeText()).toBe("0:00");
  });

  it("falls back to the first configured preset when default_preset is invalid", () => {
    cell = newCell({ default_preset: "missing" });
    expect(cell.activePreset().id).toBe("pomodoro");
  });

  it("ignores a preset id absent from the config", () => {
    cell = newCell();
    cell.setPreset("does-not-exist");
    expect(cell.activePreset().id).toBe("pomodoro");
  });

  it("stages a preset switch while running instead of touching the machine", () => {
    cell = newCell();
    cell.toggleStart();
    const plannedBefore = cell.activePreset().focusMin;

    cell.setPreset("flowtime");

    expect(cell.activePreset().id).toBe("pomodoro");
    expect(cell.activePreset().focusMin).toBe(plannedBefore);
    expect(cell.presetId).toBe("pomodoro");
    expect(labelText()).toBe("Flowtime");
  });

  it("stages a preset switch while paused instead of touching the machine", () => {
    cell = newCell();
    cell.toggleStart();
    cell.toggleStart();

    cell.setPreset("flowtime");

    expect(cell.activePreset().id).toBe("pomodoro");
    expect(labelText()).toBe("Flowtime");
  });

  it("commits a staged preset switch on reset", () => {
    cell = newCell();
    cell.toggleStart();
    cell.setPreset("flowtime");

    cell.reset();

    expect(cell.activePreset().id).toBe("flowtime");
    expect(cell.presetId).toBe("flowtime");
    expect(labelText()).toBe("Flowtime");
  });

  it("starting again after a reset-commit is a no-op on the already-committed preset", () => {
    cell = newCell();
    cell.toggleStart();
    cell.setPreset("flowtime");
    cell.reset();

    cell.toggleStart();

    expect(cell.activePreset().id).toBe("flowtime");
  });

  it("flows focusMinOverride into activePreset, and clears it back to the preset's own value", () => {
    cell = newCell();
    cell.setFocusMinOverride(40);
    expect(cell.activePreset().focusMin).toBe(40);

    cell.setFocusMinOverride(null);
    expect(cell.activePreset().focusMin).toBe(25);
  });

  it("applies a focus override immediately while idle", () => {
    cell = newCell();
    cell.setFocusMinOverride(40);

    expect(cell.activePreset().focusMin).toBe(40);
    expect(timeText()).toBe("40:00");
  });

  it("stages a focus override while running instead of touching the machine", () => {
    cell = newCell();
    cell.toggleStart();

    cell.setFocusMinOverride(40);

    expect(cell.activePreset().focusMin).toBe(25);
    expect(labelText()).toBe("Pomodoro");
  });

  it("clears a committed focus override on reset instead of carrying it forward", () => {
    cell = newCell();
    cell.setFocusMinOverride(40);
    expect(cell.activePreset().focusMin).toBe(40);

    cell.reset();

    expect(cell.activePreset().focusMin).toBe(25);
  });

  it("clears a staged focus override on reset rather than committing it", () => {
    cell = newCell();
    cell.toggleStart();
    cell.setFocusMinOverride(40);

    cell.reset();

    expect(cell.activePreset().focusMin).toBe(25);
    expect(timeText()).toBe("25:00");
  });

  it("builds a fixed RHYTHM_TARGET pip row (4 cycle + 3 break pips), independent of the preset's own cycle count", () => {
    cell = newCell();
    cell.toggleStart();
    let cyclePipsEls = lastContainer.querySelectorAll<HTMLElement>(
      '.pip[data-kind="cycle"]',
    );
    let breakPipsEls = lastContainer.querySelectorAll<HTMLElement>(
      '.pip[data-kind="break"]',
    );
    expect(cyclePipsEls).toHaveLength(4);
    expect(breakPipsEls).toHaveLength(3);

    cell.reset();
    cell.setPreset("deep_work");
    cell.toggleStart();
    cyclePipsEls = lastContainer.querySelectorAll<HTMLElement>(
      '.pip[data-kind="cycle"]',
    );
    breakPipsEls = lastContainer.querySelectorAll<HTMLElement>(
      '.pip[data-kind="break"]',
    );
    expect(cyclePipsEls).toHaveLength(4);
    expect(breakPipsEls).toHaveLength(3);
  });

  it("tracks a focus -> break -> focus cycle across pip data-state (done/current/pending)", () => {
    cell = newCell();
    cell.setPreset("deep_work");
    cell.toggleStart();
    const cyclePipsEls = () =>
      lastContainer.querySelectorAll<HTMLElement>('.pip[data-kind="cycle"]');
    const breakPipsEls = () =>
      lastContainer.querySelectorAll<HTMLElement>('.pip[data-kind="break"]');

    expect(cyclePipsEls()[0].dataset.state).toBe("current");
    expect(breakPipsEls()[0].dataset.state).toBe("pending");

    cell.skip();
    expect(cyclePipsEls()[0].dataset.state).toBe("done");
    expect(cyclePipsEls()[1].dataset.state).toBe("pending");
    expect(breakPipsEls()[0].dataset.state).toBe("current");

    cell.skip();
    expect(cyclePipsEls()[0].dataset.state).toBe("done");
    expect(cyclePipsEls()[1].dataset.state).toBe("current");
    expect(breakPipsEls()[0].dataset.state).toBe("done");
    expect(breakPipsEls()[1].dataset.state).toBe("pending");
  });

  it("caps filled cycle pips at RHYTHM_TARGET while the tally carries the true count past it", () => {
    cell = newCell();
    cell.setPreset("deep_work");
    cell.toggleStart();
    for (let i = 0; i < 5; i++) {
      cell.skip();
      cell.skip();
    }
    const cyclePipsEls = lastContainer.querySelectorAll<HTMLElement>(
      '.pip[data-kind="cycle"]',
    );
    expect(cyclePipsEls).toHaveLength(4);
    for (const pip of cyclePipsEls) {
      expect(pip.dataset.state).toBe("done");
    }
    const tally = lastContainer.querySelector(".focus-tally");
    expect(tally?.querySelector("b")?.textContent).toBe("5");
    expect(tally?.textContent).toContain("cycles");
  });

  it("fires the settle animation only on the pip of a newly completed cycle", () => {
    cell = newCell();
    cell.setPreset("deep_work");
    cell.toggleStart();
    const cyclePipsEls = () =>
      lastContainer.querySelectorAll<HTMLElement>('.pip[data-kind="cycle"]');
    const breakPipsEls = () =>
      lastContainer.querySelectorAll<HTMLElement>('.pip[data-kind="break"]');

    cell.skip();
    expect(cyclePipsEls()[0].classList.contains("is-filling")).toBe(true);
    expect(cyclePipsEls()[0].dataset.final).toBe("false");
    expect(breakPipsEls()[0].classList.contains("is-filling")).toBe(false);

    cyclePipsEls()[0].classList.remove("is-filling");
    cell.skip();
    expect(cyclePipsEls()[0].classList.contains("is-filling")).toBe(false);
    expect(cyclePipsEls()[1].classList.contains("is-filling")).toBe(false);
  });

  it("shows the tally and hides the meta line once at least one cycle has completed", () => {
    cell = newCell();
    cell.setPreset("deep_work");
    cell.toggleStart();
    const tally = () =>
      lastContainer.querySelector<HTMLElement>(".focus-tally");
    const meta = () => lastContainer.querySelector<HTMLElement>(".focus-meta");
    expect(tally()?.style.display).toBe("none");
    expect(meta()?.style.display).not.toBe("none");

    cell.skip();
    expect(tally()?.style.display).not.toBe("none");
    expect(meta()?.style.display).toBe("none");
    expect(tally()?.textContent).toContain("cycle");
    expect(tally()?.textContent).toContain("focus");
  });

  it("resolves label and idle planned time from the active preset, not cfg.default_preset", () => {
    cell = newCell();
    expect(cell.activePreset().id).not.toBe("flowtime");

    cell.setPreset("flowtime");

    expect(labelText()).toBe("Flowtime");
    expect(timeText()).toBe("0:00");
  });

  it("logs a start event as soon as an idle timer is toggled on", async () => {
    cell = newCell();
    cell.toggleStart();

    await vi.waitFor(() =>
      expect(commands.focusSessionStart).toHaveBeenCalledTimes(1),
    );
    const [payload] = vi.mocked(commands.focusSessionStart).mock.calls[0];
    expect(payload.phase).toBe("focus");
    expect(payload.method).toBe("pomodoro");
    expect(payload.projectId).toBe("proj-1");
    expect(commands.focusSessionEnd).not.toHaveBeenCalled();
  });

  it("logs an end event with status skipped when a running block is skipped", async () => {
    cell = newCell();
    cell.toggleStart();
    cell.skip();

    await vi.waitFor(() =>
      expect(commands.focusSessionEnd).toHaveBeenCalledTimes(1),
    );
    const [, end] = vi.mocked(commands.focusSessionEnd).mock.calls[0];
    expect(end.status).toBe("skipped");
  });

  it("logs an end event with status abandoned on reset", async () => {
    cell = newCell();
    cell.toggleStart();
    cell.reset();

    await vi.waitFor(() =>
      expect(commands.focusSessionEnd).toHaveBeenCalledTimes(1),
    );
    const [, end] = vi.mocked(commands.focusSessionEnd).mock.calls[0];
    expect(end.status).toBe("abandoned");
  });

  it("logs a pause update while running, then resumes without re-emitting start", async () => {
    cell = newCell();
    cell.toggleStart();
    await vi.waitFor(() =>
      expect(commands.focusSessionStart).toHaveBeenCalledTimes(1),
    );

    cell.toggleStart();
    await vi.waitFor(() =>
      expect(commands.focusSessionUpdate).toHaveBeenCalledTimes(1),
    );
    const [, pausePatch] = vi.mocked(commands.focusSessionUpdate).mock.calls[0];
    expect(pausePatch.pauseCount).toBe(1);

    cell.toggleStart();
    await vi.waitFor(() =>
      expect(commands.focusSessionUpdate).toHaveBeenCalledTimes(2),
    );
    expect(commands.focusSessionStart).toHaveBeenCalledTimes(1);
  });

  it("does not emit a phantom log entry when pausing and resuming during a break", async () => {
    cell = newCell();
    cell.toggleStart();
    cell.skip();
    await vi.waitFor(() =>
      expect(commands.focusSessionEnd).toHaveBeenCalledTimes(1),
    );

    cell.toggleStart(); // break -> paused: no tracked session, must stay silent
    cell.toggleStart(); // paused -> break resume edge: must stay silent too
    await Promise.resolve();

    expect(commands.focusSessionStart).toHaveBeenCalledTimes(1);
    expect(commands.focusSessionUpdate).not.toHaveBeenCalled();
    expect(commands.focusSessionEnd).toHaveBeenCalledTimes(1);
  });

  it("keeps start ahead of end even when the start call resolves slowly", async () => {
    let releaseStart: () => void = () => {};
    vi.mocked(commands.focusSessionStart).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseStart = resolve;
        }),
    );

    cell = newCell();
    cell.toggleStart(); // fires the slow start
    cell.skip(); // fires the end right behind it, unawaited at the call site

    await vi.waitFor(() =>
      expect(commands.focusSessionStart).toHaveBeenCalledTimes(1),
    );
    // The start call landed, but its promise is still pending: the chained
    // end must not have fired yet, however long it sits behind it.
    expect(commands.focusSessionEnd).not.toHaveBeenCalled();

    releaseStart();
    await vi.waitFor(() =>
      expect(commands.focusSessionEnd).toHaveBeenCalledTimes(1),
    );
  });

  it("never logs when metrics are disabled", async () => {
    cell = new FocusCell(
      "test-cell-no-metrics",
      document.createElement("div"),
      cfgWith(),
      "#000000",
      false,
    );
    cell.toggleStart();
    cell.skip();
    await Promise.resolve();

    expect(commands.focusSessionStart).not.toHaveBeenCalled();
    expect(commands.focusSessionEnd).not.toHaveBeenCalled();
  });
});

describe("FocusCell shape strategy", () => {
  let cell: FocusCell | undefined;
  let lastContainer: HTMLElement;

  function newCell(overrides: Partial<FocusConfig> = {}): FocusCell {
    lastContainer = document.createElement("div");
    return new FocusCell(
      "test-cell-shape",
      lastContainer,
      cfgWith(overrides),
      "#000000",
      false,
    );
  }

  afterEach(() => {
    cell?.dispose();
    cell = undefined;
  });

  it("sets data-shape on the container from the default ring config", () => {
    cell = newCell();
    expect(lastContainer.dataset.shape).toBe("ring");
  });

  it("builds a ring wrap with the core nested inside for center placement", () => {
    cell = newCell();
    const ringWrap = lastContainer.querySelector(".focus-ring-wrap");
    const core = lastContainer.querySelector(".focus-core");
    expect(ringWrap).not.toBeNull();
    expect(core).not.toBeNull();
    expect(core?.parentElement).toBe(ringWrap);
    expect(ringWrap?.querySelector(".focus-ring")).not.toBeNull();
    expect(ringWrap?.querySelector(".focus-glow")).not.toBeNull();
  });

  it("falls through an unknown shape value to a center-placed ring", () => {
    cell = newCell({ timer_shape: "unknown" });
    expect(lastContainer.dataset.shape).toBe("unknown");
    const ringWrap = lastContainer.querySelector(".focus-ring-wrap");
    const core = lastContainer.querySelector(".focus-core");
    expect(ringWrap).not.toBeNull();
    expect(core?.parentElement).toBe(ringWrap);
  });

  it("rebuilds the viz on a live shape change without resetting the running machine", () => {
    cell = newCell();
    cell.toggleStart();
    const focusMinBefore = cell.activePreset().focusMin;
    const phaseBefore = lastContainer.dataset.phase;

    cell.setConfig(cfgWith({ timer_shape: "bar" }), "#000000", false);

    expect(lastContainer.dataset.shape).toBe("bar");
    expect(cell.activePreset().focusMin).toBe(focusMinBefore);
    expect(lastContainer.dataset.phase).toBe(phaseBefore);
    expect(lastContainer.querySelector(".focus-ring-wrap")).toBeNull();
    const wrap = lastContainer.querySelector(".focus-bar-wrap");
    const core = lastContainer.querySelector(".focus-core");
    expect(core?.parentElement).toBe(
      lastContainer.querySelector(".focus-body"),
    );
    expect(core?.parentElement).not.toBe(wrap);
  });

  it("is a no-op rebuild when setConfig keeps the same shape", () => {
    cell = newCell();
    const ringWrapBefore = lastContainer.querySelector(".focus-ring-wrap");

    cell.setConfig(cfgWith(), "#000000", false);

    expect(lastContainer.querySelector(".focus-ring-wrap")).toBe(
      ringWrapBefore,
    );
  });

  it("builds a liquid viz with the fill element + meniscus and the number centered", () => {
    cell = newCell({ timer_shape: "liquid" });
    const wrap = lastContainer.querySelector(".focus-liquid-wrap");
    const clip = lastContainer.querySelector(".focus-liquid-clip");
    const fill = lastContainer.querySelector(".focus-liquid-fill");
    const meniscus = lastContainer.querySelector(".focus-liquid-meniscus");
    const core = lastContainer.querySelector(".focus-core");
    expect(lastContainer.dataset.shape).toBe("liquid");
    expect(wrap).not.toBeNull();
    expect(fill?.parentElement).toBe(clip);
    expect(meniscus?.parentElement).toBe(fill);
    expect(core?.parentElement).toBe(wrap);
  });

  it("lands --timer-progress on the liquid fill element, not the clip or wrap", () => {
    cell = newCell({ timer_shape: "liquid" });
    const clip = lastContainer.querySelector<HTMLElement>(".focus-liquid-clip");
    const fill = lastContainer.querySelector<HTMLElement>(".focus-liquid-fill");
    expect(fill?.style.getPropertyValue("--timer-progress")).not.toBe("");
    expect(clip?.style.getPropertyValue("--timer-progress")).toBe("");
  });

  it("builds the coffee mug variant with the same liquid fill engine and the number centered", () => {
    cell = newCell({ timer_shape: "coffee" });
    const wrap = lastContainer.querySelector(".focus-coffee-wrap");
    const cup = lastContainer.querySelector(".focus-coffee-cup");
    const handle = lastContainer.querySelector(".focus-coffee-handle");
    const fill = lastContainer.querySelector(".focus-liquid-fill");
    const meniscus = lastContainer.querySelector(".focus-liquid-meniscus");
    const core = lastContainer.querySelector(".focus-core");
    expect(lastContainer.dataset.shape).toBe("coffee");
    expect(wrap).not.toBeNull();
    expect(cup).not.toBeNull();
    expect(handle).not.toBeNull();
    expect(fill?.parentElement).toBe(cup);
    expect(meniscus?.parentElement).toBe(fill);
    expect(core?.parentElement).toBe(wrap);
  });

  it("builds the coffee steam as a wrap sibling with --timer-progress mirrored onto it", () => {
    cell = newCell({ timer_shape: "coffee" });
    const wrap = lastContainer.querySelector(".focus-coffee-wrap");
    const cup = lastContainer.querySelector(".focus-coffee-cup");
    const steam = lastContainer.querySelector<HTMLElement>(
      ".focus-coffee-steam",
    );
    const wisps = lastContainer.querySelectorAll(".focus-coffee-wisp");
    const fill = lastContainer.querySelector<HTMLElement>(".focus-liquid-fill");
    expect(steam?.parentElement).toBe(wrap);
    expect(cup?.contains(steam)).toBe(false);
    expect(wisps).toHaveLength(3);
    expect(steam?.style.getPropertyValue("--timer-progress")).not.toBe("");
    expect(steam?.style.getPropertyValue("--timer-progress")).toBe(
      fill?.style.getPropertyValue("--timer-progress"),
    );
  });

  it("never sets a progress mirror for shapes other than coffee", () => {
    cell = newCell({ timer_shape: "liquid" });
    expect(lastContainer.querySelector(".focus-coffee-steam")).toBeNull();
  });

  it("keeps the ring path untouched when liquid/coffee shapes exist", () => {
    cell = newCell();
    expect(lastContainer.dataset.shape).toBe("ring");
    expect(lastContainer.querySelector(".focus-liquid-wrap")).toBeNull();
    expect(lastContainer.querySelector(".focus-coffee-wrap")).toBeNull();
    const ringWrap = lastContainer.querySelector(".focus-ring-wrap");
    const core = lastContainer.querySelector(".focus-core");
    expect(ringWrap).not.toBeNull();
    expect(core?.parentElement).toBe(ringWrap);
  });

  it("builds an hourglass viz with the number below, not nested in the viz", () => {
    cell = newCell({ timer_shape: "hourglass" });
    const wrap = lastContainer.querySelector(".focus-hourglass-wrap");
    const body = lastContainer.querySelector(".focus-body");
    const core = lastContainer.querySelector(".focus-core");
    expect(lastContainer.dataset.shape).toBe("hourglass");
    expect(wrap).not.toBeNull();
    expect(core?.parentElement).toBe(body);
    expect(wrap?.contains(core)).toBe(false);
    const children = Array.from(body?.children ?? []);
    expect(children.indexOf(wrap as Element)).toBeLessThan(
      children.indexOf(core as Element),
    );
  });

  it("clips each hourglass bulb's sand with an SVG clipPath and never sets transform-origin on it", () => {
    cell = newCell({ timer_shape: "hourglass" });
    const coverTop = lastContainer.querySelector<SVGElement>(
      ".focus-hourglass-cover-top",
    );
    const coverBottom = lastContainer.querySelector<SVGElement>(
      ".focus-hourglass-cover-bottom",
    );
    const clipPaths = lastContainer.querySelectorAll("clipPath");
    expect(clipPaths.length).toBe(2);
    expect(coverTop?.getAttribute("clip-path")).toMatch(/^url\(#/);
    expect(coverBottom?.getAttribute("clip-path")).toMatch(/^url\(#/);
    expect(coverTop?.getAttribute("clip-path")).not.toBe(
      coverBottom?.getAttribute("clip-path"),
    );
    expect(coverTop?.style.getPropertyValue("transform-origin")).toBe("");
    expect(coverBottom?.style.getPropertyValue("transform-origin")).toBe("");
  });

  it("lands --timer-progress on the hourglass's shared progress group, not the covers themselves", () => {
    cell = newCell({ timer_shape: "hourglass" });
    const progressGroup = lastContainer.querySelector<SVGElement>(
      ".focus-hourglass-progress",
    );
    const coverTop = lastContainer.querySelector<SVGElement>(
      ".focus-hourglass-cover-top",
    );
    expect(progressGroup?.style.getPropertyValue("--timer-progress")).not.toBe(
      "",
    );
    expect(coverTop?.style.getPropertyValue("--timer-progress")).toBe("");
  });

  // Regression for the inherit-chain bug: --timer-progress is inherits:false,
  // so `inherit` on a cover only resolves off its IMMEDIATE parent. Both
  // covers (and their sand) must be direct children of the progress group
  // that carries the live value, with no intermediate <g> wrapper in between,
  // or the value would stay stuck at the CSS-initial 0 forever.
  it("keeps both hourglass covers as direct children of the live progress group", () => {
    cell = newCell({ timer_shape: "hourglass" });
    const progressGroup = lastContainer.querySelector<SVGElement>(
      ".focus-hourglass-progress",
    );
    const coverTop = lastContainer.querySelector<SVGElement>(
      ".focus-hourglass-cover-top",
    );
    const coverBottom = lastContainer.querySelector<SVGElement>(
      ".focus-hourglass-cover-bottom",
    );
    expect(coverTop?.parentElement).toBe(progressGroup);
    expect(coverBottom?.parentElement).toBe(progressGroup);
  });

  it("builds a bar viz with a scaleY fill and the number below, not nested in the viz", () => {
    cell = newCell({ timer_shape: "bar" });
    const wrap = lastContainer.querySelector(".focus-bar-wrap");
    const fill = lastContainer.querySelector<HTMLElement>(".focus-bar-fill");
    const body = lastContainer.querySelector(".focus-body");
    const core = lastContainer.querySelector(".focus-core");
    expect(lastContainer.dataset.shape).toBe("bar");
    expect(wrap).not.toBeNull();
    expect(fill?.parentElement).toBe(wrap);
    expect(core?.parentElement).toBe(body);
    expect(wrap?.contains(core)).toBe(false);
  });

  it("lands --timer-progress on the bar fill element, not the wrap", () => {
    cell = newCell({ timer_shape: "bar" });
    const wrap = lastContainer.querySelector<HTMLElement>(".focus-bar-wrap");
    const fill = lastContainer.querySelector<HTMLElement>(".focus-bar-fill");
    expect(fill?.style.getPropertyValue("--timer-progress")).not.toBe("");
    expect(wrap?.style.getPropertyValue("--timer-progress")).toBe("");
  });
});

describe("FocusCell auto_advance sourced from the active preset", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves autoAdvance from the active preset, not a global flag", () => {
    const cell = new FocusCell(
      "test-auto-advance-resolve",
      document.createElement("div"),
      cfgWith(),
      "#000000",
      false,
    );
    expect(cell.activePreset().autoAdvance).toBe(true);

    cell.setPreset("flowtime");
    expect(cell.activePreset().autoAdvance).toBe(false);

    cell.dispose();
  });

  it("keeps running on the current preset's autoAdvance while a switch is staged", () => {
    const cell = new FocusCell(
      "test-auto-advance-staged",
      document.createElement("div"),
      cfgWith(),
      "#000000",
      false,
    );
    cell.toggleStart();
    cell.setPreset("flowtime");
    expect(cell.activePreset().autoAdvance).toBe(true);

    cell.reset();
    expect(cell.activePreset().autoAdvance).toBe(false);

    cell.dispose();
  });

  it("flows focus straight into break, then back into focus, when the preset's auto_advance is true", () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    const cell = new FocusCell(
      "test-auto-advance-flow",
      container,
      cfgWith(),
      "#000000",
      false,
    );
    cell.toggleStart();

    vi.advanceTimersByTime(25 * 60_000 + 500);
    expect(container.dataset.phase).toBe("break");

    vi.advanceTimersByTime(5 * 60_000 + 500);
    expect(container.dataset.phase).toBe("running");

    cell.dispose();
  });

  it("stays in overflow past the planned duration when the preset's auto_advance is false", () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    const cell = new FocusCell(
      "test-no-auto-advance-overflow",
      container,
      cfgWith(),
      "#000000",
      false,
    );
    cell.setPreset("deep_work");
    cell.toggleStart();

    vi.advanceTimersByTime(10 * 60_000 + 5_000);
    expect(container.dataset.phase).toBe("overflow");

    cell.dispose();
  });

  it("sources the newly-committed staged preset's auto_advance on the next start", () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    const cell = new FocusCell(
      "test-auto-advance-staged-flow",
      container,
      cfgWith(),
      "#000000",
      false,
    );
    cell.toggleStart();
    cell.setPreset("deep_work");
    cell.reset();

    cell.toggleStart();
    vi.advanceTimersByTime(10 * 60_000 + 5_000);
    expect(container.dataset.phase).toBe("overflow");

    cell.dispose();
  });
});

describe("FocusCell session naming", () => {
  let cell: FocusCell | undefined;
  let lastContainer: HTMLElement;

  function newCell(overrides: Partial<FocusConfig> = {}): FocusCell {
    lastContainer = document.createElement("div");
    return new FocusCell(
      "test-cell-naming",
      lastContainer,
      cfgWith(overrides),
      "#000000",
      true,
      { projectId: "proj-1", shireiSessionId: "sess-1" },
    );
  }

  function mustFind<T extends Element>(selector: string): T {
    const el = lastContainer.querySelector<T>(selector);
    if (!el) throw new Error(`missing ${selector}`);
    return el;
  }

  function editBtn(): HTMLButtonElement {
    return mustFind(".focus-edit");
  }

  function nameEl(): HTMLElement {
    return mustFind(".focus-name");
  }

  function nameInput(): HTMLInputElement {
    return mustFind(".focus-name-input");
  }

  afterEach(async () => {
    cell?.dispose();
    cell = undefined;
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.clearAllMocks();
  });

  it("starts hidden with no name shown", () => {
    cell = newCell();
    expect(nameEl().hidden).toBe(true);
    expect(nameInput().hidden).toBe(true);
    expect(cell.sessionName).toBeNull();
  });

  it("reveals the input, prefilled with the current name, when the pencil is clicked", () => {
    cell = newCell();
    editBtn().click();
    expect(nameInput().hidden).toBe(false);
    expect(nameEl().hidden).toBe(true);
    expect(nameInput().value).toBe("");
  });

  it("commits the typed name on Enter, sets sessionName, and fires onRename", () => {
    cell = newCell();
    const onRename = vi.fn();
    cell.onRename = onRename;

    editBtn().click();
    nameInput().value = "Refactor auth flow";
    nameInput().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );

    expect(cell.sessionName).toBe("Refactor auth flow");
    expect(onRename).toHaveBeenCalledWith("Refactor auth flow");
    expect(nameInput().hidden).toBe(true);
    expect(nameEl().hidden).toBe(false);
    expect(nameEl().textContent).toBe("Refactor auth flow");
  });

  it("commits on blur the same as Enter", () => {
    cell = newCell();
    const onRename = vi.fn();
    cell.onRename = onRename;

    editBtn().click();
    nameInput().value = "Deep work block";
    nameInput().dispatchEvent(new Event("blur"));

    expect(cell.sessionName).toBe("Deep work block");
    expect(onRename).toHaveBeenCalledWith("Deep work block");
  });

  it("discards the edit on Escape, leaving the previous name untouched", () => {
    cell = newCell();
    editBtn().click();
    nameInput().value = "Refactor auth flow";
    nameInput().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );

    const onRename = vi.fn();
    cell.onRename = onRename;
    editBtn().click();
    nameInput().value = "Something else entirely";
    nameInput().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );

    expect(cell.sessionName).toBe("Refactor auth flow");
    expect(onRename).not.toHaveBeenCalled();
    expect(nameInput().hidden).toBe(true);
    expect(nameEl().hidden).toBe(false);
    expect(nameEl().textContent).toBe("Refactor auth flow");
  });

  it("clears the name and hides the display when committed empty", () => {
    cell = newCell();
    editBtn().click();
    nameInput().value = "Temporary";
    nameInput().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );

    const onRename = vi.fn();
    cell.onRename = onRename;
    editBtn().click();
    nameInput().value = "   ";
    nameInput().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );

    expect(cell.sessionName).toBeNull();
    expect(onRename).toHaveBeenCalledWith(null);
    expect(nameEl().hidden).toBe(true);
  });

  it("restoreName hydrates the display without firing onRename", () => {
    cell = newCell();
    const onRename = vi.fn();
    cell.onRename = onRename;

    cell.restoreName("Standup prep");

    expect(cell.sessionName).toBe("Standup prep");
    expect(nameEl().hidden).toBe(false);
    expect(nameEl().textContent).toBe("Standup prep");
    expect(onRename).not.toHaveBeenCalled();
  });

  it("carries the session name as the note on a completed focus block", async () => {
    cell = newCell();
    cell.restoreName("Refactor auth flow");
    cell.toggleStart();
    cell.skip();

    await vi.waitFor(() =>
      expect(commands.focusSessionEnd).toHaveBeenCalledTimes(1),
    );
    const [, end] = vi.mocked(commands.focusSessionEnd).mock.calls[0];
    expect(end.note).toBe("Refactor auth flow");
  });

  it("stores the name even when session_note is off, since it's a deliberate action, not the reflection prompt", async () => {
    cell = newCell({ session_note: false });
    cell.restoreName("Deep work block");
    cell.toggleStart();
    cell.skip();

    await vi.waitFor(() =>
      expect(commands.focusSessionEnd).toHaveBeenCalledTimes(1),
    );
    const [, end] = vi.mocked(commands.focusSessionEnd).mock.calls[0];
    expect(end.note).toBe("Deep work block");
  });

  it("omits the note entirely when the session was never named", async () => {
    cell = newCell();
    cell.toggleStart();
    cell.skip();

    await vi.waitFor(() =>
      expect(commands.focusSessionEnd).toHaveBeenCalledTimes(1),
    );
    const [, end] = vi.mocked(commands.focusSessionEnd).mock.calls[0];
    expect(end.note).toBeUndefined();
  });
});

describe("FocusCell shortcut discoverability", () => {
  const SHORTCUTS = {
    toggle: "⌘⌃␣",
    skip: "⌘⌃S",
    reset: "⌘⌃0",
    panel: "⌘⌃E",
  };

  afterEach(() => {
    document.body.replaceChildren();
  });

  function controlButtons(container: HTMLElement): HTMLButtonElement[] {
    return Array.from(
      container.querySelectorAll<HTMLButtonElement>(".focus-btn"),
    );
  }

  it("appends the resolved binding to each control's title and aria-label", () => {
    const container = document.createElement("div");
    const cell = new FocusCell(
      "test-shortcuts-controls",
      container,
      cfgWith(),
      "#000000",
      false,
      {},
      SHORTCUTS,
    );
    const [toggle, skip, reset] = controlButtons(container);
    const preset = container.querySelector<HTMLButtonElement>(".focus-preset");

    expect(toggle.title).toBe("Start (⌘⌃␣)");
    expect(skip.title).toBe("Skip (⌘⌃S)");
    expect(skip.getAttribute("aria-label")).toBe("Skip (⌘⌃S)");
    expect(reset.title).toBe("Reset (⌘⌃0)");
    expect(preset?.title).toBe("Open focus panel (⌘⌃E)");

    cell.dispose();
  });

  it("falls back to the plain label when a binding was cleared in the keymap", () => {
    const container = document.createElement("div");
    const cell = new FocusCell(
      "test-shortcuts-none",
      container,
      cfgWith(),
      "#000000",
      false,
    );
    const [toggle, skip, reset] = controlButtons(container);
    const preset = container.querySelector<HTMLButtonElement>(".focus-preset");

    expect(toggle.title).toBe("Start");
    expect(skip.title).toBe("Skip");
    expect(reset.title).toBe("Reset");
    expect(preset?.title).toBe("Open focus panel");

    cell.dispose();
  });

  it("refreshes every control's tooltip when setConfig delivers a rebound keymap", () => {
    const container = document.createElement("div");
    const cell = new FocusCell(
      "test-shortcuts-rebind",
      container,
      cfgWith(),
      "#000000",
      false,
      {},
      SHORTCUTS,
    );

    cell.setConfig(cfgWith(), "#000000", false, {
      toggle: "",
      skip: "⌘⌃X",
      reset: "",
      panel: "",
    });

    const [toggle, skip, reset] = controlButtons(container);
    const preset = container.querySelector<HTMLButtonElement>(".focus-preset");
    expect(toggle.title).toBe("Start");
    expect(skip.title).toBe("Skip (⌘⌃X)");
    expect(reset.title).toBe("Reset");
    expect(preset?.title).toBe("Open focus panel");

    cell.dispose();
  });

  it("forwards the shortcut strings into the panel's quiet key legend", () => {
    const container = document.createElement("div");
    const cell = new FocusCell(
      "test-shortcuts-panel-legend",
      container,
      cfgWith(),
      "#000000",
      false,
      {},
      SHORTCUTS,
    );

    cell.openPanel();
    const legend = document.body.querySelector(".focus-panel-legend");
    expect(legend?.textContent).toContain("⌘⌃␣");
    expect(legend?.textContent).toContain("⌘⌃S");
    expect(legend?.textContent).toContain("⌘⌃0");
    expect(legend?.textContent).toContain("⌘⌃E");

    cell.dispose();
  });

  it("hides the panel legend entirely when every binding was cleared", () => {
    const container = document.createElement("div");
    const cell = new FocusCell(
      "test-shortcuts-panel-legend-empty",
      container,
      cfgWith(),
      "#000000",
      false,
    );

    cell.openPanel();
    expect(document.body.querySelector(".focus-panel-legend")).toBeNull();

    cell.dispose();
  });
});

describe("FocusCell save-as-preset", () => {
  // openFocusPanel's own close() removes the overlay from document.body only
  // after its exit transition (or a real-timer fallback) settles, well past
  // this synchronous click — so the previous test's already-clicked button
  // can still be sitting in the document. Always grab the most recently
  // mounted one.
  function clickSaveButton(): void {
    const buttons =
      document.body.querySelectorAll<HTMLButtonElement>(".focus-panel-save");
    buttons[buttons.length - 1]?.click();
  }

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("persists the panel's staged pick and staged override, not the still-committed preset", () => {
    const cfg = cfgWith();
    const container = document.createElement("div");
    const cell = new FocusCell(
      "test-save-staged",
      container,
      cfg,
      "#000000",
      false,
    );

    cell.toggleStart();
    cell.setPreset("deep_work");
    cell.setFocusMinOverride(40);
    expect(cell.activePreset().id).toBe("pomodoro");

    cell.openPanel();
    clickSaveButton();

    const saved = cfg.presets[cfg.presets.length - 1];
    expect(saved.focus_min).toBe(40);
    expect(saved.break_min).toBe(5);
    expect(saved.long_break_min).toBe(0);
    expect(saved.cycles_before_long).toBe(1);
    expect(saved.auto_advance).toBe(false);
    expect(saved.label).toContain("Deep Work");

    cell.dispose();
  });

  it("persists the committed preset unchanged when nothing is staged", () => {
    const cfg = cfgWith();
    const container = document.createElement("div");
    const cell = new FocusCell(
      "test-save-committed",
      container,
      cfg,
      "#000000",
      false,
    );

    cell.openPanel();
    clickSaveButton();

    const saved = cfg.presets[cfg.presets.length - 1];
    expect(saved.focus_min).toBe(25);
    expect(saved.break_min).toBe(5);
    expect(saved.long_break_min).toBe(20);
    expect(saved.cycles_before_long).toBe(4);
    expect(saved.auto_advance).toBe(true);
    expect(saved.label).toContain("Pomodoro");

    cell.dispose();
  });
});
