import type {
  CursorInactiveStyle,
  CursorStyle,
  FontSmoothing,
} from "../config";
import { t } from "../i18n";
import type { SettingsSection } from "./shell";
import {
  boolField,
  groupLabel,
  numField,
  section,
  selectField,
} from "./widgets";

const SMOOTHING_OPTIONS = (): [FontSmoothing, string][] => [
  ["antialiased", t("settings.terminal.smoothing.antialiased")],
  ["subpixel", t("settings.terminal.smoothing.subpixel")],
];

const CURSOR_OPTIONS = (): [CursorStyle, string][] => [
  ["block", t("settings.terminal.cursor.block")],
  ["bar", t("settings.terminal.cursor.bar")],
  ["underline", t("settings.terminal.cursor.underline")],
];

const CURSOR_INACTIVE_OPTIONS = (): [CursorInactiveStyle, string][] => [
  ["none", t("settings.terminal.cursor.none")],
  ["outline", t("settings.terminal.cursor.outline")],
  ["block", t("settings.terminal.cursor.block")],
  ["bar", t("settings.terminal.cursor.bar")],
  ["underline", t("settings.terminal.cursor.underline")],
];

export const terminalSection: SettingsSection = {
  id: "terminal",
  label: () => t("settings.terminal.label"),
  searchText: () => t("settings.terminal.search"),
  build: (config, save) => {
    const render = config.render;
    return section(
      t("settings.terminal.title"),
      [
        groupLabel(t("settings.terminal.group.render")),
        boolField(
          t("settings.terminal.webgl"),
          render,
          "webgl",
          save,
          t("settings.terminal.webglDesc"),
        ),
        boolField(
          t("settings.terminal.kitty"),
          render,
          "kitty_keyboard",
          save,
          t("settings.terminal.kittyDesc"),
        ),
        boolField(
          t("settings.terminal.shiftEnter"),
          render,
          "shift_enter_newline",
          save,
          t("settings.terminal.shiftEnterDesc"),
        ),
        selectField(
          t("settings.terminal.smoothing"),
          SMOOTHING_OPTIONS(),
          render,
          "font_smoothing",
          save,
        ),
        numField(
          t("settings.terminal.webglPool"),
          render,
          "webgl_pool_cap",
          {
            min: 1,
            max: 32,
            desc: t("settings.terminal.webglPoolDesc"),
          },
          save,
        ),
        groupLabel(t("settings.terminal.group.cursor")),
        selectField(
          t("settings.terminal.cursorStyle"),
          CURSOR_OPTIONS(),
          render,
          "cursor_style",
          save,
        ),
        selectField(
          t("settings.terminal.cursorInactiveStyle"),
          CURSOR_INACTIVE_OPTIONS(),
          render,
          "cursor_inactive_style",
          save,
        ),
        boolField(
          t("settings.terminal.cursorBlink"),
          render,
          "cursor_blink",
          save,
        ),
        groupLabel(t("settings.terminal.group.text")),
        numField(
          t("settings.terminal.lineHeight"),
          render,
          "line_height",
          { min: 1, max: 2, step: 0.05 },
          save,
        ),
        numField(
          t("settings.terminal.letterSpacing"),
          render,
          "letter_spacing",
          { min: 0, max: 5 },
          save,
        ),
        numField(
          t("settings.terminal.minContrast"),
          render,
          "min_contrast",
          {
            min: 1,
            max: 21,
            step: 0.5,
            desc: t("settings.terminal.minContrastDesc"),
          },
          save,
        ),
        numField(
          t("settings.terminal.scrollback"),
          render,
          "scrollback",
          { min: 1000, max: 100000, step: 1000 },
          save,
        ),
        numField(
          t("settings.terminal.padding"),
          render,
          "padding",
          { min: 0, max: 24 },
          save,
        ),
      ],
      t("settings.terminal.desc"),
    );
  },
};
