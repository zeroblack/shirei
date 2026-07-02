import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  eventToKeystroke,
  findConflicts,
  formatKeystroke,
  keystrokeId,
  resolveBindings,
} from "./keys";

const ev = (init: Partial<KeyboardEvent>): KeyboardEvent =>
  ({
    key: "",
    code: "",
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    ...init,
  }) as KeyboardEvent;

describe("keystroke", () => {
  it("lowercases letters and builds the canonical id", () => {
    const ks = eventToKeystroke(
      ev({ key: "T", code: "KeyT", metaKey: true, shiftKey: true }),
    );
    expect(ks).not.toBeNull();
    expect(ks && keystrokeId(ks)).toBe("meta+shift+t");
  });

  it("formats with macOS glyphs in ⌃⌥⇧⌘ order", () => {
    expect(formatKeystroke({ key: "t", meta: true, shift: true })).toBe("⇧⌘T");
    expect(formatKeystroke({ key: "ArrowLeft", meta: true })).toBe("⌘←");
    expect(formatKeystroke({ key: "=", meta: true })).toBe("⌘=");
  });

  it("ignores events without modifiers (not app shortcuts)", () => {
    expect(eventToKeystroke(ev({ key: "a", code: "KeyA" }))).toBeNull();
  });
});

describe("registry", () => {
  it("has unique ids and at least the core actions", () => {
    const ids = ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("tab.new");
    expect(ids).toContain("pane.split-h");
  });

  it("merge: override replaces the default; null unbinds", () => {
    const r = resolveBindings({
      "tab.new": [{ key: "n", meta: true }],
      "tab.close": null,
    });
    expect(keystrokeId(r["tab.new"][0])).toBe("meta+n");
    expect(r["tab.close"]).toEqual([]);
    expect(keystrokeId(r["pane.split-h"][0])).toBe("meta+d");
  });

  it("detects conflicts between two actions sharing a key with overlapping scope", () => {
    const c = findConflicts({ "tab.new": [{ key: "p", meta: true }] });
    const ids = c.map((x) => [x.a, x.b].sort().join("|"));
    expect(ids).toContain(["palette.open", "tab.new"].sort().join("|"));
  });

  it("finder.reveal does not clash with any default", () => {
    const involved = findConflicts({}).flatMap((c) => [c.a, c.b]);
    expect(involved).not.toContain("finder.reveal");
  });
});

describe("pane content actions", () => {
  const ids = new Set(ACTIONS.map((a) => a.id));

  it("registers the four content actions plus slot jumps", () => {
    expect(ids.has("pane.content.pick")).toBe(true);
    expect(ids.has("pane.content.cycle")).toBe(true);
    expect(ids.has("pane.content.close")).toBe(true);
    expect(ids.has("pane.content.slot-1")).toBe(true);
    expect(ids.has("pane.content.slot-2")).toBe(true);
    expect(ids.has("pane.content.slot-3")).toBe(true);
  });

  it("scopes content actions to the pane", () => {
    for (const id of [
      "pane.content.pick",
      "pane.content.cycle",
      "pane.content.close",
    ]) {
      expect(ACTIONS.find((a) => a.id === id)?.scope).toBe("pane");
    }
  });

  it("binds pick/cycle/close to meta+alt defaults", () => {
    const b = resolveBindings({});
    expect(b["pane.content.pick"]).toEqual([
      { key: "t", meta: true, alt: true },
    ]);
    expect(b["pane.content.cycle"]).toEqual([
      { key: "Enter", meta: true, alt: true },
    ]);
    expect(b["pane.content.close"]).toEqual([
      { key: "Backspace", meta: true, alt: true },
    ]);
  });
});
