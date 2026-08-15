import { describe, expect, it } from "vitest";
import type { MemoryStatus } from "./config";
import { memoryBadgeState, promptLine } from "./memory-actions";

describe("promptLine", () => {
  it("submits the prompt as one typed line", () => {
    expect(promptLine("  Read memory  ")).toBe("Read memory\r");
  });
  it("collapses inner newlines so multi-line config never half-submits", () => {
    expect(promptLine("a\nb")).toBe("a b\r");
  });
});

function status(overrides: Partial<MemoryStatus>): MemoryStatus {
  return {
    exists: true,
    overview_updated: null,
    stale: false,
    stale_reason: null,
    sessions_count: 0,
    resume_age_hours: null,
    ...overrides,
  };
}

describe("memoryBadgeState", () => {
  it("is undefined when memory does not exist", () => {
    expect(memoryBadgeState(status({ exists: false }), 24)).toBeUndefined();
  });
  it("is undefined when there is no status", () => {
    expect(memoryBadgeState(null, 24)).toBeUndefined();
  });
  it("is ok when memory exists and is fresh", () => {
    expect(memoryBadgeState(status({}), 24)).toBe("ok");
  });
  it("is stale when memory-core marks it stale", () => {
    expect(memoryBadgeState(status({ stale: true }), 24)).toBe("stale");
  });
  it("is stale when resume age exceeds the app's threshold", () => {
    expect(memoryBadgeState(status({ resume_age_hours: 25 }), 24)).toBe(
      "stale",
    );
  });
  it("is ok when resume age is within the app's threshold", () => {
    expect(memoryBadgeState(status({ resume_age_hours: 24 }), 24)).toBe("ok");
  });
});
