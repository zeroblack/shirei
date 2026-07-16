import { describe, expect, it } from "vitest";
import { isClaudeCommand, withClaudeResume } from "./claude-cmd";

describe("isClaudeCommand", () => {
  it("matches only claude as the program", () => {
    expect(isClaudeCommand("claude")).toBe(true);
    expect(isClaudeCommand("  claude --resume ")).toBe(true);
    expect(isClaudeCommand("claudia")).toBe(false);
    expect(isClaudeCommand("npx claude")).toBe(false);
    expect(isClaudeCommand(undefined)).toBe(false);
  });
});

describe("withClaudeResume", () => {
  it("adds --resume to a bare claude command", () => {
    expect(withClaudeResume("claude")).toBe("claude --resume");
  });

  it("leaves an existing resume flag alone", () => {
    expect(withClaudeResume("claude --resume")).toBe("claude --resume");
    expect(withClaudeResume("claude -r")).toBe("claude -r");
  });

  // A snapshot written before --resume was the rule respawns verbatim, so a
  // persisted --continue must be rewritten or it survives every restore.
  it("rewrites a persisted --continue into --resume", () => {
    expect(withClaudeResume("claude --continue")).toBe("claude --resume");
    expect(withClaudeResume("claude -c")).toBe("claude --resume");
  });

  it("keeps other flags while swapping continue for resume", () => {
    expect(withClaudeResume("claude --continue --verbose")).toBe(
      "claude --verbose --resume",
    );
  });
});
