import { describe, expect, it } from "vitest";
import { SECTION_LAYOUT } from "./registry";

describe("SECTION_LAYOUT", () => {
  it("home is first and about exists; general is gone", () => {
    const ids = SECTION_LAYOUT.map((s) => s.id);
    expect(ids[0]).toBe("home");
    expect(ids).toContain("about");
    expect(ids).toContain("appearance");
    expect(ids).not.toContain("general");
  });

  it("every section has a group", () => {
    expect(SECTION_LAYOUT.every((s) => s.group.length > 0)).toBe(true);
  });
});
