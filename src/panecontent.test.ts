import { describe, expect, it } from "vitest";
import { canAdd, nextIndex } from "./panecontent";

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
