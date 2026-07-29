import { describe, expect, it } from "vitest";
import { apcaContrast, deriveStatusColors } from "../colors";
import { deriveTimerColors, fillColorFor } from "./theme";

const BLACK = "#000000";
const TIMER_MIN_LC = 15;

describe("deriveTimerColors", () => {
  it("clears the timer floor for every sumi role against black", () => {
    const roles = deriveTimerColors(BLACK, "sumi", {});
    for (const [role, hex] of Object.entries(roles)) {
      expect(apcaContrast(hex, BLACK), role).toBeGreaterThanOrEqual(
        TIMER_MIN_LC,
      );
    }
  });

  it("returns valid 6-digit hex for every sumi role", () => {
    const roles = deriveTimerColors(BLACK, "sumi", {});
    for (const hex of Object.values(roles))
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("returns an override for focus verbatim", () => {
    const roles = deriveTimerColors(BLACK, "sumi", { focus: "#123456" });
    expect(roles.focus).toBe("#123456");
  });

  it("leaves the other roles derived when only focus is overridden", () => {
    const base = deriveTimerColors(BLACK, "sumi", {});
    const overridden = deriveTimerColors(BLACK, "sumi", {
      focus: "#123456",
    });
    expect(overridden.break).toBe(base.break);
    expect(overridden.overflow).toBe(base.overflow);
    expect(overridden.track).toBe(base.track);
    expect(overridden.field).toBe(base.field);
  });

  it("maps signal's focus/break/overflow onto the app status ramp", () => {
    const roles = deriveTimerColors(BLACK, "signal", {});
    const status = deriveStatusColors(BLACK);
    expect(roles.focus).toBe(status["--status-working"]);
    expect(roles.break).toBe(status["--status-done"]);
  });

  it("clears the timer floor for every role across every skin", () => {
    for (const skinId of [
      "sumi",
      "hinode",
      "shinya",
      "kasumi",
      "mori",
      "signal",
    ]) {
      const roles = deriveTimerColors(BLACK, skinId, {});
      for (const [role, hex] of Object.entries(roles)) {
        expect(
          apcaContrast(hex, BLACK),
          `${skinId}.${role}`,
        ).toBeGreaterThanOrEqual(TIMER_MIN_LC);
      }
    }
  });

  it("falls back to sumi for an unknown skin id", () => {
    const roles = deriveTimerColors(BLACK, "not-a-skin", {});
    const sumi = deriveTimerColors(BLACK, "sumi", {});
    expect(roles).toEqual(sumi);
  });
});

function rgbHexFromRgba(rgba: string): string {
  const match = rgba.match(/rgba\((\d+), (\d+), (\d+),/);
  if (!match) throw new Error(`not an rgba() paint: ${rgba}`);
  const [, r, g, b] = match;
  const toByteHex = (v: string): string =>
    Number(v).toString(16).padStart(2, "0");
  return `#${toByteHex(r)}${toByteHex(g)}${toByteHex(b)}`;
}

function alphaFromRgba(rgba: string): number {
  const match = rgba.match(/,\s*([\d.]+)\)$/);
  if (!match) throw new Error(`not an rgba() paint: ${rgba}`);
  return Number(match[1]);
}

describe("fillColorFor", () => {
  it("returns a derived rgba paint, not the raw role color, for sumi focus", () => {
    const roles = deriveTimerColors(BLACK, "sumi", {});
    const fill = fillColorFor(roles.focus, roles.track);
    expect(fill).not.toBe(roles.focus);
    expect(fill).toMatch(/^rgba\(\d+, \d+, \d+, [\d.]+\)$/);
  });

  it("reduces alpha below full opacity so the fill recedes on a large area", () => {
    const roles = deriveTimerColors(BLACK, "sumi", {});
    const fill = fillColorFor(roles.focus, roles.track);
    expect(alphaFromRgba(fill)).toBeLessThan(1);
  });

  it("is perceptually lighter-load than the raw ring stroke against black", () => {
    const roles = deriveTimerColors(BLACK, "sumi", {});
    const fill = fillColorFor(roles.focus, roles.track);
    const fillHex = rgbHexFromRgba(fill);
    expect(apcaContrast(fillHex, BLACK)).toBeLessThan(
      apcaContrast(roles.focus, BLACK),
    );
  });

  it("mixes toward the darker track role for break and overflow too", () => {
    const roles = deriveTimerColors(BLACK, "sumi", {});
    for (const role of ["break", "overflow"] as const) {
      const fill = fillColorFor(roles[role], roles.track);
      const fillHex = rgbHexFromRgba(fill);
      expect(apcaContrast(fillHex, BLACK)).toBeLessThan(
        apcaContrast(roles[role], BLACK),
      );
    }
  });
});
