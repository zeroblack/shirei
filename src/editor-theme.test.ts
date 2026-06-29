import { describe, expect, it } from "vitest";
import { apcaContrast } from "./colors";
import type { TerminalColors } from "./config";
import { editorSyntaxColors, type SyntaxRole } from "./editor-theme";

const pureBlack: TerminalColors = {
  bg: "#000000",
  fg: "#ffffff",
  cursor: "#ffffff",
  black: "#000000",
  red: "#e5484d",
  green: "#30a46c",
  yellow: "#f5d90a",
  blue: "#1d4ed8",
  magenta: "#8e4ec6",
  cyan: "#00b8d4",
  white: "#d7d7d7",
  brightBlack: "#444444",
  brightRed: "#ff6369",
  brightGreen: "#4cc38a",
  brightYellow: "#ffe629",
  brightBlue: "#3b82f6",
  brightMagenta: "#bf7af0",
  brightCyan: "#4cc6e8",
  brightWhite: "#ffffff",
};

const latte: TerminalColors = {
  ...pureBlack,
  bg: "#eff1f5",
  fg: "#4c4f69",
  cursor: "#4c4f69",
  yellow: "#df8e1d",
  green: "#40a02b",
  brightYellow: "#fee293",
};

describe("editorSyntaxColors", () => {
  it("provides a color for every core token role", () => {
    const c = editorSyntaxColors(pureBlack);
    const roles: SyntaxRole[] = [
      "keyword",
      "string",
      "number",
      "function",
      "type",
      "variable",
      "operator",
      "comment",
      "tag",
      "attribute",
    ];
    for (const role of roles) {
      expect(c[role]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  const primary: SyntaxRole[] = [
    "keyword",
    "string",
    "number",
    "function",
    "type",
    "tag",
  ];

  it("keeps primary tokens legible on pure black (clamping dark palette colors)", () => {
    const c = editorSyntaxColors(pureBlack);
    for (const role of primary) {
      expect(apcaContrast(c[role], pureBlack.bg)).toBeGreaterThanOrEqual(45);
    }
  });

  it("keeps primary tokens legible on a light theme", () => {
    const c = editorSyntaxColors(latte);
    for (const role of primary) {
      expect(apcaContrast(c[role], latte.bg)).toBeGreaterThanOrEqual(45);
    }
  });

  it("renders comments dimmer than keywords but still visible", () => {
    const c = editorSyntaxColors(pureBlack);
    const comment = apcaContrast(c.comment, pureBlack.bg);
    const keyword = apcaContrast(c.keyword, pureBlack.bg);
    expect(comment).toBeGreaterThan(15);
    expect(comment).toBeLessThan(keyword);
  });
});
