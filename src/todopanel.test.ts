import { describe, expect, it } from "vitest";
import { decideTodoFocusAction } from "./todopanel";

describe("decideTodoFocusAction", () => {
  it("expands and focuses when the panel is collapsed", () => {
    expect(decideTodoFocusAction(true, false)).toBe("expand-and-focus");
    expect(decideTodoFocusAction(true, true)).toBe("expand-and-focus");
  });

  it("focuses when expanded and unfocused", () => {
    expect(decideTodoFocusAction(false, false)).toBe("focus");
  });

  it("does nothing when expanded and already focused", () => {
    expect(decideTodoFocusAction(false, true)).toBe("noop");
  });
});
