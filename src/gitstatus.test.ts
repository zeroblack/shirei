import { describe, expect, it } from "vitest";
import {
  countLabel,
  deletedIn,
  fileMark,
  folderMark,
  folderSummaries,
  type GitFileStatus,
  letterOf,
  shouldRunGitRefresh,
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

describe("fileMark", () => {
  it("returns an empty mark for a clean file", () => {
    expect(fileMark(undefined)).toEqual({
      text: "",
      kind: null,
      stage: null,
      conflicted: false,
      label: "",
    });
  });

  it("carries the letter and the staging depth for an ordinary change", () => {
    expect(fileMark(f("/r/a.ts", "modified", false, true))).toEqual({
      text: "M",
      kind: "modified",
      stage: "none",
      conflicted: false,
      label: "modified, unstaged",
    });
    expect(fileMark(f("/r/a.ts", "modified", true, true))).toMatchObject({
      stage: "partial",
      label: "modified, partially staged",
    });
    expect(fileMark(f("/r/a.ts", "added", true, false))).toMatchObject({
      text: "A",
      stage: "full",
      label: "added, staged",
    });
  });

  it("keys a conflict off kind, not off staged/unstaged, and always renders a solid chip", () => {
    const conflict = fileMark(f("/r/a.ts", "conflicted", false, false));
    expect(conflict).toEqual({
      text: "!",
      kind: "conflicted",
      stage: "full",
      conflicted: true,
      label: "conflicted",
    });
  });
});

describe("folderMark", () => {
  it("returns an empty mark for a folder with no changes below", () => {
    expect(folderMark(undefined, false)).toEqual({
      text: "",
      kind: null,
      stage: null,
      conflicted: false,
      label: "",
    });
  });

  it("shows a neutral count only while collapsed", () => {
    const summary = { total: 3, conflicts: 0 };
    expect(folderMark(summary, false)).toEqual({
      text: "3",
      kind: "count",
      stage: null,
      conflicted: false,
      label: "3 changes below",
    });
    expect(folderMark(summary, true)).toEqual({
      text: "",
      kind: null,
      stage: null,
      conflicted: false,
      label: "",
    });
  });

  it("saturates the count at 9+", () => {
    expect(folderMark({ total: 12, conflicts: 0 }, false).text).toBe("9+");
  });

  it("uses the singular label for exactly one change below", () => {
    expect(folderMark({ total: 1, conflicts: 0 }, false).label).toBe(
      "1 change below",
    );
  });

  it("renders a conflict dot whether the folder is collapsed or expanded, and it wins over the count", () => {
    const summary = { total: 5, conflicts: 1 };
    expect(folderMark(summary, false)).toEqual({
      text: "",
      kind: "conflict-dot",
      stage: null,
      conflicted: false,
      label: "conflict below",
    });
    expect(folderMark(summary, true)).toEqual({
      text: "",
      kind: "conflict-dot",
      stage: null,
      conflicted: false,
      label: "conflict below",
    });
  });

  it("keeps the dot at an ancestor whose only change is a conflict two levels below", () => {
    const files = [
      f("/r/src/a.ts", "modified", false, true),
      f("/r/src/deep/b.ts", "conflicted", false, false),
    ];
    const sums = folderSummaries(files, "/r");
    expect(folderMark(sums.get("/r"), false).kind).toBe("conflict-dot");
    expect(folderMark(sums.get("/r/src"), false).kind).toBe("conflict-dot");
    expect(folderMark(sums.get("/r/src/deep"), false).kind).toBe(
      "conflict-dot",
    );
  });
});

describe("shouldRunGitRefresh", () => {
  const base = { statusInTree: true, root: "/repo", inFlight: false };

  it("runs when the feature is on, a root is known, and nothing is in flight", () => {
    expect(shouldRunGitRefresh(base)).toBe(true);
  });

  it("skips when the feature is disabled in config", () => {
    expect(shouldRunGitRefresh({ ...base, statusInTree: false })).toBe(false);
  });

  it("skips when no root is open yet", () => {
    expect(shouldRunGitRefresh({ ...base, root: null })).toBe(false);
  });

  it("skips a second call while one is already in flight", () => {
    expect(shouldRunGitRefresh({ ...base, inFlight: true })).toBe(false);
  });
});
