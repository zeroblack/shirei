import { describe, expect, it } from "vitest";
import {
  apcaContrast,
  deriveGitColors,
  deriveStatusColors,
  ensureContrast,
  GIT_ROLES,
  hexToRgb,
} from "./colors";
import { THEMES } from "./settings/themes";

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

describe("deriveStatusColors", () => {
  const backgrounds = ["#000000", ...THEMES.map((theme) => theme.terminal.bg)];

  it.each(backgrounds)("clears the status floor against %s", (bg) => {
    const roles = deriveStatusColors(bg);
    for (const [token, hex] of Object.entries(roles)) {
      expect(apcaContrast(hex, bg), `${token} on ${bg}`).toBeGreaterThanOrEqual(
        42,
      );
    }
  });

  it("returns valid 6-digit hex for every role", () => {
    const roles = deriveStatusColors("#000000");
    for (const hex of Object.values(roles))
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("lifts the error hairline on pure black toward the ~0.67 lightness the spec calls for", () => {
    const roles = deriveStatusColors("#000000");
    const baseErrorLc = apcaContrast("#ed4a49", "#000000");
    const derivedErrorLc = apcaContrast(roles["--status-error"], "#000000");
    expect(derivedErrorLc).toBeGreaterThan(baseErrorLc);
    expect(derivedErrorLc).toBeGreaterThanOrEqual(42);
  });

  it("leaves an already-legible role untouched", () => {
    const roles = deriveStatusColors("#000000");
    expect(roles["--status-waiting"]).toBe("#edb333");
  });
});

describe("git role colours", () => {
  const backgrounds = ["#000000", ...THEMES.map((theme) => theme.terminal.bg)];

  it("clears its APCA floor on every theme, in both directions", () => {
    for (const bg of backgrounds) {
      const derived = deriveGitColors(bg);
      for (const role of GIT_ROLES) {
        const colour = derived[role.token];
        expect(
          Math.abs(apcaContrast(colour, bg)),
          `${role.token} on ${bg}`,
        ).toBeGreaterThanOrEqual(role.minLc);
        expect(
          Math.abs(apcaContrast(bg, colour)),
          `${bg} knocked out of ${role.token}`,
        ).toBeGreaterThanOrEqual(45);
      }
    }
  });

  it("keeps conflict a real red rather than washing it to pink", () => {
    const onBlack = deriveGitColors("#000000")["--git-conflict"];
    const [r, g, b] = hexToRgb(onBlack);
    expect(r).toBeGreaterThan(g + 60);
    expect(r).toBeGreaterThan(b + 60);
  });
});
