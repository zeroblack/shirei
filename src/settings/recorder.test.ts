import { describe, expect, it } from "vitest";
import { captureKeystroke } from "./recorder";

const ev = (init: Partial<KeyboardEvent>): KeyboardEvent =>
  ({
    key: "",
    code: "",
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    preventDefault() {},
    ...init,
  }) as KeyboardEvent;

describe("captureKeystroke", () => {
  it("ignores bare modifier keys", () => {
    expect(captureKeystroke(ev({ key: "Shift", metaKey: true }))).toBeNull();
  });

  it("requires at least one modifier", () => {
    expect(captureKeystroke(ev({ key: "t" }))).toBeNull();
    expect(captureKeystroke(ev({ key: "t", metaKey: true }))).toEqual({
      key: "t",
      meta: true,
    });
  });
});
