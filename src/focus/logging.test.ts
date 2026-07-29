import { describe, expect, it } from "vitest";
import {
  type FocusLogConfig,
  type FocusLogTransition,
  logEventsFor,
} from "./logging";

function cfgWith(overrides: Partial<FocusLogConfig> = {}): FocusLogConfig {
  return {
    metrics: { enabled: true },
    focus: { session_note: true },
    ...overrides,
  };
}

const startTransition: FocusLogTransition = {
  kind: "start",
  uuid: "block-1",
  presetId: "pomodoro-25-5",
  method: "pomodoro",
  phase: "focus",
  plannedDurationS: 1500,
  startTs: 1_700_000_000,
  projectId: null,
  shireiSessionId: "shirei-session-1",
  agentId: null,
};

const endTransition: FocusLogTransition = {
  kind: "end",
  uuid: "block-1",
  endTs: 1_700_001_500,
  actualDurationS: 1500,
  status: "completed",
  note: "deep work on the parser",
};

describe("logEventsFor", () => {
  it("emits nothing when metrics are disabled", () => {
    const cfg = cfgWith({ metrics: { enabled: false } });
    expect(logEventsFor(startTransition, cfg)).toEqual([]);
    expect(logEventsFor(endTransition, cfg)).toEqual([]);
  });

  it("emits a start event with the block payload", () => {
    const events = logEventsFor(startTransition, cfgWith());
    expect(events).toEqual([
      {
        cmd: "start",
        payload: {
          uuid: "block-1",
          presetId: "pomodoro-25-5",
          method: "pomodoro",
          phase: "focus",
          plannedDurationS: 1500,
          startTs: 1_700_000_000,
          projectId: null,
          shireiSessionId: "shirei-session-1",
          agentId: null,
        },
      },
    ]);
  });

  it("emits a start+end pair across the lifecycle of a completed focus block", () => {
    const startEvents = logEventsFor(startTransition, cfgWith());
    const endEvents = logEventsFor(endTransition, cfgWith());
    expect(startEvents).toHaveLength(1);
    expect(startEvents[0].cmd).toBe("start");
    expect(endEvents).toHaveLength(1);
    expect(endEvents[0]).toEqual({
      cmd: "end",
      uuid: "block-1",
      end: {
        endTs: 1_700_001_500,
        actualDurationS: 1500,
        status: "completed",
        note: "deep work on the parser",
      },
    });
  });

  it("does not include a session note when config.focus.session_note is false", () => {
    const cfg = cfgWith({ focus: { session_note: false } });
    const events = logEventsFor(endTransition, cfg);
    expect(events).toEqual([
      {
        cmd: "end",
        uuid: "block-1",
        end: {
          endTs: 1_700_001_500,
          actualDurationS: 1500,
          status: "completed",
        },
      },
    ]);
  });

  it("omits the note when the transition carries none, even if session notes are enabled", () => {
    const events = logEventsFor(
      { ...endTransition, note: undefined },
      cfgWith(),
    );
    expect(events[0]).toEqual({
      cmd: "end",
      uuid: "block-1",
      end: {
        endTs: 1_700_001_500,
        actualDurationS: 1500,
        status: "completed",
      },
    });
  });

  it("emits an update carrying pause count and paused duration", () => {
    const events = logEventsFor(
      {
        kind: "pause",
        uuid: "block-1",
        pauseCount: 2,
        pausedDurationS: 90,
      },
      cfgWith(),
    );
    expect(events).toEqual([
      {
        cmd: "update",
        uuid: "block-1",
        patch: { pauseCount: 2, pausedDurationS: 90 },
      },
    ]);
  });

  it("includes optional energy and focus ratings on the end event when present", () => {
    const events = logEventsFor(
      { ...endTransition, note: undefined, energyRating: 4, focusRating: 5 },
      cfgWith(),
    );
    expect(events[0]).toEqual({
      cmd: "end",
      uuid: "block-1",
      end: {
        endTs: 1_700_001_500,
        actualDurationS: 1500,
        status: "completed",
        energyRating: 4,
        focusRating: 5,
      },
    });
  });
});
