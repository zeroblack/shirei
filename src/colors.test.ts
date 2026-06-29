import { describe, expect, it } from "vitest";
import { apcaContrast, ensureContrast } from "./colors";

describe("apcaContrast", () => {
  it("reports near-maximum contrast for pure black and white", () => {
    expect(apcaContrast("#ffffff", "#000000")).toBeGreaterThan(100);
    expect(apcaContrast("#000000", "#ffffff")).toBeGreaterThan(100);
  });

  it("reports near-zero contrast for adjacent mid greys", () => {
    expect(apcaContrast("#777777", "#808080")).toBeLessThan(15);
  });

  it("rates pure red on pure black as borderline (below body threshold)", () => {
    const lc = apcaContrast("#ff0000", "#000000");
    expect(lc).toBeGreaterThan(25);
    expect(lc).toBeLessThan(45);
  });
});

describe("ensureContrast", () => {
  it("leaves an already-legible color untouched", () => {
    expect(ensureContrast("#ffffff", "#000000", "#ffffff", 45)).toBe("#ffffff");
  });

  it("lifts a low-contrast color until it clears the floor", () => {
    const fixed = ensureContrast("#ff0000", "#000000", "#ffffff", 45);
    expect(apcaContrast(fixed, "#000000")).toBeGreaterThanOrEqual(45);
  });

  it("works on light backgrounds by mixing toward the dark fg", () => {
    const fixed = ensureContrast("#ffff66", "#f5f5f5", "#1a1a1a", 45);
    expect(apcaContrast(fixed, "#f5f5f5")).toBeGreaterThanOrEqual(45);
  });

  it("returns a valid 6-digit hex", () => {
    const fixed = ensureContrast("#ff0000", "#000000", "#ffffff", 60);
    expect(fixed).toMatch(/^#[0-9a-f]{6}$/);
  });
});
