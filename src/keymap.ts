import {
  ACTIONS,
  eventToKeystroke,
  type Keystroke,
  keystrokeId,
  type Overrides,
  resolveBindings,
  type Scope,
} from "./keys";

interface Ctx {
  pane: boolean;
}

// Native menu accelerators with no keymap action (lib.rs): ⌘1-9 goto-tab and
// ⌘, settings. The terminal must let them bubble up to the menu.
const MENU_ONLY_META_KEYS = /^[1-9,]$/;

export class Keymap {
  private readonly byStroke = new Map<string, { id: string; scope: Scope }[]>();

  constructor(overrides: Overrides) {
    const scopeOf = new Map(ACTIONS.map((a) => [a.id, a.scope]));
    const resolved = resolveBindings(overrides);
    for (const [id, strokes] of Object.entries(resolved)) {
      for (const ks of strokes) {
        const key = keystrokeId(ks);
        const list = this.byStroke.get(key) ?? [];
        list.push({ id, scope: scopeOf.get(id) as Scope });
        this.byStroke.set(key, list);
      }
    }
  }

  resolve(ks: Keystroke, ctx: Ctx): string | null {
    const list = this.byStroke.get(keystrokeId(ks));
    if (!list) return null;
    const active = list.filter(
      (x) => x.scope === "global" || (x.scope === "pane" && ctx.pane),
    );
    const pane = active.find((x) => x.scope === "pane");
    return (pane ?? active[0])?.id ?? null;
  }

  /**
   * Whether the app (a keymap binding or a native menu accelerator) owns this
   * ⌘-keystroke. The terminal consults it instead of mirroring the binding
   * list, so rebinds and new actions never desync.
   */
  ownsMetaKeystroke(e: KeyboardEvent): boolean {
    if (!e.metaKey) return false;
    if (MENU_ONLY_META_KEYS.test(e.key)) return true;
    const ks = eventToKeystroke(e);
    return ks !== null && this.resolve(ks, { pane: true }) !== null;
  }
}
