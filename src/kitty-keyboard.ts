export const KITTY_DISAMBIGUATE = 1;
export const KITTY_EVENT_TYPES = 2;
export const KITTY_ALTERNATE_KEYS = 4;
export const KITTY_ALL_AS_ESCAPE = 8;
export const KITTY_ASSOCIATED_TEXT = 16;
export const KITTY_ALL_FLAGS = 31;

const STACK_LIMIT = 32;

export class KittyKeyboardState {
  private readonly stack: number[] = [0];

  current(): number {
    return this.stack[this.stack.length - 1];
  }

  push(flags: number): void {
    if (this.stack.length >= STACK_LIMIT) this.stack.splice(1, 1);
    this.stack.push(flags & KITTY_ALL_FLAGS);
  }

  pop(n: number): void {
    for (let i = 0; i < n && this.stack.length > 1; i++) this.stack.pop();
  }

  set(flags: number, mode: number): void {
    const f = flags & KITTY_ALL_FLAGS;
    const cur = this.current();
    const next = mode === 2 ? cur | f : mode === 3 ? cur & ~f : f;
    this.stack[this.stack.length - 1] = next & KITTY_ALL_FLAGS;
  }
}

export function applyKittySequence(
  state: KittyKeyboardState,
  prefix: string,
  params: number[],
): string | null {
  switch (prefix) {
    case "?":
      return `\x1b[?${state.current()}u`;
    case ">":
      state.push(params[0] ?? 0);
      return null;
    case "<":
      state.pop(params[0] || 1);
      return null;
    case "=":
      state.set(params[0] ?? 0, params[1] || 1);
      return null;
    default:
      return null;
  }
}

interface FunctionalKey {
  number: number;
  terminator: string;
}

const FUNCTIONAL: Record<string, FunctionalKey> = {
  Escape: { number: 27, terminator: "u" },
  Enter: { number: 13, terminator: "u" },
  Tab: { number: 9, terminator: "u" },
  Backspace: { number: 127, terminator: "u" },
  Insert: { number: 2, terminator: "~" },
  Delete: { number: 3, terminator: "~" },
  ArrowLeft: { number: 1, terminator: "D" },
  ArrowRight: { number: 1, terminator: "C" },
  ArrowUp: { number: 1, terminator: "A" },
  ArrowDown: { number: 1, terminator: "B" },
  Home: { number: 1, terminator: "H" },
  End: { number: 1, terminator: "F" },
  PageUp: { number: 5, terminator: "~" },
  PageDown: { number: 6, terminator: "~" },
  F1: { number: 1, terminator: "P" },
  F2: { number: 1, terminator: "Q" },
  F3: { number: 13, terminator: "~" },
  F4: { number: 1, terminator: "S" },
  F5: { number: 15, terminator: "~" },
  F6: { number: 17, terminator: "~" },
  F7: { number: 18, terminator: "~" },
  F8: { number: 19, terminator: "~" },
  F9: { number: 20, terminator: "~" },
  F10: { number: 21, terminator: "~" },
  F11: { number: 23, terminator: "~" },
  F12: { number: 24, terminator: "~" },
};

const MODIFIER_KEYS: Record<string, number> = {
  ShiftLeft: 57441,
  ControlLeft: 57442,
  AltLeft: 57443,
  MetaLeft: 57444,
  ShiftRight: 57447,
  ControlRight: 57448,
  AltRight: 57449,
  MetaRight: 57450,
};

const LETTER_TERMINATORS = new Set([
  "A",
  "B",
  "C",
  "D",
  "H",
  "F",
  "P",
  "Q",
  "S",
]);

const US_LAYOUT: Record<string, [number, number]> = (() => {
  const map: Record<string, [number, number]> = {
    Digit1: [49, 33],
    Digit2: [50, 64],
    Digit3: [51, 35],
    Digit4: [52, 36],
    Digit5: [53, 37],
    Digit6: [54, 94],
    Digit7: [55, 38],
    Digit8: [56, 42],
    Digit9: [57, 40],
    Digit0: [48, 41],
    Minus: [45, 95],
    Equal: [61, 43],
    BracketLeft: [91, 123],
    BracketRight: [93, 125],
    Backslash: [92, 124],
    Semicolon: [59, 58],
    Quote: [39, 34],
    Backquote: [96, 126],
    Comma: [44, 60],
    Period: [46, 62],
    Slash: [47, 63],
    Space: [32, 32],
  };
  for (let i = 0; i < 26; i++) {
    map[`Key${String.fromCharCode(65 + i)}`] = [97 + i, 65 + i];
  }
  return map;
})();

type EventType = 1 | 2 | 3;

function eventType(e: KeyboardEvent): EventType {
  if (e.type === "keyup") return 3;
  return e.repeat ? 2 : 1;
}

function modifierValue(e: KeyboardEvent): number {
  let m = 0;
  if (e.shiftKey) m |= 1;
  if (e.altKey) m |= 2;
  if (e.ctrlKey) m |= 4;
  if (e.metaKey) m |= 8;
  if (e.getModifierState?.("CapsLock")) m |= 64;
  if (e.getModifierState?.("NumLock")) m |= 128;
  return 1 + m;
}

function printableText(e: KeyboardEvent): string | null {
  if ([...e.key].length !== 1) return null;
  const cp = e.key.codePointAt(0) as number;
  if (cp < 0x20 || cp === 0x7f) return null;
  return e.key;
}

function baseCodes(e: KeyboardEvent): { primary: number; shifted: number } {
  const layout = US_LAYOUT[e.code];
  if (layout) return { primary: layout[0], shifted: layout[1] };
  const text = printableText(e);
  const cp = text ? (text.codePointAt(0) as number) : 0;
  const lower = text ? (text.toLowerCase().codePointAt(0) as number) : cp;
  return { primary: lower, shifted: cp };
}

function legacyByte(key: string): string {
  return key === "Enter" ? "\r" : key === "Tab" ? "\t" : "\x7f";
}

export function encodeKey(e: KeyboardEvent, flags: number): string | null {
  if (e.isComposing || e.keyCode === 229) return null;

  const type = eventType(e);
  const reportEvents = (flags & KITTY_EVENT_TYPES) !== 0;
  const reportAll = (flags & KITTY_ALL_AS_ESCAPE) !== 0;
  if (type === 3 && !reportEvents) return "";

  const func = FUNCTIONAL[e.key];
  const ctrlAltMeta = e.ctrlKey || e.altKey || e.metaKey;
  const mods = modifierValue(e);

  // Enter/Tab/Backspace keep their legacy byte when unmodified: shells and
  // readline depend on raw 0x0d/0x09/0x7f. They only become escapes with a
  // modifier or report-all.
  if (
    func &&
    (e.key === "Enter" || e.key === "Tab" || e.key === "Backspace") &&
    mods === 1 &&
    type !== 3 &&
    !reportAll
  ) {
    return legacyByte(e.key);
  }

  const text = printableText(e);
  if (!func && text !== null && !ctrlAltMeta && !reportAll) {
    return type === 3 ? "" : text;
  }

  const modKey = func ? undefined : MODIFIER_KEYS[e.code];
  if (modKey !== undefined && !reportAll) return "";

  // Without disambiguate or report-all, functional/modified keys keep their
  // legacy encoding: xterm.js handles them.
  if (!(flags & (KITTY_DISAMBIGUATE | KITTY_ALL_AS_ESCAPE))) return null;

  const number = func ? func.number : (modKey ?? baseCodes(e).primary);
  const terminator = func ? func.terminator : "u";

  let alternates = "";
  if (!func && modKey === undefined && flags & KITTY_ALTERNATE_KEYS) {
    const { primary, shifted } = baseCodes(e);
    const shiftedPart = e.shiftKey && shifted !== primary ? `${shifted}` : "";
    if (shiftedPart) alternates = `:${shiftedPart}`;
  }

  const needEvent = reportEvents && type !== 1;
  let textPart = "";
  if (
    flags & KITTY_ASSOCIATED_TEXT &&
    text !== null &&
    !ctrlAltMeta &&
    type !== 3
  ) {
    textPart = `;${[...text].map((c) => c.codePointAt(0)).join(":")}`;
  }

  let modPart = "";
  if (mods !== 1 || needEvent || textPart) {
    modPart = `;${mods}`;
    if (needEvent) modPart += `:${type}`;
  }

  const isLetter = LETTER_TERMINATORS.has(terminator);
  const head = isLetter && !modPart ? "" : `${number}`;
  return `\x1b[${head}${alternates}${modPart}${textPart}${terminator}`;
}
