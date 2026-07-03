import { describe, expect, it } from "vitest";
import { canAdd, nextIndex, pickFileTarget } from "./panecontent";

describe("nextIndex", () => {
  it("wraps forward past the end", () => {
    expect(nextIndex(3, 2, 1)).toBe(0);
  });

  it("wraps backward past the start", () => {
    expect(nextIndex(3, 0, -1)).toBe(2);
  });

  it("advances within bounds", () => {
    expect(nextIndex(3, 0, 1)).toBe(1);
    expect(nextIndex(3, 2, -1)).toBe(1);
  });

  it("stays put for a single-element stack", () => {
    expect(nextIndex(1, 0, 1)).toBe(0);
    expect(nextIndex(1, 0, -1)).toBe(0);
  });
});

describe("canAdd", () => {
  it("allows adding below the cap", () => {
    expect(canAdd(1, 3)).toBe(true);
    expect(canAdd(2, 3)).toBe(true);
  });

  it("blocks adding at or above the cap", () => {
    expect(canAdd(3, 3)).toBe(false);
    expect(canAdd(4, 3)).toBe(false);
  });
});

describe("pickFileTarget", () => {
  it("returns null only when there are no panes", () => {
    expect(pickFileTarget([])).toBeNull();
  });

  it("prefers the focused pane that already holds a file", () => {
    expect(
      pickFileTarget([
        { paneId: "a", focused: false, hasFile: true, recency: 5 },
        { paneId: "b", focused: true, hasFile: true, recency: 1 },
      ]),
    ).toBe("b");
  });

  it("routes to a pane that holds a file even while it shows its terminal", () => {
    expect(
      pickFileTarget([
        { paneId: "a", focused: true, hasFile: false, recency: 9 },
        { paneId: "b", focused: false, hasFile: true, recency: 3 },
        { paneId: "c", focused: false, hasFile: true, recency: 7 },
      ]),
    ).toBe("c");
  });

  it("falls back to the focused pane when no pane holds a file", () => {
    expect(
      pickFileTarget([
        { paneId: "a", focused: false, hasFile: false, recency: 9 },
        { paneId: "b", focused: true, hasFile: false, recency: 2 },
      ]),
    ).toBe("b");
  });
});
