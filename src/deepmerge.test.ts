import { describe, expect, it } from "vitest";
import { assignDeep } from "./deepmerge";

describe("assignDeep", () => {
  it("updates nested values while preserving object references", () => {
    const target = {
      font: { size: 16 },
      theme: { terminal: { fg: "#fff", bg: "#000" } },
    };
    const fontRef = target.font;
    const terminalRef = target.theme.terminal;

    assignDeep(target, {
      font: { size: 19 },
      theme: { terminal: { fg: "#00f", bg: "#000" } },
    });

    expect(target.font).toBe(fontRef);
    expect(target.theme.terminal).toBe(terminalRef);
    expect(target.font.size).toBe(19);
    expect(target.theme.terminal.fg).toBe("#00f");
  });

  it("overwrites arrays instead of merging them", () => {
    const target = { projects: [{ id: "a" }] };
    assignDeep(target, { projects: [{ id: "b" }, { id: "c" }] });
    expect(target.projects).toEqual([{ id: "b" }, { id: "c" }]);
  });

  it("adds keys that are absent on the target", () => {
    const target: Record<string, unknown> = {};
    assignDeep(target, { locale: "es" });
    expect(target.locale).toBe("es");
  });
});
