import { describe, expect, it } from "vitest";
import {
  cycleScope,
  resolveSearchRoot,
  rootForScope,
  type ScopeRoots,
} from "./searchscope";

describe("resolveSearchRoot", () => {
  const base = {
    projectPath: null,
    openedFrom: null,
    shellCwd: null,
    home: "/Users/d",
  };

  it("prefers a configured project path", () => {
    expect(
      resolveSearchRoot({
        ...base,
        projectPath: "/p",
        openedFrom: "/o",
        shellCwd: "/c",
      }),
    ).toBe("/p");
  });

  it("falls back to the tab's opened-from dir", () => {
    expect(
      resolveSearchRoot({ ...base, openedFrom: "/o", shellCwd: "/c" }),
    ).toBe("/o");
  });

  it("falls back to the shell cwd", () => {
    expect(resolveSearchRoot({ ...base, shellCwd: "/c" })).toBe("/c");
  });

  it("uses home as the last resort", () => {
    expect(resolveSearchRoot(base)).toBe("/Users/d");
  });
});

describe("cycleScope", () => {
  it("wraps project → home → project", () => {
    expect(cycleScope("project", 1)).toBe("home");
    expect(cycleScope("home", 1)).toBe("project");
  });

  it("reverses with -1", () => {
    expect(cycleScope("project", -1)).toBe("home");
    expect(cycleScope("home", -1)).toBe("project");
  });
});

describe("rootForScope", () => {
  const roots: ScopeRoots = {
    project: "/p",
    home: "/h",
    projectLabel: "shirei",
    projectColor: "#f00",
  };

  it("returns the project root for project scope", () => {
    expect(rootForScope("project", roots)).toBe("/p");
  });

  it("returns the home root for home scope", () => {
    expect(rootForScope("home", roots)).toBe("/h");
  });
});
