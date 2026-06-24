import type { Config } from "../config";
import { type MessageKey, t } from "../i18n";
import {
  ACTIONS,
  type ActionDef,
  findConflicts,
  formatKeystroke,
  type Keystroke,
  keystrokeId,
  resolveBindings,
} from "../keys";
import { captureKeystroke } from "./recorder";
import type { SettingsSection } from "./shell";
import { iconButton } from "./widgets";

const actionLabel = (id: string): string => t(`cmd.${id}` as MessageKey);
const categoryLabel = (slug: string): string =>
  t(`cmd.category.${slug}` as MessageKey);
const categoryDesc = (slug: string): string =>
  t(`settings.shortcuts.desc.${slug}` as MessageKey);

const NATIVE_SHORTCUTS: { labelKey: MessageKey; key: string }[] = [
  { labelKey: "settings.shortcuts.native.gotoTab", key: "⌘1–9" },
  { labelKey: "settings.shortcuts.native.openSettings", key: "⌘," },
  { labelKey: "settings.shortcuts.native.copy", key: "⌘C" },
  { labelKey: "settings.shortcuts.native.paste", key: "⌘V" },
  { labelKey: "settings.shortcuts.native.cut", key: "⌘X" },
  { labelKey: "settings.shortcuts.native.undo", key: "⌘Z" },
  { labelKey: "settings.shortcuts.native.redo", key: "⇧⌘Z" },
  { labelKey: "settings.shortcuts.native.selectAll", key: "⌘A" },
];

const EDITOR_SHORTCUTS: { labelKey: MessageKey; key: string }[] = [
  { labelKey: "settings.shortcuts.editor.copyLine", key: "⌘C" },
  { labelKey: "settings.shortcuts.editor.cutLine", key: "⌘X" },
  { labelKey: "settings.shortcuts.editor.moveLine", key: "⌥↑ / ⌥↓" },
  { labelKey: "settings.shortcuts.editor.dupLine", key: "⇧⌥↑ / ⇧⌥↓" },
];

const PENCIL_SVG =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.3 2.3a1.1 1.1 0 0 1 1.6 0l.8.8a1.1 1.1 0 0 1 0 1.6L5.5 13H3v-2.5z"/></svg>';

const RESET_SVG =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8a4.5 4.5 0 1 1 1.4 3.3"/><path d="M3 5.2V8h2.8"/></svg>';

function keyCaps(ks: Keystroke): string[] {
  const mods: string[] = [];
  if (ks.ctrl) mods.push("⌃");
  if (ks.alt) mods.push("⌥");
  if (ks.shift) mods.push("⇧");
  if (ks.meta) mods.push("⌘");
  const glyph = formatKeystroke(ks).slice(mods.length);
  return [...mods, glyph];
}

function defaultsEqual(a: Keystroke[], b: Keystroke[]): boolean {
  if (a.length !== b.length) return false;
  const idsA = a.map(keystrokeId).sort();
  const idsB = b.map(keystrokeId).sort();
  return idsA.every((x, i) => x === idsB[i]);
}

function setOverride(
  config: Config,
  action: ActionDef,
  ks: Keystroke | null,
): void {
  if (ks && defaultsEqual([ks], action.defaults)) {
    delete config.keybindings[action.id];
    return;
  }
  config.keybindings[action.id] = ks ? [ks] : null;
}

function conflictOwner(
  config: Config,
  action: ActionDef,
  ks: Keystroke,
): ActionDef | null {
  const proposed = { ...config.keybindings, [action.id]: [ks] };
  for (const c of findConflicts(proposed)) {
    if (c.keystroke !== keystrokeId(ks)) continue;
    const other = c.a === action.id ? c.b : c.b === action.id ? c.a : null;
    if (other) return ACTIONS.find((a) => a.id === other) ?? null;
  }
  return null;
}

function buildShortcuts(config: Config, save: () => void): HTMLElement {
  const sec = document.createElement("section");
  const h = document.createElement("h2");
  h.textContent = t("settings.shortcuts.title");
  const search = document.createElement("input");
  search.type = "search";
  search.className = "settings-search-inline";
  search.placeholder = t("settings.shortcuts.searchPlaceholder");
  const tabbar = document.createElement("div");
  tabbar.className = "shortcut-tabs";
  const groups = document.createElement("div");
  groups.className = "shortcuts";
  sec.append(h, search, tabbar, groups);

  const categories = [...new Set(ACTIONS.map((a) => a.category))];
  let activeCat: string | null = null;
  let recordingId: string | null = null;
  let detach: (() => void) | null = null;

  const matches = (
    action: ActionDef,
    strokes: Keystroke[],
    q: string,
  ): boolean => {
    if (!q) return true;
    const keys = strokes.map(formatKeystroke).join(" ").toLowerCase();
    return actionLabel(action.id).toLowerCase().includes(q) || keys.includes(q);
  };

  const fixedMatches = (
    items: { labelKey: MessageKey; key: string }[],
    q: string,
  ): boolean =>
    !q ||
    items.some(
      (s) =>
        t(s.labelKey).toLowerCase().includes(q) ||
        s.key.toLowerCase().includes(q),
    );

  const groupHead = (title: string, desc?: string): HTMLElement => {
    const wrap = document.createElement("div");
    wrap.className = "shortcut-group-head";
    const head = document.createElement("h3");
    head.textContent = title;
    wrap.appendChild(head);
    if (desc) {
      const p = document.createElement("p");
      p.className = "shortcut-group-desc";
      p.textContent = desc;
      wrap.appendChild(p);
    }
    return wrap;
  };

  const fixedRow = (label: string, key: string): HTMLElement => {
    const row = document.createElement("div");
    row.className = "shortcut-row";
    const lbl = document.createElement("span");
    lbl.className = "shortcut-label";
    lbl.textContent = label;
    const keys = document.createElement("div");
    keys.className = "shortcut-keys";
    const chip = document.createElement("kbd");
    chip.className = "shortcut-key shortcut-key--fixed";
    chip.textContent = key;
    keys.appendChild(chip);
    row.append(lbl, keys);
    return row;
  };

  const chipFor = (ks: Keystroke): HTMLElement => {
    const combo = document.createElement("span");
    combo.className = "shortcut-combo";
    for (const cap of keyCaps(ks)) {
      const k = document.createElement("kbd");
      k.className = "kc";
      k.textContent = cap;
      combo.appendChild(k);
    }
    return combo;
  };

  const buildRow = (action: ActionDef, strokes: Keystroke[]): HTMLElement => {
    const row = document.createElement("div");
    row.className = "shortcut-row";
    const label = document.createElement("span");
    label.className = "shortcut-label";
    label.textContent = actionLabel(action.id);
    const keys = document.createElement("div");
    keys.className = "shortcut-keys";
    row.append(label, keys);

    if (recordingId === action.id) {
      const entry = document.createElement("div");
      entry.className = "shortcut-entry recording";
      const slot = document.createElement("span");
      slot.className = "rec-slot";
      const cursor = document.createElement("span");
      cursor.className = "rec-cursor";
      slot.append(
        cursor,
        document.createTextNode(t("settings.shortcuts.recordPrompt")),
      );
      keys.appendChild(slot);
      const hint = document.createElement("p");
      hint.className = "rec-hint";
      hint.textContent = t("settings.shortcuts.recordHint");
      entry.append(row, hint);

      const onKey = (e: KeyboardEvent): void => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          recordingId = null;
          rerender();
          return;
        }
        if (e.key === "Backspace") {
          e.preventDefault();
          setOverride(config, action, null);
          save();
          recordingId = null;
          rerender();
          return;
        }
        const ks = captureKeystroke(e);
        if (!ks) return;
        const owner = conflictOwner(config, action, ks);
        if (owner) {
          slot.classList.add("conflict");
          slot.textContent = t("settings.shortcuts.conflict", {
            key: formatKeystroke(ks),
            owner: actionLabel(owner.id),
          });
          return;
        }
        setOverride(config, action, ks);
        save();
        recordingId = null;
        rerender();
      };
      window.addEventListener("keydown", onKey, true);
      detach = () => window.removeEventListener("keydown", onKey, true);
      return entry;
    }

    if (strokes.length === 0) {
      const none = document.createElement("span");
      none.className = "shortcut-none";
      none.textContent = t("settings.shortcuts.unassigned");
      keys.appendChild(none);
    } else {
      for (const ks of strokes) keys.appendChild(chipFor(ks));
    }

    const actions = document.createElement("div");
    actions.className = "shortcut-actions";
    if (action.id in config.keybindings) {
      actions.appendChild(
        iconButton(
          RESET_SVG,
          "shortcut-reset",
          t("settings.shortcuts.reset"),
          () => {
            delete config.keybindings[action.id];
            save();
            rerender();
          },
        ),
      );
    }
    actions.appendChild(
      iconButton(
        PENCIL_SVG,
        "shortcut-edit",
        t("settings.shortcuts.edit"),
        () => {
          recordingId = action.id;
          rerender();
        },
      ),
    );
    row.appendChild(actions);
    return row;
  };

  const renderTabs = (): void => {
    tabbar.replaceChildren();
    for (const cat of categories) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        cat === activeCat ? "shortcut-tab active" : "shortcut-tab";
      btn.textContent = categoryLabel(cat);
      btn.addEventListener("click", () => {
        activeCat = activeCat === cat ? null : cat;
        recordingId = null;
        rerender();
      });
      tabbar.appendChild(btn);
    }
  };

  const fixedInto = (parent: HTMLElement, q: string): void => {
    if (fixedMatches(EDITOR_SHORTCUTS, q)) {
      parent.appendChild(groupHead(t("settings.shortcuts.group.editor")));
      for (const s of EDITOR_SHORTCUTS)
        if (!q || fixedMatches([s], q))
          parent.appendChild(fixedRow(t(s.labelKey), s.key));
    }
    if (fixedMatches(NATIVE_SHORTCUTS, q)) {
      parent.appendChild(groupHead(t("settings.shortcuts.group.system")));
      for (const s of NATIVE_SHORTCUTS)
        if (!q || fixedMatches([s], q))
          parent.appendChild(fixedRow(t(s.labelKey), s.key));
    }
  };

  const rerender = (): void => {
    detach?.();
    detach = null;
    groups.replaceChildren();
    const resolved = resolveBindings(config.keybindings);
    const q = search.value.trim().toLowerCase();

    if (q) {
      tabbar.classList.add("hidden");
      for (const cat of categories) {
        const inCat = ACTIONS.filter((a) => a.category === cat).filter((a) =>
          matches(a, resolved[a.id], q),
        );
        if (!inCat.length) continue;
        groups.appendChild(groupHead(categoryLabel(cat), categoryDesc(cat)));
        for (const a of inCat) groups.appendChild(buildRow(a, resolved[a.id]));
      }
      fixedInto(groups, q);
      return;
    }

    tabbar.classList.remove("hidden");
    renderTabs();
    if (activeCat === null) {
      fixedInto(groups, "");
      return;
    }
    groups.appendChild(
      groupHead(categoryLabel(activeCat), categoryDesc(activeCat)),
    );
    for (const a of ACTIONS.filter((a) => a.category === activeCat))
      groups.appendChild(buildRow(a, resolved[a.id]));
  };

  search.addEventListener("input", () => rerender());
  rerender();
  return sec;
}

export const shortcutsSection: SettingsSection = {
  id: "shortcuts",
  label: () => t("settings.shortcuts.label"),
  searchText: () =>
    [
      ...ACTIONS.map((a) => actionLabel(a.id)),
      ...EDITOR_SHORTCUTS.map((s) => t(s.labelKey)),
      ...NATIVE_SHORTCUTS.map((s) => t(s.labelKey)),
    ].join(" "),
  build: (config, save) => buildShortcuts(config, save),
};
