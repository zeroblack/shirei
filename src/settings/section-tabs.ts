import { allTemplates, binaryOnPath, type Config } from "../config";
import { t } from "../i18n";
import { declaredCommands } from "../panetree";
import type { SettingsSection } from "./shell";
import { boolField, pathField, section, selectField } from "./widgets";

const SIMPLE = "";

function newTabDirField(config: Config, save: () => void): HTMLElement {
  return pathField(
    t("settings.tabs.newTabDir"),
    config.layout.new_tab_dir,
    (path) => {
      config.layout.new_tab_dir = path;
      save();
    },
    {
      placeholder: t("settings.tabs.newTabDirPlaceholder"),
      browseLabel: t("settings.tabs.chooseFolder"),
      desc: t("settings.tabs.newTabDirDesc"),
      reset: { label: t("settings.tabs.useHome"), value: "" },
    },
  );
}

function defaultLayoutField(config: Config, save: () => void): HTMLElement {
  const templates = allTemplates(config);
  const options: [string, string][] = [
    [SIMPLE, t("settings.tabs.simpleTab")],
    ...templates.map((tpl): [string, string] => [tpl.name, tpl.name]),
  ];
  const row = selectField(
    t("settings.tabs.defaultLayout"),
    options,
    config.layout,
    "default_template",
    save,
    t("settings.tabs.defaultLayoutDesc"),
  );

  const selected = templates.find(
    (tpl) => tpl.name === config.layout.default_template,
  );
  if (selected) {
    void Promise.all(
      declaredCommands(selected.tree).map(async (c) => ({
        c,
        ok: await binaryOnPath(c),
      })),
    ).then((checks) => {
      const missing = checks.filter((x) => !x.ok).map((x) => x.c);
      if (missing.length === 0) return;
      const warn = document.createElement("span");
      warn.className = "field-desc";
      warn.textContent = t("settings.tabs.missingCommand", {
        commands: missing.join(", "),
      });
      row.querySelector(".field-text")?.appendChild(warn);
    });
  }
  return row;
}

export const tabsSection: SettingsSection = {
  id: "tabs",
  label: () => t("settings.tabs.label"),
  searchText: () => t("settings.tabs.search"),
  build: (config, save) =>
    section(
      t("settings.tabs.title"),
      [
        defaultLayoutField(config, save),
        newTabDirField(config, save),
        boolField(t("settings.tabs.showAge"), config.tabs, "show_age", save),
      ],
      t("settings.tabs.desc"),
    ),
};
