import type { Config, FocusPreset } from "../config";
import { SKINS } from "../focus/skins";
import { deriveTimerColors } from "../focus/theme";
import { type MessageKey, t } from "../i18n";
import { notifyChannelOptions, soundTimbreOptions } from "./section-agents";
import type { SettingsSection } from "./shell";
import {
  boolField,
  checkbox,
  field,
  fieldsGrid,
  groupLabel,
  iconButton,
  numField,
  rangeField,
  selectField,
  swatchRow,
  textInput,
  timeField,
} from "./widgets";

const TRASH =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const DUPLICATE =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M5 16H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1"/></svg>';
const CHECK =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

const ROLE_ORDER = ["focus", "break", "overflow", "track", "field"] as const;

const roleLabel = (role: string): string =>
  t(`settings.focus.theme.role.${role}` as MessageKey);

export const SHAPE_ORDER = [
  "ring",
  "liquid",
  "coffee",
  "hourglass",
  "bar",
] as const;

const shapeLabel = (shape: string): string =>
  t(`settings.focus.theme.shape.${shape}` as MessageKey);

const SHAPE_GLYPHS: Record<(typeof SHAPE_ORDER)[number], string> = {
  ring:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none">' +
    '<circle cx="12" cy="12" r="8.4" stroke="currentColor" stroke-width="2.4" stroke-opacity=".28"/>' +
    '<path d="M12 3.6a8.4 8.4 0 0 1 5.9 14.3" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>' +
    "</svg>",
  liquid:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none">' +
    '<defs><clipPath id="shape-glyph-liquid-clip"><circle cx="12" cy="12" r="8.4"/></clipPath></defs>' +
    '<circle cx="12" cy="12" r="8.4" stroke="currentColor" stroke-width="1.6" stroke-opacity=".45"/>' +
    '<rect x="3.6" y="12.6" width="16.8" height="8.4" fill="currentColor" fill-opacity=".5" clip-path="url(#shape-glyph-liquid-clip)"/>' +
    "</svg>",
  coffee:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none">' +
    '<defs><clipPath id="shape-glyph-coffee-clip"><path d="M5 8h11v8a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z"/></clipPath></defs>' +
    '<path d="M5 8h11v8a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z" stroke="currentColor" stroke-width="1.6" stroke-opacity=".5"/>' +
    '<rect x="5" y="13" width="11" height="6" fill="currentColor" fill-opacity=".5" clip-path="url(#shape-glyph-coffee-clip)"/>' +
    '<path d="M16 10.2c2.2 0 2.2 5 0 5" stroke="currentColor" stroke-width="1.6" stroke-opacity=".5"/>' +
    "</svg>",
  hourglass:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none">' +
    '<path d="M6 4h12l-6 8z" fill="currentColor" fill-opacity=".22" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>' +
    '<path d="M6 20h12l-6-8z" fill="currentColor" fill-opacity=".5" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>' +
    "</svg>",
  bar:
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none">' +
    '<rect x="8" y="4" width="8" height="16" rx="1.5" stroke="currentColor" stroke-width="1.6" stroke-opacity=".4"/>' +
    '<rect x="8" y="11" width="8" height="9" rx="1.5" fill="currentColor" fill-opacity=".55"/>' +
    "</svg>",
};

function newPreset(label: string): FocusPreset {
  return {
    id: crypto.randomUUID(),
    label,
    focus_min: 25,
    break_min: 5,
    long_break_min: 15,
    cycles_before_long: 4,
    auto_advance: true,
  };
}

function presetItem(
  config: Config,
  preset: FocusPreset,
  save: () => void,
  onChanged: () => void,
): HTMLElement {
  const item = document.createElement("div");
  item.className = "preset-item";

  const head = document.createElement("div");
  head.className = "preset-head";
  const label = textInput(preset.label, (v) => {
    preset.label = v.trim() || preset.label;
    save();
    onChanged();
  });
  label.className = "preset-label";

  const actions = document.createElement("div");
  actions.className = "preset-actions";
  actions.append(
    iconButton(
      DUPLICATE,
      "project-icon-btn",
      t("settings.focus.presets.duplicate"),
      () => {
        const clone = {
          ...preset,
          id: crypto.randomUUID(),
          label: `${preset.label}${t("settings.focus.presets.copySuffix")}`,
        };
        const idx = config.focus.presets.indexOf(preset);
        config.focus.presets.splice(idx + 1, 0, clone);
        save();
        onChanged();
      },
    ),
    iconButton(
      TRASH,
      "project-icon-btn",
      t("settings.focus.presets.remove"),
      () => {
        if (config.focus.presets.length <= 1) return;
        const idx = config.focus.presets.indexOf(preset);
        if (idx === -1) return;
        config.focus.presets.splice(idx, 1);
        if (config.focus.default_preset === preset.id) {
          config.focus.default_preset = config.focus.presets[0].id;
        }
        save();
        onChanged();
      },
    ),
  );
  head.append(label, actions);

  const fieldsRow = document.createElement("div");
  fieldsRow.className = "preset-fields";
  const numberField = (
    labelText: string,
    key: keyof Pick<
      FocusPreset,
      "focus_min" | "break_min" | "long_break_min" | "cycles_before_long"
    >,
    min: number,
    max: number,
    step: number,
  ): HTMLElement => {
    const wrap = document.createElement("label");
    wrap.className = "preset-field";
    const span = document.createElement("span");
    span.textContent = labelText;
    const input = document.createElement("input");
    input.type = "number";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(preset[key]);
    input.addEventListener("change", () => {
      const clamped = Math.min(max, Math.max(min, Number(input.value) || min));
      input.value = String(clamped);
      preset[key] = clamped;
      save();
    });
    wrap.append(span, input);
    return wrap;
  };

  fieldsRow.append(
    numberField(t("settings.focus.presets.focusMin"), "focus_min", 0, 180, 5),
    numberField(t("settings.focus.presets.breakMin"), "break_min", 0, 60, 5),
    numberField(
      t("settings.focus.presets.longBreakMin"),
      "long_break_min",
      0,
      60,
      5,
    ),
    numberField(
      t("settings.focus.presets.cycles"),
      "cycles_before_long",
      1,
      12,
      1,
    ),
  );

  const toggleRow = document.createElement("div");
  toggleRow.className = "preset-toggle";
  const toggleLabel = document.createElement("span");
  toggleLabel.textContent = t("settings.focus.presets.autoAdvance");
  toggleLabel.title = t("settings.focus.presets.autoAdvanceDesc");
  const toggleControl = checkbox(preset.auto_advance, (v) => {
    preset.auto_advance = v;
    save();
  });
  toggleRow.append(toggleLabel, toggleControl);

  item.append(head, fieldsRow, toggleRow);
  return item;
}

function presetsTab(config: Config, save: () => void): HTMLElement {
  const wrap = document.createElement("div");

  const desc = document.createElement("p");
  desc.className = "section-desc";
  desc.textContent = t("settings.focus.presets.desc");
  wrap.append(desc);

  const list = document.createElement("div");
  list.className = "preset-list";
  const defaultPickerWrap = document.createElement("div");
  wrap.append(list, defaultPickerWrap);

  const rebuild = (): void => {
    list.replaceChildren();
    for (const preset of config.focus.presets) {
      list.append(presetItem(config, preset, save, rebuild));
    }

    defaultPickerWrap.replaceChildren();
    const options: [string, string][] = config.focus.presets.map((p) => [
      p.id,
      p.label,
    ]);
    if (
      !config.focus.presets.some((p) => p.id === config.focus.default_preset)
    ) {
      config.focus.default_preset = config.focus.presets[0].id;
    }
    defaultPickerWrap.append(
      fieldsGrid([
        selectField(
          t("settings.focus.presets.defaultPreset"),
          options,
          config.focus,
          "default_preset",
          save,
          t("settings.focus.presets.defaultPresetDesc"),
        ),
      ]),
    );
  };
  rebuild();

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "settings-action";
  addBtn.textContent = t("settings.focus.presets.add");
  addBtn.addEventListener("click", () => {
    config.focus.presets.push(newPreset(t("settings.focus.presets.newLabel")));
    save();
    rebuild();
  });
  const addRow = document.createElement("div");
  addRow.className = "preset-add";
  addRow.append(addBtn);
  wrap.append(addRow);

  return wrap;
}

function skinGallery(
  config: Config,
  save: () => void,
  onChange: () => void,
): HTMLElement {
  const grid = document.createElement("div");
  grid.className = "skin-gallery";
  const bg = config.theme.terminal.bg;

  const entries: { id: string; label: string }[] = [
    { id: "derive", label: t("settings.focus.theme.deriveLabel") },
    ...SKINS.map((s) => ({ id: s.id, label: s.label })),
  ];

  for (const entry of entries) {
    const selected = config.focus.theme === entry.id;
    const card = document.createElement("button");
    card.type = "button";
    card.className = selected ? "theme-card selected" : "theme-card";
    card.setAttribute("aria-pressed", String(selected));

    const preview = document.createElement("div");
    preview.className = "skin-preview";
    const colors = deriveTimerColors(bg, entry.id, {});
    for (const role of ROLE_ORDER) {
      const chip = document.createElement("span");
      chip.style.background = colors[role];
      preview.append(chip);
    }

    const tag = document.createElement("span");
    tag.className = "theme-card-tag";
    const name = document.createElement("span");
    name.textContent = entry.label;
    const check = document.createElement("span");
    check.className = "theme-card-check";
    check.innerHTML = CHECK;
    check.setAttribute("aria-hidden", "true");
    tag.append(name, check);

    card.append(preview, tag);
    card.addEventListener("click", () => {
      config.focus.theme = entry.id;
      save();
      onChange();
    });
    grid.append(card);
  }

  return grid;
}

export function shapeGallery(
  config: Config,
  save: () => void,
  onChange: () => void,
): HTMLElement {
  const grid = document.createElement("div");
  grid.className = "shape-gallery";

  for (const shape of SHAPE_ORDER) {
    const selected = config.focus.timer_shape === shape;
    const card = document.createElement("button");
    card.type = "button";
    card.className = selected ? "theme-card selected" : "theme-card";
    card.setAttribute("aria-pressed", String(selected));

    const preview = document.createElement("div");
    preview.className = "shape-preview";
    preview.innerHTML = SHAPE_GLYPHS[shape];
    preview.setAttribute("aria-hidden", "true");

    const tag = document.createElement("span");
    tag.className = "theme-card-tag";
    const name = document.createElement("span");
    name.textContent = shapeLabel(shape);
    const check = document.createElement("span");
    check.className = "theme-card-check";
    check.innerHTML = CHECK;
    check.setAttribute("aria-hidden", "true");
    tag.append(name, check);

    card.append(preview, tag);
    card.addEventListener("click", () => {
      config.focus.timer_shape = shape;
      save();
      onChange();
    });
    grid.append(card);
  }

  return grid;
}

function themeTab(config: Config, save: () => void): HTMLElement {
  const wrap = document.createElement("div");

  const render = (): void => {
    wrap.replaceChildren();
    wrap.append(skinGallery(config, save, render));
    wrap.append(groupLabel(t("settings.focus.theme.shapeGroup")));
    wrap.append(shapeGallery(config, save, render));

    const overrides = config.focus.role_overrides;
    const bg = config.theme.terminal.bg;
    const resolved = deriveTimerColors(bg, config.focus.theme, overrides);

    const resetRow = document.createElement("div");
    resetRow.className = "preset-add";
    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "settings-action";
    resetBtn.textContent = t("settings.focus.theme.overridesReset");
    resetBtn.addEventListener("click", () => {
      for (const key of Object.keys(overrides)) delete overrides[key];
      save();
      render();
    });
    resetRow.append(resetBtn);

    wrap.append(
      fieldsGrid([
        groupLabel(t("settings.focus.theme.overridesGroup")),
        field(
          t("settings.focus.theme.overridesLabel"),
          swatchRow(
            ROLE_ORDER.length,
            (i) => resolved[ROLE_ORDER[i]],
            (i, v) => {
              overrides[ROLE_ORDER[i]] = v;
            },
            save,
            (i) => roleLabel(ROLE_ORDER[i]),
          ),
          { desc: t("settings.focus.theme.overridesDesc") },
        ),
      ]),
      resetRow,
      fieldsGrid([
        groupLabel(t("settings.focus.theme.ringGroup")),
        selectField(
          t("settings.focus.theme.ringStyle"),
          [
            ["solid", t("settings.focus.theme.ringStyle.solid")],
            ["gradient", t("settings.focus.theme.ringStyle.gradient")],
            ["dual-stroke", t("settings.focus.theme.ringStyle.dualStroke")],
          ],
          config.focus,
          "ring_style",
          save,
          t("settings.focus.theme.ringStyleDesc"),
        ),
        numField(
          t("settings.focus.theme.ringWidth"),
          config.focus,
          "ring_width",
          { min: 1, max: 8 },
          save,
        ),
        rangeField(
          t("settings.focus.theme.glowIntensity"),
          config.focus,
          "glow_intensity",
          {
            min: 0,
            max: 0.5,
            step: 0.02,
            format: (v) => `${Math.round(v * 100)}%`,
          },
          save,
        ),
        selectField(
          t("settings.focus.theme.numericEmphasis"),
          [
            ["ambient", t("settings.focus.theme.numericEmphasis.ambient")],
            ["balanced", t("settings.focus.theme.numericEmphasis.balanced")],
            ["numeric", t("settings.focus.theme.numericEmphasis.numeric")],
          ],
          config.focus,
          "numeric_emphasis",
          save,
          t("settings.focus.theme.numericEmphasisDesc"),
        ),
      ]),
    );
  };

  render();
  return wrap;
}

function behaviorTab(config: Config, save: () => void): HTMLElement {
  const f = config.focus;
  return fieldsGrid([
    groupLabel(t("settings.focus.behavior.groupFlow")),
    boolField(
      t("settings.focus.behavior.startOnOpen"),
      f,
      "start_on_open",
      save,
      t("settings.focus.behavior.startOnOpenDesc"),
    ),
    boolField(
      t("settings.focus.behavior.pauseOnIdle"),
      f,
      "pause_on_idle",
      save,
      t("settings.focus.behavior.pauseOnIdleDesc"),
    ),

    groupLabel(t("settings.focus.behavior.groupOverflow")),
    boolField(
      t("settings.focus.behavior.overflowEnabled"),
      f,
      "overflow_enabled",
      save,
      t("settings.focus.behavior.overflowEnabledDesc"),
    ),
    numField(
      t("settings.focus.behavior.overflowCap"),
      f,
      "overflow_cap_min",
      { min: 1, max: 120, desc: t("settings.focus.behavior.overflowCapDesc") },
      save,
    ),

    groupLabel(t("settings.focus.behavior.groupSession")),
    boolField(
      t("settings.focus.behavior.sessionNote"),
      f,
      "session_note",
      save,
      t("settings.focus.behavior.sessionNoteDesc"),
    ),
  ]);
}

function alertsTab(config: Config, save: () => void): HTMLElement {
  const f = config.focus;
  const n = config.notifications;
  const rows = fieldsGrid([
    groupLabel(t("settings.focus.alerts.groupChannel")),
    selectField(
      t("settings.focus.alerts.channel"),
      notifyChannelOptions(),
      f,
      "alert_channel",
      save,
      t("settings.focus.alerts.channelDesc"),
    ),

    groupLabel(t("settings.focus.alerts.groupSound")),
    boolField(t("settings.focus.alerts.soundEnabled"), f, "alert_sound", save),
    selectField(
      t("settings.focus.alerts.timbre"),
      soundTimbreOptions(),
      f,
      "alert_timbre",
      save,
      t("settings.focus.alerts.timbreDesc"),
    ),

    groupLabel(t("settings.focus.alerts.groupQuietHours")),
    boolField(
      t("settings.focus.alerts.quietHoursEnabled"),
      n.quiet_hours,
      "enabled",
      save,
      t("settings.focus.alerts.quietHoursDesc"),
    ),
    timeField(
      t("settings.focus.alerts.quietHoursStart"),
      n.quiet_hours,
      "start",
      save,
    ),
    timeField(
      t("settings.focus.alerts.quietHoursEnd"),
      n.quiet_hours,
      "end",
      save,
    ),

    groupLabel(t("settings.focus.alerts.groupMotion")),
    selectField(
      t("settings.focus.alerts.motion"),
      [
        ["calm", t("settings.focus.alerts.motion.calm")],
        ["lively", t("settings.focus.alerts.motion.lively")],
        ["off", t("settings.focus.alerts.motion.off")],
      ],
      config.focus,
      "motion",
      save,
    ),
  ]);

  const wrap = document.createElement("div");
  wrap.append(rows);
  const note = document.createElement("p");
  note.className = "templates-hint";
  note.textContent = t("settings.focus.alerts.reducedMotionNote");
  wrap.append(note);
  return wrap;
}

interface FocusTab {
  id: string;
  label: string;
  render: () => HTMLElement;
}

function buildFocus(config: Config, save: () => void): HTMLElement {
  const tabs: FocusTab[] = [
    {
      id: "presets",
      label: t("settings.focus.tab.presets"),
      render: () => presetsTab(config, save),
    },
    {
      id: "theme",
      label: t("settings.focus.tab.theme"),
      render: () => themeTab(config, save),
    },
    {
      id: "behavior",
      label: t("settings.focus.tab.behavior"),
      render: () => behaviorTab(config, save),
    },
    {
      id: "alerts",
      label: t("settings.focus.tab.alerts"),
      render: () => alertsTab(config, save),
    },
  ];

  let active = tabs[0].id;
  const sec = document.createElement("section");
  sec.className = "settings-section";
  const h = document.createElement("h2");
  h.textContent = t("settings.focus.title");
  const desc = document.createElement("p");
  desc.className = "section-desc";
  desc.textContent = t("settings.focus.desc");
  const tabbar = document.createElement("div");
  tabbar.className = "appearance-tabs";
  const content = document.createElement("div");

  const render = (): void => {
    tabbar.replaceChildren();
    for (const tab of tabs) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = tab.id === active ? "seg-tab active" : "seg-tab";
      btn.textContent = tab.label;
      btn.addEventListener("click", () => {
        active = tab.id;
        render();
      });
      tabbar.appendChild(btn);
    }
    const tab = tabs.find((x) => x.id === active) ?? tabs[0];
    content.replaceChildren(tab.render());
  };

  sec.append(h, desc, tabbar, content);
  render();
  return sec;
}

export const focusSection: SettingsSection = {
  id: "focus",
  label: () => t("settings.focus.label"),
  searchText: () => t("settings.focus.search"),
  build: (config, save) => buildFocus(config, save),
};
