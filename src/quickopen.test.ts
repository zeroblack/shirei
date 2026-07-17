import { describe, expect, it, vi } from "vitest";
import { searchQuery, searchStart } from "./commands";
import { applyEvent, initialSearchState, QuickOpen } from "./quickopen";
import type { ScopeRoots } from "./searchscope";
import type { MatchItem, SearchEvent } from "./types";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: ((ev: unknown) => void) | undefined;
  },
}));

vi.mock("./commands", () => ({
  searchStart: vi.fn().mockResolvedValue(undefined),
  searchQuery: vi.fn().mockResolvedValue(undefined),
  searchClose: vi.fn().mockResolvedValue(undefined),
  recordOpen: vi.fn().mockResolvedValue(undefined),
}));

interface QuickOpenInternals {
  roots: ScopeRoots;
  generation: number;
  renderList: () => void;
  startSearch(): void;
  runQuery(query: string): void;
}

function matchItem(rel: string): MatchItem {
  return { rel, name: rel, is_dir: false, positions: [] };
}

function resultsEvent(generation: number, rel: string): SearchEvent {
  return {
    kind: "results",
    generation,
    items: [matchItem(rel)],
    partial: false,
  };
}

describe("applyEvent", () => {
  it("drops results from a stale generation (E11)", () => {
    let state = applyEvent(initialSearchState, resultsEvent(1, "gen1.ts"), 1);
    state = applyEvent(state, resultsEvent(2, "gen2.ts"), 2);
    state = applyEvent(state, resultsEvent(1, "late-gen1.ts"), 2);

    expect(state.items.map((item) => item.rel)).toEqual(["gen2.ts"]);
  });

  it("marks indexing in progress and records the running count", () => {
    const state = applyEvent(
      initialSearchState,
      { kind: "indexing", count: 42 },
      1,
    );

    expect(state.indexing).toBe(true);
    expect(state.indexingCount).toBe(42);
  });

  it("clears indexing and stores the partial flag on done", () => {
    const indexing = applyEvent(
      initialSearchState,
      { kind: "indexing", count: 10 },
      1,
    );
    const done = applyEvent(
      indexing,
      { kind: "done", total: 10, partial: true },
      1,
    );

    expect(done.indexing).toBe(false);
    expect(done.partial).toBe(true);
  });
});

describe("QuickOpen generation contract", () => {
  it("reuses the session generation for keystroke queries, does not bump it", () => {
    const qo = new QuickOpen({
      onOpenFile: () => {},
      onRevealDir: () => {},
      onOpenProject: () => {},
    }) as unknown as QuickOpenInternals;
    qo.roots = {
      project: "/tmp/project",
      home: "/tmp/home",
      projectLabel: "test",
      projectColor: null,
    };
    qo.renderList = () => {};

    qo.startSearch();
    const sessionGeneration = qo.generation;

    expect(searchStart).toHaveBeenCalledTimes(1);
    expect(searchQuery).toHaveBeenLastCalledWith(sessionGeneration, "");

    qo.runQuery("index");

    expect(qo.generation).toBe(sessionGeneration);
    expect(searchQuery).toHaveBeenLastCalledWith(sessionGeneration, "index");
  });
});
