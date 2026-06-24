import type { Config, TerminalColors } from "../config";
import {
  fontInstall,
  fontInstalled,
  fontRemove,
  fontStack,
  registerFont,
} from "../fonts";
import { type MessageKey, t } from "../i18n";
import { themeGallery } from "./section-theme";
import type { SettingsSection } from "./shell";
import {
  boolField,
  colorField,
  field,
  fieldsGrid,
  numField,
  selectField,
  swatchRow,
  textField,
} from "./widgets";

const ansiName = (key: string): string =>
  t(`settings.ansi.${key}` as MessageKey);

const ANSI_KEYS: (keyof TerminalColors)[] = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
];

const ANSI_BRIGHT_KEYS: (keyof TerminalColors)[] = [
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
];

function fontPicker(config: Config, save: () => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "font-picker";
  const failed = new Set<string>();

  const defaultFamily = (): string =>
    config.fonts.catalog.find((e) => e.kind === "builtin")?.id ??
    config.fonts.catalog[0]?.id ??
    "";

  function refresh(): void {
    void fontInstalled().then(render);
  }

  async function runAction(id: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      failed.delete(id);
    } catch {
      failed.add(id);
    } finally {
      refresh();
    }
  }

  async function install(id: string): Promise<void> {
    const row = wrap.querySelector<HTMLElement>(`[data-font="${id}"]`);
    row?.classList.add("downloading");
    try {
      await fontInstall(id);
      await registerFont(id, config.fonts);
    } finally {
      row?.classList.remove("downloading");
    }
  }

  function render(installed: string[]): void {
    wrap.replaceChildren();
    for (const entry of config.fonts.catalog) {
      const isInstalled =
        entry.kind === "builtin" || installed.includes(entry.id);
      const selected = config.font.family === entry.id;

      const row = document.createElement("label");
      row.className = "font-row";
      row.dataset.font = entry.id;
      if (selected) row.classList.add("selected");
      if (failed.has(entry.id)) row.classList.add("failed");

      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "font-family";
      radio.checked = selected;
      radio.onchange = () =>
        void runAction(entry.id, async () => {
          if (!isInstalled) await install(entry.id);
          config.font.family = entry.id;
          save();
        });

      const name = document.createElement("span");
      name.className = "font-name";
      name.textContent = entry.label;
      if (isInstalled)
        name.style.fontFamily = fontStack(entry.id, config.fonts);

      row.append(radio, name);

      if (entry.kind === "download") {
        const action = document.createElement("button");
        action.type = "button";
        action.className = "font-action";
        if (isInstalled) {
          action.textContent = t("settings.appearance.remove");
          action.onclick = () =>
            void runAction(entry.id, async () => {
              await fontRemove(entry.id);
              if (config.font.family === entry.id) {
                config.font.family = defaultFamily();
                save();
              }
            });
        } else {
          action.textContent = t("settings.appearance.download");
          action.onclick = () =>
            void runAction(entry.id, () => install(entry.id));
        }
        row.append(action);
      }

      wrap.append(row);

      if (selected && !isInstalled) {
        const warn = document.createElement("p");
        warn.className = "font-warning";
        warn.textContent = t("settings.appearance.fontMissing", {
          name: entry.label,
        });
        wrap.append(warn);
      } else if (failed.has(entry.id)) {
        const err = document.createElement("p");
        err.className = "font-error";
        err.textContent = t("settings.appearance.fontDownloadFailed", {
          name: entry.label,
        });
        wrap.append(err);
      }
    }
  }

  refresh();
  return wrap;
}

interface AppearanceTab {
  id: string;
  label: string;
  render: () => HTMLElement;
}

function buildAppearance(config: Config, save: () => void): HTMLElement {
  const terminal = config.theme.terminal;
  const ansiRow = (keys: (keyof TerminalColors)[]) =>
    swatchRow(
      keys.length,
      (i) => terminal[keys[i]],
      (i, v) => {
        terminal[keys[i]] = v;
      },
      save,
      (i) => ansiName(keys[i]),
    );

  const themesTab: AppearanceTab = {
    id: "temas",
    label: t("settings.appearance.tab.themes"),
    render: () => {
      const wrap = document.createElement("div");
      wrap.className = "themes-tab";
      wrap.append(themeGallery(config, save));
      return wrap;
    },
  };

  const interfaceTab: AppearanceTab = {
    id: "interfaz",
    label: t("settings.appearance.tab.interface"),
    render: () =>
      fieldsGrid([
        selectField(
          t("settings.language.label"),
          [
            ["en", t("settings.language.english")],
            ["es", t("settings.language.spanish")],
          ],
          config,
          "locale",
          save,
        ),
        field(
          t("settings.appearance.field.tabPalette"),
          swatchRow(
            config.theme.tabs.length,
            (i) => config.theme.tabs[i],
            (i, v) => {
              config.theme.tabs[i] = v;
            },
            save,
          ),
          { stack: true },
        ),
        numField(
          t("settings.appearance.field.sidebarWidth"),
          config.layout,
          "sidebar_width",
          {
            min: config.layout.sidebar_min_width,
            max: 600,
            desc: t("settings.appearance.field.sidebarWidthDesc"),
          },
          save,
        ),
        boolField(
          t("settings.appearance.field.dimInactive"),
          config.chrome,
          "dim_inactive",
          save,
          t("settings.appearance.field.dimInactiveDesc"),
        ),
        boolField(
          t("settings.appearance.field.paneAccent"),
          config.chrome,
          "pane_accent",
          save,
          t("settings.appearance.field.paneAccentDesc"),
        ),
        boolField(
          t("settings.appearance.field.tabAccentLine"),
          config.chrome,
          "tab_accent_line",
          save,
          t("settings.appearance.field.tabAccentLineDesc"),
        ),
        boolField(
          t("settings.appearance.field.activeTabHighlight"),
          config.chrome,
          "active_tab_highlight",
          save,
          t("settings.appearance.field.activeTabHighlightDesc"),
        ),
      ]),
  };

  const tabs: AppearanceTab[] = [
    interfaceTab,
    {
      id: "terminal",
      label: t("settings.appearance.tab.terminal"),
      render: () =>
        fieldsGrid([
          field(t("settings.appearance.field.font"), fontPicker(config, save), {
            stack: true,
          }),
          numField(
            t("settings.appearance.field.size"),
            config.font,
            "size",
            {
              min: config.limits.font_size_min,
              max: config.limits.font_size_max,
            },
            save,
          ),
          colorField(t("settings.appearance.field.bg"), terminal, "bg", save),
          colorField(t("settings.appearance.field.fg"), terminal, "fg", save),
          colorField(
            t("settings.appearance.field.cursor"),
            terminal,
            "cursor",
            save,
          ),
          field(t("settings.appearance.field.ansi"), ansiRow(ANSI_KEYS)),
          field(
            t("settings.appearance.field.ansiBright"),
            ansiRow(ANSI_BRIGHT_KEYS),
          ),
        ]),
    },
    {
      id: "editor",
      label: t("settings.appearance.tab.editor"),
      render: () =>
        fieldsGrid([
          colorField(
            t("settings.appearance.field.editorBg"),
            config.theme.editor,
            "bg",
            save,
          ),
          boolField(
            t("settings.appearance.field.vim"),
            config.editor,
            "vim",
            save,
          ),
          boolField(
            t("settings.appearance.field.wrapProse"),
            config.editor,
            "wrap_prose",
            save,
          ),
          textField(
            t("settings.appearance.field.proseWidth"),
            config.editor,
            "prose_width",
            save,
            "min(90%, 80ch)",
          ),
          boolField(
            t("settings.appearance.field.wrapCode"),
            config.editor,
            "wrap_code",
            save,
          ),
          textField(
            t("settings.appearance.field.codeWidth"),
            config.editor,
            "code_width",
            save,
            t("settings.appearance.field.codeWidthPlaceholder"),
          ),
        ]),
    },
    themesTab,
  ];

  let active = tabs[0].id;
  const sec = document.createElement("section");
  sec.className = "settings-section";
  const h = document.createElement("h2");
  h.textContent = t("settings.appearance.title");
  const desc = document.createElement("p");
  desc.className = "section-desc";
  desc.textContent = t("settings.appearance.desc");
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

export const appearanceSection: SettingsSection = {
  id: "appearance",
  label: () => t("settings.appearance.title"),
  searchText: () => t("settings.appearance.search"),
  build: (config, save) => buildAppearance(config, save),
};
