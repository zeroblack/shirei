import { describe, expect, it } from "vitest";
import type { FontsConfig } from "./config";
import { fontFamilyName, fontStack } from "./fonts";

const fonts: FontsConfig = {
  release_tag: "v3.4.0",
  catalog: [
    { id: "meslo", label: "Meslo", kind: "builtin" },
    {
      id: "firacode",
      label: "Fira Code",
      kind: "download",
      asset: "FiraCode",
      glyph_pattern: "*NerdFontMono-Regular.ttf",
    },
  ],
};

describe("fontStack", () => {
  it("builds a stack ending in the SF Mono fallback", () => {
    expect(fontStack("firacode", fonts)).toContain(
      '"Menlo", "SF Mono", monospace',
    );
  });

  it("uses the builtin css family name for builtins", () => {
    expect(fontStack("meslo", fonts).startsWith('"Meslo"')).toBe(true);
  });

  it("falls back to default family for an unknown id", () => {
    expect(fontStack("ghost", fonts)).toContain('"SF Mono", monospace');
  });
});

describe("fontFamilyName", () => {
  it("returns the registerable family name for a download font", () => {
    expect(fontFamilyName("firacode", fonts)).toBe("FiraCode Nerd Font Mono");
  });
});
