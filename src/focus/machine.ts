export type Phase = "idle" | "running" | "paused" | "break" | "overflow";

export interface TimerPreset {
  id: string;
  label: string;
  focusMin: number;
  breakMin: number;
  longBreakMin: number;
  cyclesBeforeLong: number;
}

export interface TimerStartOptions {
  overflowEnabled: boolean;
  autoAdvance: boolean;
  overflowCapMin: number;
}

export interface TimerView {
  phase: Phase;
  progress: number;
  remainingMs: number;
  overflowMs: number;
  cyclePos: { focus: number; total: number };
  // Session-lifetime counters: never reset by the long-break group rollover
  // that `cyclePos.focus` goes through, only by start()/reset().
  cyclesCompleted: number;
  breaksCompleted: number;
  focusSeconds: number;
}

type Segment = "focus" | "break" | "long_break";

const FLOWTIME_PROGRESS_HALF_LIFE_MS = 45 * 60_000;

function saturatingProgress(elapsedMs: number): number {
  return elapsedMs / (elapsedMs + FLOWTIME_PROGRESS_HALF_LIFE_MS);
}

const IDLE_VIEW: TimerView = {
  phase: "idle",
  progress: 0,
  remainingMs: 0,
  overflowMs: 0,
  cyclePos: { focus: 0, total: 0 },
  cyclesCompleted: 0,
  breaksCompleted: 0,
  focusSeconds: 0,
};

export class TimerMachine {
  private active = false;
  private preset: TimerPreset | null = null;
  private opts: TimerStartOptions | null = null;
  private segment: Segment = "focus";
  private startedAtMs = 0;
  private pausedAccumMs = 0;
  private pauseStartedMs: number | null = null;
  private focusBlocksCompleted = 0;
  // Session-lifetime counters backing TimerView.cyclesCompleted/breaksCompleted/
  // focusSeconds — unlike focusBlocksCompleted, these never roll back to 0
  // when a long-break group closes; only start()/reset() clear them.
  private sessionCyclesCompleted = 0;
  private sessionBreaksCompleted = 0;
  private sessionFocusSeconds = 0;

  start(preset: TimerPreset, opts: TimerStartOptions, nowMs: number): void {
    this.active = true;
    this.preset = preset;
    this.opts = opts;
    this.segment = "focus";
    this.startedAtMs = nowMs;
    this.pausedAccumMs = 0;
    this.pauseStartedMs = null;
    this.focusBlocksCompleted = 0;
    this.sessionCyclesCompleted = 0;
    this.sessionBreaksCompleted = 0;
    this.sessionFocusSeconds = 0;
  }

  pause(nowMs: number): void {
    if (!this.active || this.pauseStartedMs !== null) return;
    this.pauseStartedMs = nowMs;
  }

  resume(nowMs: number): void {
    if (this.pauseStartedMs === null) return;
    this.pausedAccumMs += nowMs - this.pauseStartedMs;
    this.pauseStartedMs = null;
  }

  skip(nowMs: number): void {
    const preset = this.preset;
    if (!this.active || !preset) return;
    this.advanceSegment(nowMs, preset);
    this.pauseStartedMs = null;
  }

  reset(): void {
    this.active = false;
    this.preset = null;
    this.opts = null;
    this.segment = "focus";
    this.startedAtMs = 0;
    this.pausedAccumMs = 0;
    this.pauseStartedMs = null;
    this.focusBlocksCompleted = 0;
    this.sessionCyclesCompleted = 0;
    this.sessionBreaksCompleted = 0;
    this.sessionFocusSeconds = 0;
  }

  tick(nowMs: number): TimerView {
    const preset = this.preset;
    const opts = this.opts;
    if (!this.active || !preset || !opts) return IDLE_VIEW;

    const pauseStartedMs = this.pauseStartedMs;
    if (pauseStartedMs === null) {
      if (opts.autoAdvance) this.runAutoAdvance(nowMs, preset);
      this.runOverflowCap(nowMs, preset, opts);
    }

    // No setInterval/Date.now here: elapsed is derived from stored timestamps so a
    // backgrounded/throttled Tauri window never drifts a running timer.
    const elapsedMs =
      nowMs -
      this.startedAtMs -
      this.pausedAccumMs -
      (this.pauseStartedMs !== null ? nowMs - this.pauseStartedMs : 0);

    return this.view(elapsedMs, preset, opts);
  }

  // Auto-advance chains segment transitions from the segment's planned end
  // (not `nowMs`) so a large tick gap still lands each new segment's elapsed
  // time measured from the real boundary crossing, never losing the overshoot.
  private runAutoAdvance(nowMs: number, preset: TimerPreset): void {
    const MAX_CHAINED_ADVANCES = 1000;
    for (let i = 0; i < MAX_CHAINED_ADVANCES; i++) {
      // Only true flowtime (a focus segment with no planned duration) stays
      // parked forever; a zero-length break/long_break has nothing to wait
      // out and must be skipped through like any other completed segment.
      if (this.segment === "focus" && preset.focusMin === 0) return;
      const plannedMs = this.plannedDurationMs(preset);
      const elapsedMs = nowMs - this.startedAtMs - this.pausedAccumMs;
      if (elapsedMs < plannedMs) return;
      this.advanceSegment(
        this.startedAtMs + this.pausedAccumMs + plannedMs,
        preset,
      );
    }
  }

  // Independent of auto-advance: once a focus block has run overflowCapMin
  // minutes past its planned end, it is force-advanced exactly like a manual
  // skip. Harmless (and a no-op) when auto-advance already moved the segment
  // on, or when the segment has no planned duration to overflow in the first
  // place (flowtime).
  private runOverflowCap(
    nowMs: number,
    preset: TimerPreset,
    opts: TimerStartOptions,
  ): void {
    if (this.segment !== "focus" || preset.focusMin === 0) return;
    if (!opts.overflowEnabled) return;
    const capMs = opts.overflowCapMin * 60_000;
    if (capMs <= 0) return;
    const plannedMs = this.plannedDurationMs(preset);
    const elapsedMs = nowMs - this.startedAtMs - this.pausedAccumMs;
    const overflowMs = elapsedMs - plannedMs;
    if (overflowMs < capMs) return;
    this.advanceSegment(
      this.startedAtMs + this.pausedAccumMs + plannedMs + capMs,
      preset,
    );
  }

  private advanceSegment(boundaryMs: number, preset: TimerPreset): void {
    if (this.segment === "focus") {
      this.completeFocusBlock(boundaryMs, preset);
    } else {
      // A break/long_break "completes" the instant it hands back to focus,
      // whether that's auto-advance timing out or a manual skip — both funnel
      // through this branch, so neither path can double- or under-count.
      this.sessionBreaksCompleted += 1;
      if (this.segment === "long_break") this.focusBlocksCompleted = 0;
      this.segment = "focus";
      this.startedAtMs = boundaryMs;
      this.pausedAccumMs = 0;
    }
  }

  private completeFocusBlock(boundaryMs: number, preset: TimerPreset): void {
    const elapsedFocusMs = boundaryMs - this.startedAtMs - this.pausedAccumMs;
    this.sessionFocusSeconds += Math.round(elapsedFocusMs / 1000);
    this.sessionCyclesCompleted += 1;
    this.focusBlocksCompleted += 1;
    const cyclesBeforeLong = Math.max(1, preset.cyclesBeforeLong);
    // Only take the long break when the preset actually defines one; otherwise a
    // preset like ultradian (cyclesBeforeLong 1, longBreak 0) would land on a
    // zero-length long break, get auto-skipped, and swallow its real break.
    const useLong =
      preset.longBreakMin > 0 &&
      this.focusBlocksCompleted % cyclesBeforeLong === 0;
    this.segment = useLong ? "long_break" : "break";
    this.startedAtMs = boundaryMs;
    this.pausedAccumMs = 0;
  }

  private plannedDurationMs(preset: TimerPreset): number {
    switch (this.segment) {
      case "focus":
        return preset.focusMin * 60_000;
      case "break":
        return preset.breakMin * 60_000;
      case "long_break":
        return preset.longBreakMin * 60_000;
    }
  }

  private view(
    elapsedMs: number,
    preset: TimerPreset,
    opts: TimerStartOptions,
  ): TimerView {
    const paused = this.pauseStartedMs !== null;
    const cyclePos = {
      focus: this.focusBlocksCompleted,
      total: Math.max(1, preset.cyclesBeforeLong),
    };
    const session = {
      cyclesCompleted: this.sessionCyclesCompleted,
      breaksCompleted: this.sessionBreaksCompleted,
      focusSeconds: this.sessionFocusSeconds,
    };
    const runningPhase: Phase = this.segment === "focus" ? "running" : "break";

    if (this.segment === "focus" && preset.focusMin === 0) {
      return {
        phase: paused ? "paused" : "running",
        progress: saturatingProgress(elapsedMs),
        remainingMs: 0,
        overflowMs: 0,
        cyclePos,
        ...session,
      };
    }

    const plannedMs = this.plannedDurationMs(preset);
    if (plannedMs === 0) {
      return {
        phase: paused ? "paused" : runningPhase,
        progress: 1,
        remainingMs: 0,
        overflowMs: 0,
        cyclePos,
        ...session,
      };
    }

    if (elapsedMs < plannedMs) {
      return {
        phase: paused ? "paused" : runningPhase,
        progress: elapsedMs / plannedMs,
        remainingMs: plannedMs - elapsedMs,
        overflowMs: 0,
        cyclePos,
        ...session,
      };
    }

    if (this.segment === "focus" && opts.overflowEnabled && !opts.autoAdvance) {
      return {
        phase: paused ? "paused" : "overflow",
        progress: elapsedMs / plannedMs,
        remainingMs: 0,
        overflowMs: elapsedMs - plannedMs,
        cyclePos,
        ...session,
      };
    }

    return {
      phase: paused ? "paused" : runningPhase,
      progress: Math.max(1, elapsedMs / plannedMs),
      remainingMs: 0,
      overflowMs: 0,
      cyclePos,
      ...session,
    };
  }
}
