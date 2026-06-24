import { describe, expect, it } from "vitest";
import { type ActiveBufferLike, lineUnderCursor } from "./term-lines";

function fakeBuffer(
  baseY: number,
  cursorY: number,
  lines: Record<number, string>,
): ActiveBufferLike {
  return {
    baseY,
    cursorY,
    getLine: (y) =>
      lines[y] !== undefined
        ? { translateToString: () => lines[y] }
        : undefined,
  };
}

describe("lineUnderCursor", () => {
  it("returns the line at baseY + cursorY", () => {
    const buf = fakeBuffer(0, 2, { 0: "a", 1: "b", 2: "npm test" });
    expect(lineUnderCursor(buf)).toBe("npm test");
  });

  it("accounts for scrollback offset (baseY)", () => {
    const buf = fakeBuffer(10, 1, { 11: "hello" });
    expect(lineUnderCursor(buf)).toBe("hello");
  });

  it("returns empty string when the line is missing", () => {
    const buf = fakeBuffer(0, 5, { 0: "a" });
    expect(lineUnderCursor(buf)).toBe("");
  });
});
