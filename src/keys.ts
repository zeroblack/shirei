export type Scope = "global" | "pane";

export interface Keystroke {
  key: string;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
}

const SPECIAL: Record<string, string> = {
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  enter: "Enter",
  escape: "Escape",
  tab: "Tab",
  backspace: "Backspace",
  " ": "Space",
};

const PUNCT_FOLD: Record<string, string> = { "+": "=", _: "-" };

function normalizeKey(raw: string): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (SPECIAL[lower]) return SPECIAL[lower];
  if (PUNCT_FOLD[lower]) return PUNCT_FOLD[lower];
  if ([...raw].length === 1) return lower;
  return null;
}

// The physical key from `e.code` (layout position), which Option never remaps.
// Only the keys our bindings use; anything else falls back to `e.key`.
function physicalKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (code === "Minus") return "-";
  if (code === "Equal") return "=";
  return null;
}

export function eventToKeystroke(e: KeyboardEvent): Keystroke | null {
  if (!(e.metaKey || e.ctrlKey || e.altKey)) return null;
  const fromKey = normalizeKey(e.key);
  // macOS Option remaps letter/punctuation keys (⌥T -> "†"), so a stored a-z
  // binding would never match. When `e.key` is not a plain letter/digit,
  // recover the physical key from `e.code`; otherwise honor `e.key` so
  // non-QWERTY layouts still bind by the character they type.
  const key =
    fromKey && /^[a-z0-9]$/.test(fromKey)
      ? fromKey
      : (physicalKey(e.code) ?? fromKey);
  if (!key) return null;
  return {
    key,
    meta: e.metaKey || undefined,
    shift: e.shiftKey || undefined,
    alt: e.altKey || undefined,
    ctrl: e.ctrlKey || undefined,
  };
}

export function keystrokeId(k: Keystroke): string {
  const parts: string[] = [];
  if (k.meta) parts.push("meta");
  if (k.ctrl) parts.push("ctrl");
  if (k.alt) parts.push("alt");
  if (k.shift) parts.push("shift");
  parts.push(k.key.toLowerCase());
  return parts.join("+");
}

const GLYPH_KEY: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Enter: "↵",
  Escape: "⎋",
  Tab: "⇥",
  Backspace: "⌫",
  Space: "␣",
};

export function formatKeystroke(k: Keystroke): string {
  let out = "";
  if (k.ctrl) out += "⌃";
  if (k.alt) out += "⌥";
  if (k.shift) out += "⇧";
  if (k.meta) out += "⌘";
  out += GLYPH_KEY[k.key] ?? (k.key.length === 1 ? k.key.toUpperCase() : k.key);
  return out;
}

export interface ActionDef {
  id: string;
  category: string;
  scope: Scope;
  defaults: Keystroke[];
}

export type Overrides = Record<string, Keystroke[] | null>;

export const ACTIONS: ActionDef[] = [
  {
    id: "tab.new",
    category: "tabs",
    scope: "global",
    defaults: [{ key: "t", meta: true }],
  },
  {
    id: "tab.close",
    category: "tabs",
    scope: "global",
    defaults: [{ key: "w", meta: true }],
  },
  {
    id: "tab.close-tab",
    category: "tabs",
    scope: "global",
    defaults: [{ key: "w", meta: true, alt: true }],
  },
  {
    id: "tab.prev",
    category: "tabs",
    scope: "global",
    defaults: [{ key: "ArrowLeft", meta: true }],
  },
  {
    id: "tab.next",
    category: "tabs",
    scope: "global",
    defaults: [{ key: "ArrowRight", meta: true }],
  },
  {
    id: "palette.open",
    category: "navigation",
    scope: "global",
    defaults: [{ key: "p", meta: true }],
  },
  {
    id: "panel.toggle",
    category: "navigation",
    scope: "global",
    defaults: [{ key: "b", meta: true }],
  },
  {
    id: "finder.reveal",
    category: "navigation",
    scope: "global",
    defaults: [{ key: "o", meta: true, shift: true }],
  },
  {
    id: "tree.refresh",
    category: "navigation",
    scope: "global",
    defaults: [{ key: "r", meta: true }],
  },
  {
    id: "font.inc",
    category: "view",
    scope: "global",
    defaults: [
      { key: "=", meta: true },
      { key: "=", meta: true, shift: true },
    ],
  },
  {
    id: "font.dec",
    category: "view",
    scope: "global",
    defaults: [
      { key: "-", meta: true },
      { key: "-", meta: true, shift: true },
    ],
  },
  {
    id: "font.reset",
    category: "view",
    scope: "global",
    defaults: [{ key: "0", meta: true }],
  },
  {
    id: "scroll.up",
    category: "view",
    scope: "pane",
    defaults: [{ key: "w", meta: true, shift: true }],
  },
  {
    id: "scroll.down",
    category: "view",
    scope: "pane",
    defaults: [{ key: "s", meta: true, shift: true }],
  },
  {
    id: "statusbar.toggle",
    category: "view",
    scope: "global",
    defaults: [{ key: "m", meta: true, shift: true }],
  },
  {
    id: "render.recover",
    category: "view",
    scope: "global",
    defaults: [{ key: "r", meta: true, alt: true }],
  },
  {
    id: "logs.reveal",
    category: "view",
    scope: "global",
    defaults: [{ key: "l", meta: true, alt: true }],
  },
  {
    id: "layout.save",
    category: "layouts",
    scope: "global",
    defaults: [{ key: "g", meta: true, shift: true }],
  },
  {
    id: "template.save",
    category: "layouts",
    scope: "global",
    defaults: [{ key: "l", meta: true, shift: true }],
  },
  {
    id: "session.save",
    category: "editor",
    scope: "global",
    defaults: [{ key: "s", meta: true }],
  },
  {
    id: "editor.vim-toggle",
    category: "editor",
    scope: "global",
    defaults: [{ key: "v", meta: true, shift: true }],
  },
  {
    id: "editor.preview-toggle",
    category: "editor",
    scope: "global",
    defaults: [{ key: "e", meta: true, shift: true }],
  },
  {
    id: "git.history",
    category: "git",
    scope: "global",
    defaults: [{ key: "h", meta: true, shift: true }],
  },
  {
    id: "git.blame-toggle",
    category: "git",
    scope: "global",
    defaults: [{ key: "b", meta: true, shift: true }],
  },
  {
    id: "memory.open",
    category: "memory",
    scope: "global",
    defaults: [{ key: "y", meta: true, shift: true }],
  },
  {
    id: "memory.resume",
    category: "memory",
    scope: "pane",
    defaults: [{ key: "u", meta: true, shift: true }],
  },
  {
    id: "memory.save_session",
    category: "memory",
    scope: "pane",
    defaults: [{ key: "j", meta: true, shift: true }],
  },
  {
    id: "memory.open_decisions",
    category: "memory",
    scope: "global",
    defaults: [],
  },
  {
    id: "memory.open_resume",
    category: "memory",
    scope: "global",
    defaults: [],
  },
  {
    id: "memory.open_sessions",
    category: "memory",
    scope: "global",
    defaults: [],
  },
  {
    id: "pane.split-h",
    category: "panes",
    scope: "pane",
    defaults: [{ key: "d", meta: true }],
  },
  {
    id: "pane.split-v",
    category: "panes",
    scope: "pane",
    defaults: [{ key: "d", meta: true, shift: true }],
  },
  {
    id: "pane.zoom",
    category: "panes",
    scope: "pane",
    defaults: [{ key: "Enter", meta: true, shift: true }],
  },
  {
    id: "pane.content.pick",
    category: "panes",
    scope: "pane",
    defaults: [{ key: "t", meta: true, alt: true }],
  },
  {
    id: "pane.content.cycle",
    category: "panes",
    scope: "pane",
    defaults: [{ key: "Enter", meta: true, alt: true }],
  },
  {
    id: "pane.content.close",
    category: "panes",
    scope: "pane",
    defaults: [{ key: "Backspace", meta: true, alt: true }],
  },
  {
    id: "pane.content.slot-1",
    category: "panes",
    scope: "pane",
    defaults: [{ key: "1", meta: true, alt: true }],
  },
  {
    id: "pane.content.slot-2",
    category: "panes",
    scope: "pane",
    defaults: [{ key: "2", meta: true, alt: true }],
  },
  {
    id: "pane.content.slot-3",
    category: "panes",
    scope: "pane",
    defaults: [{ key: "3", meta: true, alt: true }],
  },
  {
    id: "focus.left",
    category: "panes",
    scope: "global",
    defaults: [{ key: "ArrowLeft", meta: true, shift: true }],
  },
  {
    id: "focus.right",
    category: "panes",
    scope: "global",
    defaults: [{ key: "ArrowRight", meta: true, shift: true }],
  },
  {
    id: "focus.up",
    category: "panes",
    scope: "global",
    defaults: [{ key: "ArrowUp", meta: true, shift: true }],
  },
  {
    id: "focus.down",
    category: "panes",
    scope: "global",
    defaults: [{ key: "ArrowDown", meta: true, shift: true }],
  },
  {
    id: "tab.move-prev",
    category: "tabs",
    scope: "global",
    defaults: [{ key: "ArrowLeft", meta: true, alt: true }],
  },
  {
    id: "tab.move-next",
    category: "tabs",
    scope: "global",
    defaults: [{ key: "ArrowRight", meta: true, alt: true }],
  },
  {
    id: "tab.pin",
    category: "tabs",
    scope: "global",
    defaults: [{ key: "p", meta: true, shift: true }],
  },
  {
    id: "session.reconnect",
    category: "session",
    scope: "pane",
    defaults: [{ key: "r", meta: true, shift: true }],
  },
  {
    id: "session.kill",
    category: "session",
    scope: "pane",
    defaults: [{ key: "k", meta: true, shift: true }],
  },
  {
    id: "record.start",
    category: "recording",
    scope: "global",
    defaults: [{ key: "r", meta: true, ctrl: true }],
  },
  {
    id: "terminal.copy-line",
    category: "session",
    scope: "pane",
    defaults: [{ key: "c", meta: true }],
  },
  {
    id: "terminal.paste",
    category: "session",
    scope: "pane",
    defaults: [{ key: "v", meta: true }],
  },
  {
    id: "tree.focus",
    category: "navigation",
    scope: "global",
    defaults: [{ key: "e", meta: true }],
  },
  {
    id: "todo.focus",
    category: "navigation",
    scope: "global",
    defaults: [{ key: "j", meta: true }],
  },
  {
    id: "todo.capture",
    category: "navigation",
    scope: "global",
    defaults: [{ key: "a", meta: true, shift: true }],
  },
  {
    id: "todo.collapse",
    category: "navigation",
    scope: "global",
    defaults: [{ key: "j", meta: true, ctrl: true }],
  },
  {
    id: "browser.open",
    category: "panes",
    scope: "global",
    defaults: [{ key: "b", meta: true, alt: true }],
  },
  {
    id: "pane.pin",
    category: "panes",
    scope: "global",
    defaults: [{ key: "p", meta: true, ctrl: true }],
  },
  {
    id: "pin.terminal",
    category: "panes",
    scope: "global",
    defaults: [{ key: "t", meta: true, ctrl: true }],
  },
  {
    id: "pin.browser",
    category: "panes",
    scope: "global",
    defaults: [{ key: "b", meta: true, ctrl: true }],
  },
  {
    id: "browser.focus-url",
    category: "panes",
    scope: "global",
    defaults: [{ key: "l", meta: true }],
  },
  {
    id: "browser.back",
    category: "panes",
    scope: "pane",
    defaults: [{ key: "[", meta: true }],
  },
  {
    id: "browser.forward",
    category: "panes",
    scope: "pane",
    defaults: [{ key: "]", meta: true }],
  },
  {
    id: "browser.reload",
    category: "panes",
    scope: "pane",
    // Plain Cmd+R is the global tree.refresh; do not collide with it.
    defaults: [{ key: "r", meta: true, alt: true, shift: true }],
  },
  {
    id: "orchestration.open",
    category: "orchestration",
    scope: "global",
    defaults: [{ key: "a", meta: true, ctrl: true }],
  },
  {
    id: "orchestration.goto-waiting",
    category: "orchestration",
    scope: "global",
    defaults: [{ key: "g", meta: true, ctrl: true }],
  },
  {
    id: "orchestration.next-waiting",
    category: "orchestration",
    scope: "global",
    defaults: [{ key: "]", meta: true, ctrl: true }],
  },
  {
    id: "orchestration.prev-waiting",
    category: "orchestration",
    scope: "global",
    defaults: [{ key: "[", meta: true, ctrl: true }],
  },
  {
    id: "pin.timer",
    category: "focus",
    scope: "global",
    defaults: [{ key: "f", meta: true, ctrl: true }],
  },
  {
    id: "timer.toggle",
    category: "focus",
    scope: "global",
    defaults: [{ key: "Space", meta: true, ctrl: true }],
  },
  {
    id: "timer.skip",
    category: "focus",
    scope: "global",
    defaults: [{ key: "s", meta: true, ctrl: true }],
  },
  {
    id: "timer.reset",
    category: "focus",
    scope: "global",
    defaults: [{ key: "0", meta: true, ctrl: true }],
  },
  {
    id: "timer.rename",
    category: "focus",
    scope: "global",
    defaults: [{ key: "n", meta: true, ctrl: true }],
  },
  {
    id: "timer.focusCell",
    category: "focus",
    scope: "global",
    defaults: [{ key: "f", meta: true, shift: true }],
  },
  {
    id: "timer.panel",
    category: "focus",
    scope: "global",
    defaults: [{ key: "e", meta: true, ctrl: true }],
  },
];

export function resolveBindings(
  overrides: Overrides,
): Record<string, Keystroke[]> {
  const out: Record<string, Keystroke[]> = {};
  for (const a of ACTIONS) {
    if (a.id in overrides) {
      const ov = overrides[a.id];
      out[a.id] = ov ?? [];
    } else {
      out[a.id] = a.defaults;
    }
  }
  return out;
}

const scopesOverlap = (a: Scope, b: Scope): boolean =>
  a === b || a === "global" || b === "global";

export interface Conflict {
  a: string;
  b: string;
  keystroke: string;
}

export function findConflicts(overrides: Overrides): Conflict[] {
  const resolved = resolveBindings(overrides);
  const scopeOf = new Map(ACTIONS.map((a) => [a.id, a.scope]));
  const conflicts: Conflict[] = [];
  const entries = Object.entries(resolved);
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [idA, ksA] = entries[i];
      const [idB, ksB] = entries[j];
      if (!scopesOverlap(scopeOf.get(idA) as Scope, scopeOf.get(idB) as Scope))
        continue;
      for (const ka of ksA) {
        for (const kb of ksB) {
          if (keystrokeId(ka) === keystrokeId(kb)) {
            conflicts.push({ a: idA, b: idB, keystroke: keystrokeId(ka) });
          }
        }
      }
    }
  }
  return conflicts;
}
