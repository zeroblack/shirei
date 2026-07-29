import { describe, expect, it } from "vitest";
import { navIcon } from "./nav-icons";

describe("navIcon", () => {
  it("gives the focus section the lucide timer glyph, not a bare circle", () => {
    const icon = navIcon("focus");
    expect(icon).toContain("<line");
    expect(icon).toContain('cy="14"');
  });

  it("wraps every glyph in a consistent 16x16 currentColor svg", () => {
    const icon = navIcon("focus");
    expect(icon).toMatch(/^<svg viewBox="0 0 24 24" width="16" height="16"/);
    expect(icon).toContain('stroke="currentColor"');
  });

  it("returns an empty svg for an unknown section id", () => {
    const icon = navIcon("does-not-exist");
    expect(icon).toBe(
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"></svg>',
    );
  });
});
