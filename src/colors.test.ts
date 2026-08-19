import { describe, expect, it } from "vitest";
import {
  apcaContrast,
  deriveGitColors,
  deriveStatusColors,
  ensureContrast,
  GIT_ROLES,
  mix,
  parseHex,
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
  // Mirrors `chromeFromTheme` in app.ts: the marks paint on --surface-1 in a
  // plain row and on --surface-2 once that row is selected, so a role's
  // colour is derived against surface-1 but has to stay legible on both.
  const terminals: { id: string; bg: string; fg: string }[] = [
    { id: "black", bg: "#000000", fg: "#ffffff" },
    ...THEMES.map((theme) => ({
      id: theme.id,
      bg: theme.terminal.bg,
      fg: theme.terminal.fg,
    })),
  ];
  const surface1 = (t: { bg: string; fg: string }) => mix(t.bg, t.fg, 0.06);
  const surface2 = (t: { bg: string; fg: string }) => mix(t.bg, t.fg, 0.1);

  it("clears its APCA floor on --surface-1 across every theme, in both directions", () => {
    for (const terminal of terminals) {
      const bg1 = surface1(terminal);
      const derived = deriveGitColors(bg1);
      for (const role of GIT_ROLES) {
        const colour = derived[role.token];
        expect(
          apcaContrast(colour, bg1),
          `${role.token} on ${terminal.id} --surface-1`,
        ).toBeGreaterThanOrEqual(role.minLc);
        expect(
          Math.abs(apcaContrast(terminal.bg, colour)),
          `${terminal.id} --bg knocked out of ${role.token}`,
        ).toBeGreaterThanOrEqual(45);
      }
    }
  });

  // Deriving against --surface-1 (spec §3) doesn't guarantee the same colour
  // clears its floor once a row is selected and repaints on the slightly
  // stronger --surface-2 — mixing further toward fg moves that background
  // closer to the mark's own lightness, which *lowers* contrast on every
  // theme measured here. This is a known, measured gap: the pairs below are
  // pinned exactly so a real fix (or a regression) shows up as a test
  // failure instead of silently drifting. Raising the anchor or the floor is
  // a design call, not something to paper over here.
  const KNOWN_SURFACE_2_GAPS = new Set([
    "black:--git-conflict",
    "pure-black:--git-conflict",
    "tokyo-night:--git-renamed",
    "tokyo-night:--git-deleted",
    "tokyo-night:--git-conflict",
    "catppuccin-mocha:--git-deleted",
    "catppuccin-mocha:--git-conflict",
    "catppuccin-latte:--git-modified",
    "catppuccin-latte:--git-new",
    "catppuccin-latte:--git-renamed",
    "catppuccin-latte:--git-deleted",
    "dracula:--git-modified",
    "dracula:--git-new",
    "dracula:--git-renamed",
    "dracula:--git-deleted",
    "dracula:--git-conflict",
    "nord:--git-modified",
    "nord:--git-new",
    "nord:--git-renamed",
    "nord:--git-deleted",
    "nord:--git-conflict",
    "gruvbox:--git-modified",
    "gruvbox:--git-new",
    "gruvbox:--git-renamed",
    "gruvbox:--git-deleted",
    "gruvbox:--git-conflict",
    "one-dark:--git-modified",
    "one-dark:--git-new",
    "one-dark:--git-renamed",
    "one-dark:--git-deleted",
    "one-dark:--git-conflict",
    "rose-pine:--git-renamed",
    "rose-pine:--git-deleted",
    "rose-pine:--git-conflict",
    "kanagawa:--git-deleted",
    "kanagawa:--git-conflict",
    "japan-night:--git-renamed",
    "japan-night:--git-deleted",
    "japan-night:--git-conflict",
  ]);

  it("clears its APCA floor on --surface-2 too, outside the documented gaps", () => {
    for (const terminal of terminals) {
      const derived = deriveGitColors(surface1(terminal));
      const bg2 = surface2(terminal);
      for (const role of GIT_ROLES) {
        const key = `${terminal.id}:${role.token}`;
        const lc = apcaContrast(derived[role.token], bg2);
        if (KNOWN_SURFACE_2_GAPS.has(key)) {
          expect(lc, key).toBeLessThan(role.minLc);
        } else {
          expect(lc, key).toBeGreaterThanOrEqual(role.minLc);
        }
      }
    }
  });

  it("keeps conflict a real red rather than washing it to pink", () => {
    const onBlack = deriveGitColors("#000000")["--git-conflict"];
    const [r, g, b] = parseHex(onBlack);
    expect(r).toBeGreaterThan(g + 60);
    expect(r).toBeGreaterThan(b + 60);
  });
});
