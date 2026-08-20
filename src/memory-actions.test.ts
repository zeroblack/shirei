import { describe, expect, it } from "vitest";
import type { MemoryStatus } from "./config";
import {
  memoryBadgeState,
  promptLine,
  resolveTemplate,
  shouldAutosave,
  shouldBootstrapMemory,
} from "./memory-actions";
import type { SessionState } from "./sessionstate";

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
    overview_filled: true,
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

const working: SessionState = { kind: "working" };
const waiting: SessionState = { kind: "waiting", wait: "question" };
const done: SessionState = { kind: "done", code: 0 };

describe("shouldAutosave", () => {
  it("fires on the transition into done with high confidence", () => {
    expect(shouldAutosave(working, done, "high", undefined, 30, 0)).toBe(true);
  });
  it("does not fire on done with tentative confidence", () => {
    expect(shouldAutosave(working, done, "tentative", undefined, 30, 0)).toBe(
      false,
    );
  });
  it("never fires on waiting", () => {
    expect(shouldAutosave(working, waiting, "high", undefined, 30, 0)).toBe(
      false,
    );
  });
  it("does not fire again for a repeat done within the cooldown", () => {
    const cooldownMs = 30 * 60_000;
    expect(
      shouldAutosave(done, done, "high", 1_000, 30, 1_000 + cooldownMs - 1),
    ).toBe(false);
  });
  it("fires again once the cooldown has elapsed", () => {
    const cooldownMs = 30 * 60_000;
    expect(
      shouldAutosave(working, done, "high", 1_000, 30, 1_000 + cooldownMs),
    ).toBe(true);
  });
});

describe("resolveTemplate", () => {
  it("uses the override when it has content", () => {
    expect(resolveTemplate("Custom prompt", "Default prompt")).toBe(
      "Custom prompt",
    );
  });
  it("falls back when the override is whitespace only", () => {
    expect(resolveTemplate("   ", "Default prompt")).toBe("Default prompt");
  });
  it("falls back when the override is empty", () => {
    expect(resolveTemplate("", "Default prompt")).toBe("Default prompt");
  });
});

describe("shouldBootstrapMemory", () => {
  const absent = { exists: false, overview_filled: false };
  const emptySkeleton = { exists: true, overview_filled: false };
  const filledIn = { exists: true, overview_filled: true };

  it("fires on the transition into done with high confidence when memory is absent", () => {
    expect(
      shouldBootstrapMemory(true, absent, working, done, "high", false),
    ).toBe(true);
  });
  it("fires when memory exists but is only an empty skeleton", () => {
    // Opening memory with ⌘⇧Y creates overview.md with headings and no
    // prose: exists is true but the project still has nothing to resume.
    expect(
      shouldBootstrapMemory(true, emptySkeleton, working, done, "high", false),
    ).toBe(true);
  });
  it("does not fire twice for the same project", () => {
    expect(
      shouldBootstrapMemory(true, absent, working, done, "high", true),
    ).toBe(false);
  });
  it("never fires on waiting", () => {
    expect(
      shouldBootstrapMemory(true, absent, working, waiting, "high", false),
    ).toBe(false);
  });
  it("does not fire when memory exists and is filled in", () => {
    expect(
      shouldBootstrapMemory(true, filledIn, working, done, "high", false),
    ).toBe(false);
  });
  it("treats a null status (already seeded, never fetched) as filled", () => {
    expect(
      shouldBootstrapMemory(true, null, working, done, "high", false),
    ).toBe(false);
  });
  it("does not fire on an inactive tab", () => {
    expect(
      shouldBootstrapMemory(false, absent, working, done, "high", false),
    ).toBe(false);
  });
  it("does not fire on tentative confidence", () => {
    expect(
      shouldBootstrapMemory(true, absent, working, done, "tentative", false),
    ).toBe(false);
  });
});
