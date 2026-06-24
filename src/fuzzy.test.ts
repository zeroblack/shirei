import { describe, expect, it } from "vitest";
import { fuzzyMatch, topK } from "./fuzzy";

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

describe("topK", () => {
  const asc = (a: number, b: number) => a - b;

  it("returns the best k in order without sorting the rest", () => {
    expect(topK([5, 1, 4, 2, 3], 3, asc)).toEqual([1, 2, 3]);
  });

  it("handles fewer items than k", () => {
    expect(topK([2, 1], 5, asc)).toEqual([1, 2]);
  });

  it("returns empty for k <= 0", () => {
    expect(topK([1, 2], 0, asc)).toEqual([]);
  });

  it("keeps earlier items on ties (stable for equal ranks)", () => {
    const items = [
      { s: 1, tag: "a" },
      { s: 1, tag: "b" },
      { s: 0, tag: "c" },
    ];
    const out = topK(items, 2, (x, y) => x.s - y.s);
    expect(out.map((x) => x.tag)).toEqual(["c", "a"]);
  });
});
