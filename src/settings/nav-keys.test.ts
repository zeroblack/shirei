import { describe, expect, it } from "vitest";
import { nextSectionIndex } from "./nav-keys";

describe("nextSectionIndex", () => {
  it("ArrowDown / j avanzan con wrap al inicio", () => {
    expect(nextSectionIndex(5, 0, "ArrowDown")).toBe(1);
    expect(nextSectionIndex(5, 4, "ArrowDown")).toBe(0);
    expect(nextSectionIndex(5, 2, "j")).toBe(3);
  });
  it("ArrowUp / k retroceden con wrap al final", () => {
    expect(nextSectionIndex(5, 1, "ArrowUp")).toBe(0);
    expect(nextSectionIndex(5, 0, "ArrowUp")).toBe(4);
    expect(nextSectionIndex(5, 3, "k")).toBe(2);
  });
  it("Home / End van a los extremos", () => {
    expect(nextSectionIndex(5, 3, "Home")).toBe(0);
    expect(nextSectionIndex(5, 1, "End")).toBe(4);
  });
  it("otras teclas no mueven", () => {
    expect(nextSectionIndex(5, 2, "Tab")).toBe(2);
    expect(nextSectionIndex(5, 2, "a")).toBe(2);
  });
  it("lista vacía devuelve -1", () => {
    expect(nextSectionIndex(0, 0, "ArrowDown")).toBe(-1);
  });
});
