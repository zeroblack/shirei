import { describe, expect, it } from "vitest";
import {
  applyKittySequence,
  encodeKey,
  KITTY_ALL_AS_ESCAPE,
  KITTY_ALTERNATE_KEYS,
  KITTY_ASSOCIATED_TEXT,
  KITTY_DISAMBIGUATE,
  KITTY_EVENT_TYPES,
  KittyKeyboardState,
} from "./kitty-keyboard";

function ev(over: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    type: "keydown",
    code: "",
    repeat: false,
    isComposing: false,
    keyCode: 0,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    getModifierState: () => false,
    ...over,
  } as KeyboardEvent;
}

const DIS = KITTY_DISAMBIGUATE;

describe("KittyKeyboardState", () => {
  it("starts at 0 and answers the query", () => {
    const s = new KittyKeyboardState();
    expect(s.current()).toBe(0);
    expect(applyKittySequence(s, "?", [])).toBe("\x1b[?0u");
  });

  it("push sets the flags as current and the query reflects them", () => {
    const s = new KittyKeyboardState();
    applyKittySequence(s, ">", [1]);
    expect(s.current()).toBe(1);
    expect(applyKittySequence(s, "?", [])).toBe("\x1b[?1u");
  });

  it("pop restores the previous value (default 1 entry)", () => {
    const s = new KittyKeyboardState();
    applyKittySequence(s, ">", [5]);
    applyKittySequence(s, ">", [9]);
    applyKittySequence(s, "<", []);
    expect(s.current()).toBe(5);
  });

  it("set mode 1 replaces, 2 adds, 3 removes", () => {
    const s = new KittyKeyboardState();
    applyKittySequence(s, "=", [1, 1]);
    expect(s.current()).toBe(1);
    applyKittySequence(s, "=", [4, 2]);
    expect(s.current()).toBe(5);
    applyKittySequence(s, "=", [1, 3]);
    expect(s.current()).toBe(4);
  });

  it("ignores bits outside the known flag range", () => {
    const s = new KittyKeyboardState();
    applyKittySequence(s, ">", [999]);
    expect(s.current()).toBe(999 & 31);
  });

  it("never pops below the base value", () => {
    const s = new KittyKeyboardState();
    applyKittySequence(s, "<", [10]);
    expect(s.current()).toBe(0);
  });
});

describe("encodeKey — plain text", () => {
  it("an unmodified letter passes through as raw text", () => {
    expect(encodeKey(ev({ key: "a", code: "KeyA" }), DIS)).toBe("a");
  });

  it("shift+letter passes through as the uppercase character", () => {
    expect(encodeKey(ev({ key: "A", code: "KeyA", shiftKey: true }), DIS)).toBe(
      "A",
    );
  });

  it("unmodified space passes through raw", () => {
    expect(encodeKey(ev({ key: " ", code: "Space" }), DIS)).toBe(" ");
  });
});

describe("encodeKey — modified keys", () => {
  it("ctrl+a", () => {
    expect(encodeKey(ev({ key: "a", code: "KeyA", ctrlKey: true }), DIS)).toBe(
      "\x1b[97;5u",
    );
  });

  it("alt+a", () => {
    expect(encodeKey(ev({ key: "a", code: "KeyA", altKey: true }), DIS)).toBe(
      "\x1b[97;3u",
    );
  });

  it("ctrl+shift+a", () => {
    expect(
      encodeKey(
        ev({ key: "a", code: "KeyA", ctrlKey: true, shiftKey: true }),
        DIS,
      ),
    ).toBe("\x1b[97;6u");
  });
});

describe("encodeKey — functional keys", () => {
  it("disambiguated Escape", () => {
    expect(encodeKey(ev({ key: "Escape" }), DIS)).toBe("\x1b[27u");
  });

  it("Enter, Tab and Backspace keep their legacy byte when unmodified", () => {
    expect(encodeKey(ev({ key: "Enter" }), DIS)).toBe("\r");
    expect(encodeKey(ev({ key: "Tab" }), DIS)).toBe("\t");
    expect(encodeKey(ev({ key: "Backspace" }), DIS)).toBe("\x7f");
  });

  it("ctrl+Enter and shift+Tab do get escaped", () => {
    expect(encodeKey(ev({ key: "Enter", ctrlKey: true }), DIS)).toBe(
      "\x1b[13;5u",
    );
    expect(encodeKey(ev({ key: "Tab", shiftKey: true }), DIS)).toBe(
      "\x1b[9;2u",
    );
  });

  it("arrows: unmodified omit the 1, modified restore it", () => {
    expect(encodeKey(ev({ key: "ArrowUp" }), DIS)).toBe("\x1b[A");
    expect(encodeKey(ev({ key: "ArrowUp", shiftKey: true }), DIS)).toBe(
      "\x1b[1;2A",
    );
  });

  it("Home and End use the letter terminator", () => {
    expect(encodeKey(ev({ key: "Home" }), DIS)).toBe("\x1b[H");
    expect(encodeKey(ev({ key: "End" }), DIS)).toBe("\x1b[F");
  });

  it("F1/F3/F5 follow the kitty table", () => {
    expect(encodeKey(ev({ key: "F1" }), DIS)).toBe("\x1b[P");
    expect(encodeKey(ev({ key: "F3" }), DIS)).toBe("\x1b[13~");
    expect(encodeKey(ev({ key: "F5" }), DIS)).toBe("\x1b[15~");
  });

  it("Insert/Delete/PageUp use the tilde terminator", () => {
    expect(encodeKey(ev({ key: "Insert" }), DIS)).toBe("\x1b[2~");
    expect(encodeKey(ev({ key: "Delete" }), DIS)).toBe("\x1b[3~");
    expect(encodeKey(ev({ key: "PageUp" }), DIS)).toBe("\x1b[5~");
  });
});

describe("encodeKey — event types (flag 2)", () => {
  it("without flag 2, the release is swallowed", () => {
    expect(encodeKey(ev({ key: "ArrowUp", type: "keyup" }), DIS)).toBe("");
  });

  it("with flag 2, release and repeat are reported", () => {
    const flags = DIS | KITTY_EVENT_TYPES;
    expect(encodeKey(ev({ key: "ArrowUp", type: "keyup" }), flags)).toBe(
      "\x1b[1;1:3A",
    );
    expect(encodeKey(ev({ key: "ArrowUp", repeat: true }), flags)).toBe(
      "\x1b[1;1:2A",
    );
  });
});

describe("encodeKey — alternate keys (flag 4)", () => {
  it("includes the shifted key when it differs", () => {
    const flags = DIS | KITTY_ALTERNATE_KEYS;
    expect(
      encodeKey(
        ev({ key: "a", code: "KeyA", ctrlKey: true, shiftKey: true }),
        flags,
      ),
    ).toBe("\x1b[97:65;6u");
  });
});

describe("encodeKey — associated text (flag 16) and report-all (flag 8)", () => {
  it("report-all sends even letters as escapes", () => {
    expect(
      encodeKey(ev({ key: "a", code: "KeyA" }), DIS | KITTY_ALL_AS_ESCAPE),
    ).toBe("\x1b[97u");
  });

  it("associated text attaches the text codepoints", () => {
    const flags = DIS | KITTY_ALL_AS_ESCAPE | KITTY_ASSOCIATED_TEXT;
    expect(
      encodeKey(ev({ key: "A", code: "KeyA", shiftKey: true }), flags),
    ).toBe("\x1b[97;2;65u");
  });

  it("modifier keys are only reported with report-all", () => {
    expect(encodeKey(ev({ key: "Shift", code: "ShiftLeft" }), DIS)).toBe("");
    expect(
      encodeKey(
        ev({ key: "Shift", code: "ShiftLeft" }),
        DIS | KITTY_ALL_AS_ESCAPE,
      ),
    ).toBe("\x1b[57441u");
  });
});

describe("encodeKey — special cases", () => {
  it("during IME composition it defers to xterm (null)", () => {
    expect(encodeKey(ev({ key: "a", isComposing: true }), DIS)).toBeNull();
    expect(encodeKey(ev({ key: "Process", keyCode: 229 }), DIS)).toBeNull();
  });

  it("without disambiguate or report-all, a modified key defers to xterm", () => {
    expect(
      encodeKey(
        ev({ key: "a", code: "KeyA", ctrlKey: true }),
        KITTY_ASSOCIATED_TEXT,
      ),
    ).toBeNull();
  });
});
