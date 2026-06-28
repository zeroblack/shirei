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

export function eventToKeystroke(e: KeyboardEvent): Keystroke | null {
  const key = normalizeKey(e.key);
  if (!key) return null;
  if (!(e.metaKey || e.ctrlKey || e.altKey)) return null;
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
