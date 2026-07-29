import { describe, expect, it } from "vitest";
import type { FocusPreset } from "../config";
import type { FocusPanelState } from "./panel";
import { clampFocusMin, effectiveFocusMin, presetRows } from "./panel";

const POMODORO: FocusPreset = {
  id: "pomodoro",
  label: "Pomodoro",
  focus_min: 25,
  break_min: 5,
  long_break_min: 20,
  cycles_before_long: 4,
  auto_advance: true,
};

const DEEP_WORK: FocusPreset = {
  id: "deep-work",
  label: "Deep work",
  focus_min: 50,
  break_min: 10,
  long_break_min: 30,
  cycles_before_long: 3,
  auto_advance: false,
};

function stateWith(overrides: Partial<FocusPanelState> = {}): FocusPanelState {
  return {
    presets: [POMODORO, DEEP_WORK],
    activePresetId: "pomodoro",
    focusMinOverride: null,
    quickFocusSteps: [25, 50, 90],
    focusStepMin: 5,
    focusMinFloor: 5,
    focusMinCeil: 180,
    shortcuts: { toggle: "", skip: "", reset: "", panel: "" },
    ...overrides,
  };
}

describe("presetRows", () => {
  it("maps each preset to a row with a focus/break summary", () => {
    const rows = presetRows([POMODORO, DEEP_WORK], "pomodoro");
    expect(rows).toEqual([
      { id: "pomodoro", label: "Pomodoro", summary: "25/5", active: true },
      { id: "deep-work", label: "Deep work", summary: "50/10", active: false },
    ]);
  });

  it("marks none active when the active id matches no preset", () => {
    const rows = presetRows([POMODORO], "missing");
    expect(rows.every((r) => !r.active)).toBe(true);
  });
});

describe("effectiveFocusMin", () => {
  it("falls back to the active preset's own focus_min without an override", () => {
    expect(effectiveFocusMin(stateWith())).toBe(25);
  });

  it("prefers the override over the active preset's focus_min", () => {
    expect(effectiveFocusMin(stateWith({ focusMinOverride: 40 }))).toBe(40);
  });

  it("tracks the active preset once it changes, override still cleared", () => {
    expect(effectiveFocusMin(stateWith({ activePresetId: "deep-work" }))).toBe(
      50,
    );
  });

  it("is 0 when the active preset id resolves to nothing", () => {
    expect(effectiveFocusMin(stateWith({ activePresetId: "missing" }))).toBe(0);
  });
});

describe("clampFocusMin", () => {
  it("clamps below the step size up to the step floor", () => {
    expect(clampFocusMin(2, 5, 5, 180)).toBe(5);
  });

  it("clamps above the ceiling down to it", () => {
    expect(clampFocusMin(400, 5, 5, 180)).toBe(180);
  });

  it("passes an in-range value through unchanged", () => {
    expect(clampFocusMin(45, 5, 5, 180)).toBe(45);
  });

  it("never floors below the step even when the step itself is small", () => {
    expect(clampFocusMin(1, 1, 5, 180)).toBe(5);
  });

  it("honors a configured floor/ceil different from the built-in defaults", () => {
    expect(clampFocusMin(3, 2, 10, 90)).toBe(10);
    expect(clampFocusMin(200, 2, 10, 90)).toBe(90);
  });
});
