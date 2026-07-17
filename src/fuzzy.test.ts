import { describe, expect, it } from "vitest";
import { fuzzyMatch } from "./fuzzy";

describe("fuzzyMatch", () => {
  it("matches a subsequence", () => {
    expect(fuzzyMatch("apts", "app.ts")).not.toBeNull();
  });

  it("does not match when a letter is missing", () => {
    expect(fuzzyMatch("xyz", "app.ts")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(fuzzyMatch("APP", "app.ts")).not.toBeNull();
  });

  it("ranks more consecutive matches higher", () => {
    const a = fuzzyMatch("app", "app.ts") ?? -1;
    const b = fuzzyMatch("app", "a_p_p.ts") ?? -1;
    expect(a).toBeGreaterThan(b);
  });

  it("empty query matches with score 0", () => {
    expect(fuzzyMatch("", "anything")).toBe(0);
  });
});

describe("fuzzyMatch ranking weights", () => {
  it("boundary bonus ranks segment starts above mid-word hits", () => {
    const boundary = fuzzyMatch("app", "src/app.ts") ?? -1;
    const midWord = fuzzyMatch("app", "scrapple.ts") ?? -1;
    expect(boundary).toBeGreaterThan(midWord);
  });
});
