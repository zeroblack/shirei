import { describe, expect, it } from "vitest";
import {
  closeLeaf,
  declaredCommands,
  instantiate,
  leaves,
  type PaneNode,
  resolveDefaultTemplate,
  sameStructure,
  splitLeaf,
} from "./panetree";

const L = (id: string): PaneNode => ({ kind: "leaf", id });

describe("panetree", () => {
  it("a single leaf: leaves returns that leaf", () => {
    expect(leaves(L("a")).map((l) => l.id)).toEqual(["a"]);
  });

  it("splitLeaf replaces the leaf with a split holding both", () => {
    const t = splitLeaf(L("a"), "a", "h", { kind: "leaf", id: "b" });
    expect(t.kind).toBe("split");
    expect(leaves(t).map((l) => l.id)).toEqual(["a", "b"]);
  });

  it("nested splitLeaf keeps leaf order", () => {
    let t: PaneNode = L("a");
    t = splitLeaf(t, "a", "h", { kind: "leaf", id: "b" });
    t = splitLeaf(t, "b", "v", { kind: "leaf", id: "c" });
    expect(leaves(t).map((l) => l.id)).toEqual(["a", "b", "c"]);
  });

  it("closeLeaf promotes the sibling", () => {
    const t = splitLeaf(L("a"), "a", "h", { kind: "leaf", id: "b" });
    expect(closeLeaf(t, "b")).toEqual(L("a"));
  });

  it("closeLeaf on a leaf root returns null", () => {
    expect(closeLeaf(L("a"), "a")).toBeNull();
  });

  it("sameStructure ignores id and cwd, compares structure/command/ratio", () => {
    const tpl: PaneNode = {
      kind: "split",
      dir: "h",
      ratio: 0.5,
      a: { kind: "leaf", id: "", command: "claude" },
      b: { kind: "leaf", id: "" },
    };
    const clone = instantiate(tpl, () => "fresh", "/proj");
    expect(sameStructure(tpl, clone)).toBe(true);

    const different: PaneNode = { ...tpl, ratio: 0.4 };
    expect(sameStructure(tpl, different)).toBe(false);
    expect(sameStructure(tpl, L("a"))).toBe(false);
  });
});

describe("declaredCommands", () => {
  const yaguraTree: PaneNode = {
    kind: "split",
    dir: "h",
    ratio: 0.5,
    a: { kind: "leaf", id: "" },
    b: {
      kind: "split",
      dir: "v",
      ratio: 0.62,
      a: { kind: "leaf", id: "", command: "yagura" },
      b: { kind: "leaf", id: "" },
    },
  };

  it("collects declared commands without duplicates, skipping bare shells", () => {
    expect(declaredCommands(yaguraTree)).toEqual(["yagura"]);
    expect(declaredCommands(L("a"))).toEqual([]);
  });
});

describe("resolveDefaultTemplate", () => {
  const yaguraTree: PaneNode = {
    kind: "split",
    dir: "h",
    ratio: 0.5,
    a: { kind: "leaf", id: "" },
    b: { kind: "leaf", id: "", command: "yagura" },
  };
  const templates = [{ name: "Yagura", tree: yaguraTree }];
  const always = () => true;

  it("returns null when no template is selected", () => {
    expect(resolveDefaultTemplate(templates, "", always)).toBeNull();
  });

  it("returns null for an unknown template name", () => {
    expect(resolveDefaultTemplate(templates, "nope", always)).toBeNull();
  });

  it("returns the tree when every declared command is available", () => {
    expect(resolveDefaultTemplate(templates, "Yagura", always)).toBe(
      yaguraTree,
    );
  });

  it("falls back to null when a declared command is missing", () => {
    expect(
      resolveDefaultTemplate(templates, "Yagura", (c) => c !== "yagura"),
    ).toBeNull();
  });
});

describe("instantiate", () => {
  it("clones with fresh ids and cwd, keeping commands/structure", () => {
    let n = 0;
    const id = () => `x${++n}`;
    const tpl: PaneNode = {
      kind: "split",
      dir: "h",
      ratio: 0.5,
      a: { kind: "leaf", id: "", command: "claude" },
      b: { kind: "leaf", id: "" },
    };
    const out = instantiate(tpl, id, "/proj");
    expect(out.kind).toBe("split");
    const ls = leaves(out);
    expect(ls.map((l) => l.id)).toEqual(["x1", "x2"]);
    expect(ls.every((l) => l.cwd === "/proj")).toBe(true);
    expect(ls[0].command).toBe("claude");
  });
});
