import { EditorState, type Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { parseConflicts } from "./editor-conflict";

function parse(src: string): {
  doc: Text;
  blocks: ReturnType<typeof parseConflicts>;
} {
  const doc = EditorState.create({ doc: src }).doc;
  return { doc, blocks: parseConflicts(doc) };
}

const slice = (doc: Text, from: number, to: number): string =>
  to > from ? doc.sliceString(from, to) : "";

describe("parseConflicts", () => {
  it("parses a diff3 block with base, ours and theirs", () => {
    const { doc, blocks } = parse(
      [
        "<<<<<<< HEAD",
        "ours line",
        "||||||| base",
        "base line",
        "=======",
        "theirs line",
        ">>>>>>> branch",
      ].join("\n"),
    );
    expect(blocks).toHaveLength(1);
    const b = blocks[0];
    expect(b.index).toBe(1);
    expect(b.total).toBe(1);
    expect(b.baseMark).not.toBeNull();
    expect(slice(doc, b.oursFrom, b.oursTo)).toBe("ours line");
    expect(slice(doc, b.baseFrom, b.baseTo)).toBe("base line");
    expect(slice(doc, b.theirsFrom, b.theirsTo)).toBe("theirs line");
  });

  it("parses a 2-way block with no base", () => {
    const { doc, blocks } = parse(
      ["<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> x"].join("\n"),
    );
    expect(blocks).toHaveLength(1);
    const b = blocks[0];
    expect(b.baseMark).toBeNull();
    expect(b.baseTo).toBe(b.baseFrom);
    expect(slice(doc, b.oursFrom, b.oursTo)).toBe("ours");
    expect(slice(doc, b.theirsFrom, b.theirsTo)).toBe("theirs");
  });

  it("captures multiline sides and numbers multiple blocks", () => {
    const { doc, blocks } = parse(
      [
        "<<<<<<< HEAD",
        "a1",
        "a2",
        "=======",
        "b1",
        "b2",
        ">>>>>>> x",
        "middle",
        "<<<<<<< HEAD",
        "c",
        "=======",
        "d",
        ">>>>>>> y",
      ].join("\n"),
    );
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.index)).toEqual([1, 2]);
    expect(blocks.every((b) => b.total === 2)).toBe(true);
    expect(slice(doc, blocks[0].oursFrom, blocks[0].oursTo)).toBe("a1\na2");
    expect(slice(doc, blocks[0].theirsFrom, blocks[0].theirsTo)).toBe("b1\nb2");
  });

  it("ignores a malformed block with no separator", () => {
    const { blocks } = parse(["<<<<<<< HEAD", "ours", ">>>>>>> x"].join("\n"));
    expect(blocks).toHaveLength(0);
  });

  it("handles an empty incoming side", () => {
    const { doc, blocks } = parse(
      ["<<<<<<< HEAD", "ours", "=======", ">>>>>>> x"].join("\n"),
    );
    expect(blocks).toHaveLength(1);
    const b = blocks[0];
    expect(b.theirsTo).toBe(b.theirsFrom);
    expect(slice(doc, b.oursFrom, b.oursTo)).toBe("ours");
  });
});
