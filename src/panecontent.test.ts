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
  it("returns null when no pane has an active file viewer", () => {
    expect(
      pickFileTarget([
        { paneId: "a", focused: true, activeIsFile: false, recency: 2 },
        { paneId: "b", focused: false, activeIsFile: false, recency: 1 },
      ]),
    ).toBeNull();
  });

  it("prefers the focused file-viewer pane", () => {
    expect(
      pickFileTarget([
        { paneId: "a", focused: false, activeIsFile: true, recency: 5 },
        { paneId: "b", focused: true, activeIsFile: true, recency: 1 },
      ]),
    ).toBe("b");
  });

  it("falls back to the most recent file-viewer pane when none is focused", () => {
    expect(
      pickFileTarget([
        { paneId: "a", focused: false, activeIsFile: true, recency: 3 },
        { paneId: "b", focused: false, activeIsFile: true, recency: 7 },
      ]),
    ).toBe("b");
  });

  it("ignores non-file panes even when focused", () => {
    expect(
      pickFileTarget([
        { paneId: "a", focused: true, activeIsFile: false, recency: 9 },
        { paneId: "b", focused: false, activeIsFile: true, recency: 2 },
      ]),
    ).toBe("b");
  });
});
