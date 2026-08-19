import { describe, expect, it } from "vitest";
import {
  countLabel,
  deletedIn,
  folderSummaries,
  type GitFileStatus,
  letterOf,
  stageOf,
  statusMap,
} from "./gitstatus";

const f = (
  path: string,
  kind: GitFileStatus["kind"],
  staged: boolean,
  unstaged: boolean,
): GitFileStatus => ({ path, kind, staged, unstaged });

describe("stageOf", () => {
  it("maps the three staging depths", () => {
    expect(stageOf(f("/r/a", "modified", false, true))).toBe("none");
    expect(stageOf(f("/r/a", "modified", true, true))).toBe("partial");
    expect(stageOf(f("/r/a", "modified", true, false))).toBe("full");
  });

  it("returns none for a conflict, which carries no staged/unstaged bits", () => {
    expect(stageOf(f("/r/a", "conflicted", false, false))).toBe("none");
  });
});

describe("letterOf", () => {
  it("uses the git status --short vocabulary", () => {
    expect(letterOf("modified")).toBe("M");
    expect(letterOf("added")).toBe("A");
    expect(letterOf("untracked")).toBe("U");
    expect(letterOf("deleted")).toBe("D");
    expect(letterOf("renamed")).toBe("R");
    expect(letterOf("conflicted")).toBe("!");
  });
});

describe("folderSummaries", () => {
  const files = [
    f("/r/src/a.ts", "modified", false, true),
    f("/r/src/deep/b.ts", "untracked", false, true),
    f("/r/src/deep/c.ts", "conflicted", false, true),
    f("/r/top.ts", "modified", false, true),
  ];

  it("rolls counts and conflicts up through every ancestor", () => {
    const sums = folderSummaries(files, "/r");
    expect(sums.get("/r/src")).toEqual({ total: 3, conflicts: 1 });
    expect(sums.get("/r/src/deep")).toEqual({ total: 2, conflicts: 1 });
    expect(sums.get("/r")).toEqual({ total: 4, conflicts: 1 });
  });

  it("stops at the root and never walks above it", () => {
    expect(folderSummaries(files, "/r").has("/")).toBe(false);
  });

  it("does not roll up a directory that merely shares a string prefix", () => {
    const sums = folderSummaries(
      [f("/rx/a.ts", "modified", false, true)],
      "/r",
    );
    expect(sums.has("/rx")).toBe(false);
    expect(sums.has("/r")).toBe(false);
  });
});

describe("countLabel", () => {
  it("is exact to nine and then saturates", () => {
    expect(countLabel(1)).toBe("1");
    expect(countLabel(9)).toBe("9");
    expect(countLabel(10)).toBe("9+");
    expect(countLabel(0)).toBe("");
  });
});

describe("deletedIn", () => {
  const files = [
    f("/r/src/gone.ts", "deleted", false, true),
    f("/r/src/deep/also.ts", "deleted", false, true),
    f("/r/src/kept.ts", "modified", false, true),
  ];

  it("returns only direct children of the directory", () => {
    expect(deletedIn(files, "/r/src")).toEqual(["/r/src/gone.ts"]);
    expect(deletedIn(files, "/r/src/deep")).toEqual(["/r/src/deep/also.ts"]);
  });
});

describe("statusMap", () => {
  it("keys by absolute path", () => {
    const map = statusMap([f("/r/a.ts", "modified", false, true)]);
    expect(map.get("/r/a.ts")?.kind).toBe("modified");
  });
});
