import { describe, expect, it } from "vitest";
import { rgbaFrom } from "./terminal";

describe("rgbaFrom", () => {
  it("converts a 6-digit hex to rgba", () => {
    expect(rgbaFrom("#1e1e2e", 0.25)).toBe("rgba(30, 30, 46, 0.25)");
  });

  it("is case-insensitive", () => {
    expect(rgbaFrom("#EFF1F5", 0.12)).toBe("rgba(239, 241, 245, 0.12)");
  });

  it("falls back to white-alpha for non-hex input", () => {
    expect(rgbaFrom("hsl(0, 0%, 100%)", 0.5)).toBe("rgba(255, 255, 255, 0.5)");
  });

  it("falls back for a 3-digit hex shorthand", () => {
    expect(rgbaFrom("#fff", 0.2)).toBe("rgba(255, 255, 255, 0.2)");
  });

  it("falls back for an empty string", () => {
    expect(rgbaFrom("", 0.1)).toBe("rgba(255, 255, 255, 0.1)");
  });
});
