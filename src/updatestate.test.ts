import { describe, expect, it } from "vitest";
import { isNewer } from "./updatestate";

describe("isNewer", () => {
  it("true when candidate is a higher version", () => {
    expect(isNewer("0.14.2", "0.14.3")).toBe(true);
    expect(isNewer("0.14.2", "0.15.0")).toBe(true);
    expect(isNewer("0.9.9", "0.10.0")).toBe(true);
  });
  it("false when equal or lower", () => {
    expect(isNewer("0.14.2", "0.14.2")).toBe(false);
    expect(isNewer("0.14.2", "0.14.1")).toBe(false);
    expect(isNewer("0.15.0", "0.14.9")).toBe(false);
  });
});
