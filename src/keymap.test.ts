import { describe, expect, it } from "vitest";
import { Keymap } from "./keymap";

describe("Keymap", () => {
  it("resolves a global action via its default", () => {
    const km = new Keymap({});
    const ks = { key: "t", meta: true };
    expect(km.resolve(ks, { pane: false })).toBe("tab.new");
  });

  it("pane actions only fire with pane scope active", () => {
    const km = new Keymap({});
    const ks = { key: "d", meta: true };
    expect(km.resolve(ks, { pane: false })).toBeNull();
    expect(km.resolve(ks, { pane: true })).toBe("pane.split-h");
  });

  it("⌘= and ⌘+ (shift) resolve font.inc", () => {
    const km = new Keymap({});
    expect(km.resolve({ key: "=", meta: true }, { pane: false })).toBe(
      "font.inc",
    );
    expect(
      km.resolve({ key: "=", meta: true, shift: true }, { pane: false }),
    ).toBe("font.inc");
  });

  it("⌘C and ⌘V resolve terminal actions only in pane scope", () => {
    const km = new Keymap({});
    expect(km.resolve({ key: "c", meta: true }, { pane: true })).toBe(
      "terminal.copy-line",
    );
    expect(km.resolve({ key: "c", meta: true }, { pane: false })).toBeNull();
    expect(km.resolve({ key: "v", meta: true }, { pane: true })).toBe(
      "terminal.paste",
    );
  });

  it("⌘⇧V resolves the vim toggle globally", () => {
    const km = new Keymap({});
    expect(
      km.resolve({ key: "v", meta: true, shift: true }, { pane: false }),
    ).toBe("editor.vim-toggle");
  });

  it("honors overrides", () => {
    const km = new Keymap({ "tab.new": [{ key: "n", meta: true }] });
    expect(km.resolve({ key: "t", meta: true }, { pane: false })).toBeNull();
    expect(km.resolve({ key: "n", meta: true }, { pane: false })).toBe(
      "tab.new",
    );
  });
});
