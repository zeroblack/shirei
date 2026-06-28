import { SearchQuery, search, setSearchQuery } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { matchStats } from "./editor-search";

function stateWith(
  doc: string,
  query: SearchQuery,
  sel?: { anchor: number; head: number },
): EditorState {
  const base = EditorState.create({
    doc,
    selection: sel,
    extensions: [search()],
  });
  return base.update({ effects: setSearchQuery.of(query) }).state;
}

describe("matchStats", () => {
  it("counts every occurrence of the query", () => {
    const s = stateWith(
      "foo bar foo baz foo",
      new SearchQuery({ search: "foo" }),
    );
    expect(matchStats(s).count).toBe(3);
  });

  it("reports the current index from the active selection", () => {
    const s = stateWith(
      "foo bar foo baz foo",
      new SearchQuery({ search: "foo" }),
      {
        anchor: 8,
        head: 11,
      },
    );
    const stats = matchStats(s);
    expect(stats.current).toBe(2);
    expect(stats.count).toBe(3);
  });

  it("returns zero for an empty query", () => {
    const s = stateWith("foo bar", new SearchQuery({ search: "" }));
    expect(matchStats(s).count).toBe(0);
  });

  it("returns zero when nothing matches", () => {
    const s = stateWith("foo bar", new SearchQuery({ search: "zzz" }));
    expect(matchStats(s)).toEqual({ count: 0, current: 0, valid: true });
  });

  it("flags an invalid regular expression instead of throwing", () => {
    const s = stateWith("foo", new SearchQuery({ search: "(", regexp: true }));
    expect(matchStats(s).valid).toBe(false);
  });

  it("respects case sensitivity", () => {
    const s = stateWith(
      "Foo foo FOO",
      new SearchQuery({ search: "foo", caseSensitive: true }),
    );
    expect(matchStats(s).count).toBe(1);
  });
});
