import { describe, expect, it } from "vitest";
import {
  TimerMachine,
  type TimerPreset,
  type TimerStartOptions,
} from "./machine";

const pomodoro: TimerPreset = {
  id: "pomodoro",
  label: "Pomodoro",
  focusMin: 25,
  breakMin: 5,
  longBreakMin: 20,
  cyclesBeforeLong: 4,
};

const flowtime: TimerPreset = {
  id: "flowtime",
  label: "Flowtime",
  focusMin: 0,
  breakMin: 0,
  longBreakMin: 0,
  cyclesBeforeLong: 1,
};

const shortFocus: TimerPreset = {
  id: "short",
  label: "Short",
  focusMin: 10,
  breakMin: 5,
  longBreakMin: 20,
  cyclesBeforeLong: 4,
};

const overflowOpts: TimerStartOptions = {
  overflowEnabled: true,
  autoAdvance: false,
  overflowCapMin: 30,
};
const autoAdvanceOpts: TimerStartOptions = {
  overflowEnabled: false,
  autoAdvance: true,
  overflowCapMin: 30,
};
const autoAdvanceWithOverflowOpts: TimerStartOptions = {
  overflowEnabled: true,
  autoAdvance: true,
  overflowCapMin: 30,
};
const plainOpts: TimerStartOptions = {
  overflowEnabled: false,
  autoAdvance: false,
  overflowCapMin: 30,
};

describe("TimerMachine", () => {
  it("keeps remaining stable across a pause gap", () => {
    const m = new TimerMachine();
    m.start(pomodoro, plainOpts, 1_000);
    const a = m.tick(60_000).remainingMs;
    m.pause(60_000);
    const paused = m.tick(120_000).remainingMs;
    expect(paused).toBe(a);
    m.resume(120_000);
    expect(m.tick(121_000).remainingMs).toBe(a - 1_000);
  });

  it("starts running with progress 0", () => {
    const m = new TimerMachine();
    m.start(shortFocus, plainOpts, 0);
    const view = m.tick(0);
    expect(view.phase).toBe("running");
    expect(view.progress).toBe(0);
    expect(view.remainingMs).toBe(shortFocus.focusMin * 60_000);
  });

  it("reaches ~half progress halfway through the planned duration", () => {
    const m = new TimerMachine();
    m.start(shortFocus, plainOpts, 0);
    const plannedMs = shortFocus.focusMin * 60_000;
    const view = m.tick(plannedMs / 2);
    expect(view.progress).toBeCloseTo(0.5, 5);
    expect(view.remainingMs).toBe(plannedMs / 2);
  });

  it("moves to overflow past the planned duration when overflow is enabled", () => {
    const m = new TimerMachine();
    m.start(shortFocus, overflowOpts, 0);
    const plannedMs = shortFocus.focusMin * 60_000;
    const view = m.tick(plannedMs + 50_000);
    expect(view.phase).toBe("overflow");
    expect(view.progress).toBeGreaterThanOrEqual(1);
    expect(view.overflowMs).toBe(50_000);
  });

  it("auto-advances to break at zero instead of overflowing", () => {
    const m = new TimerMachine();
    m.start(shortFocus, autoAdvanceOpts, 0);
    const plannedMs = shortFocus.focusMin * 60_000;
    const view = m.tick(plannedMs);
    expect(view.phase).toBe("break");
    expect(view.progress).toBe(0);
    expect(view.remainingMs).toBe(shortFocus.breakMin * 60_000);
    expect(view.overflowMs).toBe(0);
  });

  it("auto-advances break straight to the next focus block", () => {
    const m = new TimerMachine();
    m.start(shortFocus, autoAdvanceOpts, 0);
    const focusPlannedMs = shortFocus.focusMin * 60_000;
    m.tick(focusPlannedMs);
    const breakPlannedMs = shortFocus.breakMin * 60_000;
    const view = m.tick(focusPlannedMs + breakPlannedMs);
    expect(view.phase).toBe("running");
    expect(view.progress).toBe(0);
    expect(view.remainingMs).toBe(focusPlannedMs);
  });

  it("carries the overshoot across a chained auto-advance", () => {
    const m = new TimerMachine();
    m.start(shortFocus, autoAdvanceOpts, 0);
    const focusPlannedMs = shortFocus.focusMin * 60_000;
    const breakPlannedMs = shortFocus.breakMin * 60_000;
    const view = m.tick(focusPlannedMs + breakPlannedMs + 20_000);
    expect(view.phase).toBe("running");
    expect(view.remainingMs).toBe(focusPlannedMs - 20_000);
  });

  it("inserts a long break after cyclesBeforeLong focus blocks", () => {
    const m = new TimerMachine();
    m.start(shortFocus, autoAdvanceOpts, 0);
    const focusPlannedMs = shortFocus.focusMin * 60_000;
    const breakPlannedMs = shortFocus.breakMin * 60_000;
    let now = 0;
    for (let cycle = 1; cycle < shortFocus.cyclesBeforeLong; cycle++) {
      now += focusPlannedMs;
      m.tick(now);
      now += breakPlannedMs;
      m.tick(now);
    }
    now += focusPlannedMs;
    const view = m.tick(now);
    expect(view.phase).toBe("break");
    expect(view.remainingMs).toBe(shortFocus.longBreakMin * 60_000);
    expect(view.cyclePos.focus).toBe(shortFocus.cyclesBeforeLong);
  });

  it("autoAdvance takes precedence over overflow when both are enabled", () => {
    const m = new TimerMachine();
    m.start(shortFocus, autoAdvanceWithOverflowOpts, 0);
    const focusPlannedMs = shortFocus.focusMin * 60_000;
    const view = m.tick(focusPlannedMs + 50_000);
    expect(view.phase).toBe("break");
    expect(view.overflowMs).toBe(0);
    expect(view.remainingMs).toBe(shortFocus.breakMin * 60_000 - 50_000);
  });

  it("keeps overflowing on focus end when autoAdvance is off", () => {
    const m = new TimerMachine();
    m.start(shortFocus, overflowOpts, 0);
    const plannedMs = shortFocus.focusMin * 60_000;
    const view = m.tick(plannedMs);
    expect(view.phase).toBe("overflow");
    expect(view.progress).toBe(1);
    expect(view.overflowMs).toBe(0);
  });

  it("skip advances focus straight to break", () => {
    const m = new TimerMachine();
    m.start(shortFocus, plainOpts, 0);
    m.skip(5_000);
    const view = m.tick(5_000);
    expect(view.phase).toBe("break");
    expect(view.progress).toBe(0);
    expect(view.remainingMs).toBe(shortFocus.breakMin * 60_000);
  });

  it("reset returns to idle", () => {
    const m = new TimerMachine();
    m.start(shortFocus, plainOpts, 0);
    m.reset();
    const view = m.tick(10_000);
    expect(view.phase).toBe("idle");
    expect(view.progress).toBe(0);
    expect(view.remainingMs).toBe(0);
  });

  it("flowtime is open-ended: remaining hidden, progress saturates", () => {
    const m = new TimerMachine();
    m.start(flowtime, plainOpts, 0);
    const soon = m.tick(60_000);
    const later = m.tick(3_600_000);
    expect(soon.phase).toBe("running");
    expect(soon.remainingMs).toBe(0);
    expect(later.remainingMs).toBe(0);
    expect(soon.progress).toBeGreaterThan(0);
    expect(later.progress).toBeGreaterThan(soon.progress);
    expect(later.progress).toBeLessThan(1);
  });

  describe("auto-advance through a zero-length break/long_break", () => {
    const ultradian: TimerPreset = {
      id: "ultradian",
      label: "Ultradian",
      focusMin: 90,
      breakMin: 20,
      longBreakMin: 0,
      cyclesBeforeLong: 1,
    };
    const deepWork: TimerPreset = {
      id: "deep_work",
      label: "Deep Work",
      focusMin: 90,
      breakMin: 0,
      longBreakMin: 0,
      cyclesBeforeLong: 1,
    };

    it("takes the real break instead of a zero-length long break (ultradian)", () => {
      const m = new TimerMachine();
      m.start(ultradian, autoAdvanceOpts, 0);
      const focusPlannedMs = ultradian.focusMin * 60_000;
      const view = m.tick(focusPlannedMs);
      expect(view.phase).toBe("break");
      expect(view.remainingMs).toBe(ultradian.breakMin * 60_000);
    });

    it("lands back in a running focus block instead of freezing on a zero-length break (deep work)", () => {
      const m = new TimerMachine();
      m.start(deepWork, autoAdvanceOpts, 0);
      const focusPlannedMs = deepWork.focusMin * 60_000;
      const view = m.tick(focusPlannedMs);
      expect(view.phase).toBe("running");
      expect(view.progress).toBe(0);
      expect(view.remainingMs).toBe(focusPlannedMs);
    });

    it("carries a large gap's overshoot into the next focus block across a zero-length break", () => {
      const m = new TimerMachine();
      m.start(deepWork, autoAdvanceOpts, 0);
      const focusPlannedMs = deepWork.focusMin * 60_000;
      const view = m.tick(focusPlannedMs + 45_000);
      expect(view.phase).toBe("running");
      expect(view.remainingMs).toBe(focusPlannedMs - 45_000);
    });
  });

  describe("overflow cap", () => {
    const capOpts: TimerStartOptions = {
      overflowEnabled: true,
      autoAdvance: false,
      overflowCapMin: 10,
    };

    it("keeps counting overflow while under the cap", () => {
      const m = new TimerMachine();
      m.start(shortFocus, capOpts, 0);
      const plannedMs = shortFocus.focusMin * 60_000;
      const view = m.tick(plannedMs + 5 * 60_000);
      expect(view.phase).toBe("overflow");
      expect(view.overflowMs).toBe(5 * 60_000);
    });

    it("force-advances to the next segment, exactly like skip, once overflow reaches the cap", () => {
      const m = new TimerMachine();
      m.start(shortFocus, capOpts, 0);
      const plannedMs = shortFocus.focusMin * 60_000;
      const view = m.tick(plannedMs + 10 * 60_000);
      expect(view.phase).toBe("break");
      expect(view.progress).toBe(0);
      expect(view.remainingMs).toBe(shortFocus.breakMin * 60_000);
    });

    it("uses the cap instant as the new segment boundary, not the tick timestamp, after a long gap", () => {
      const m = new TimerMachine();
      m.start(shortFocus, capOpts, 0);
      const plannedMs = shortFocus.focusMin * 60_000;
      const capMs = 10 * 60_000;
      const view = m.tick(plannedMs + capMs + 60_000);
      expect(view.phase).toBe("break");
      expect(view.remainingMs).toBe(shortFocus.breakMin * 60_000 - 60_000);
    });

    it("never force-advances an open-ended flowtime block", () => {
      const m = new TimerMachine();
      m.start(flowtime, capOpts, 0);
      const view = m.tick(60 * 60_000);
      expect(view.phase).toBe("running");
    });

    it("carries paused time into the cap boundary so the break starts fresh", () => {
      const m = new TimerMachine();
      m.start(shortFocus, capOpts, 0);
      m.pause(60_000);
      m.resume(180_000);
      const plannedMs = shortFocus.focusMin * 60_000;
      const capMs = 10 * 60_000;
      const view = m.tick(120_000 + plannedMs + capMs);
      expect(view.phase).toBe("break");
      expect(view.remainingMs).toBe(shortFocus.breakMin * 60_000);
    });
  });

  it("carries paused time into the auto-advance boundary so the break is not short-changed", () => {
    const m = new TimerMachine();
    m.start(shortFocus, autoAdvanceOpts, 0);
    m.pause(60_000);
    m.resume(180_000);
    const plannedMs = shortFocus.focusMin * 60_000;
    const view = m.tick(120_000 + plannedMs + 30_000);
    expect(view.phase).toBe("break");
    expect(view.remainingMs).toBe(shortFocus.breakMin * 60_000 - 30_000);
  });

  describe("session counters (cyclesCompleted / breaksCompleted / focusSeconds)", () => {
    it("starts a fresh session at zero", () => {
      const m = new TimerMachine();
      m.start(shortFocus, autoAdvanceOpts, 0);
      const view = m.tick(0);
      expect(view.cyclesCompleted).toBe(0);
      expect(view.breaksCompleted).toBe(0);
      expect(view.focusSeconds).toBe(0);
    });

    it("counts a focus block and its break only once each, across focus -> break -> focus", () => {
      const m = new TimerMachine();
      m.start(shortFocus, autoAdvanceOpts, 0);
      const focusPlannedMs = shortFocus.focusMin * 60_000;
      const breakPlannedMs = shortFocus.breakMin * 60_000;

      const afterFocus = m.tick(focusPlannedMs);
      expect(afterFocus.phase).toBe("break");
      expect(afterFocus.cyclesCompleted).toBe(1);
      expect(afterFocus.breaksCompleted).toBe(0);
      expect(afterFocus.focusSeconds).toBe(focusPlannedMs / 1000);

      const afterBreak = m.tick(focusPlannedMs + breakPlannedMs);
      expect(afterBreak.phase).toBe("running");
      expect(afterBreak.cyclesCompleted).toBe(1);
      expect(afterBreak.breaksCompleted).toBe(1);
      expect(afterBreak.focusSeconds).toBe(focusPlannedMs / 1000);
    });

    it("counts a manual skip through a break the same as auto-advance", () => {
      const m = new TimerMachine();
      m.start(shortFocus, plainOpts, 0);
      const focusPlannedMs = shortFocus.focusMin * 60_000;
      m.skip(focusPlannedMs);
      expect(m.tick(focusPlannedMs).breaksCompleted).toBe(0);
      m.skip(focusPlannedMs + 1_000);
      const view = m.tick(focusPlannedMs + 1_000);
      expect(view.phase).toBe("running");
      expect(view.breaksCompleted).toBe(1);
      expect(view.cyclesCompleted).toBe(1);
    });

    it("keeps accumulating cyclesCompleted/focusSeconds across a long-break rollover, unlike cyclePos.focus", () => {
      const m = new TimerMachine();
      m.start(shortFocus, autoAdvanceOpts, 0);
      const focusPlannedMs = shortFocus.focusMin * 60_000;
      const breakPlannedMs = shortFocus.breakMin * 60_000;
      const longBreakPlannedMs = shortFocus.longBreakMin * 60_000;
      let now = 0;
      for (let cycle = 1; cycle < shortFocus.cyclesBeforeLong; cycle++) {
        now += focusPlannedMs;
        m.tick(now);
        now += breakPlannedMs;
        m.tick(now);
      }
      now += focusPlannedMs;
      const atLongBreak = m.tick(now);
      expect(atLongBreak.phase).toBe("break");
      expect(atLongBreak.cyclePos.focus).toBe(shortFocus.cyclesBeforeLong);
      expect(atLongBreak.cyclesCompleted).toBe(shortFocus.cyclesBeforeLong);

      now += longBreakPlannedMs;
      const backToFocus = m.tick(now);
      expect(backToFocus.phase).toBe("running");
      expect(backToFocus.cyclePos.focus).toBe(0);
      expect(backToFocus.cyclesCompleted).toBe(shortFocus.cyclesBeforeLong);
      expect(backToFocus.breaksCompleted).toBe(shortFocus.cyclesBeforeLong);
    });

    it("counts the real break instead of the skipped zero-length long break (ultradian)", () => {
      const m = new TimerMachine();
      const ultradian: TimerPreset = {
        id: "ultradian",
        label: "Ultradian",
        focusMin: 90,
        breakMin: 20,
        longBreakMin: 0,
        cyclesBeforeLong: 1,
      };
      m.start(ultradian, autoAdvanceOpts, 0);
      const focusPlannedMs = ultradian.focusMin * 60_000;
      const breakPlannedMs = ultradian.breakMin * 60_000;
      const atBreak = m.tick(focusPlannedMs);
      expect(atBreak.phase).toBe("break");
      expect(atBreak.breaksCompleted).toBe(0);
      const backToFocus = m.tick(focusPlannedMs + breakPlannedMs);
      expect(backToFocus.phase).toBe("running");
      expect(backToFocus.breaksCompleted).toBe(1);
      expect(backToFocus.cyclesCompleted).toBe(1);
    });

    it("resets all three counters back to zero on reset()", () => {
      const m = new TimerMachine();
      m.start(shortFocus, autoAdvanceOpts, 0);
      const focusPlannedMs = shortFocus.focusMin * 60_000;
      const breakPlannedMs = shortFocus.breakMin * 60_000;
      m.tick(focusPlannedMs);
      m.tick(focusPlannedMs + breakPlannedMs);

      m.reset();
      const idle = m.tick(focusPlannedMs + breakPlannedMs + 10_000);
      expect(idle.cyclesCompleted).toBe(0);
      expect(idle.breaksCompleted).toBe(0);
      expect(idle.focusSeconds).toBe(0);
    });

    it("excludes paused time from the accumulated focusSeconds", () => {
      const m = new TimerMachine();
      m.start(shortFocus, autoAdvanceOpts, 0);
      m.pause(60_000);
      m.resume(180_000);
      const focusPlannedMs = shortFocus.focusMin * 60_000;
      const view = m.tick(120_000 + focusPlannedMs);
      expect(view.phase).toBe("break");
      expect(view.focusSeconds).toBe(focusPlannedMs / 1000);
    });
  });
});
