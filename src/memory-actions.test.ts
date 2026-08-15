import { describe, expect, it } from "vitest";
import { promptLine } from "./memory-actions";

describe("promptLine", () => {
  it("submits the prompt as one typed line", () => {
    expect(promptLine("  Read memory  ")).toBe("Read memory\r");
  });
  it("collapses inner newlines so multi-line config never half-submits", () => {
    expect(promptLine("a\nb")).toBe("a b\r");
  });
});
