import { openConfigFile } from "../config";
import { t } from "../i18n";
import type { SettingsSection } from "./shell";
import {
  boolField,
  field,
  groupLabel,
  numField,
  section,
  textInput,
} from "./widgets";

const BYTES_PER_MB = 1024 * 1024;

function openConfigButton(): HTMLElement {
  const btn = document.createElement("button");
  btn.className = "settings-action";
  btn.textContent = t("settings.advanced.openConfig");
  btn.addEventListener("click", () => void openConfigFile());
  return btn;
}

export const advancedSection: SettingsSection = {
  id: "advanced",
  label: () => t("settings.advanced.label"),
  searchText: () => t("settings.advanced.search"),
  build: (config, save) =>
    section(
      t("settings.advanced.title"),
      [
        groupLabel(t("settings.advanced.group.limits")),
        numField(
          t("settings.advanced.maxFile"),
          config.limits,
          "max_file_bytes",
          { min: 1, max: 100, scale: BYTES_PER_MB },
          save,
        ),
        numField(
          t("settings.advanced.maxImage"),
          config.limits,
          "max_image_bytes",
          { min: 1, max: 200, scale: BYTES_PER_MB },
          save,
        ),
        numField(
          t("settings.advanced.indexCap"),
          config.limits,
          "index_cap",
          { min: 1000, max: 1000000 },
          save,
        ),
        numField(
          t("settings.advanced.quickopenResults"),
          config.limits,
          "quickopen_results",
          { min: 10, max: 500 },
          save,
        ),
        numField(
          t("settings.advanced.dirEntriesCap"),
          config.limits,
          "dir_entries_cap",
          { min: 100, max: 50000 },
          save,
        ),
        groupLabel(t("settings.advanced.group.searchFiles")),
        field(
          t("settings.advanced.excludeDirs"),
          textInput(config.files.exclude_dirs.join(", "), (v) => {
            config.files.exclude_dirs = v
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            save();
          }),
        ),
        boolField(
          t("settings.advanced.respectGitignore"),
          config.files,
          "respect_gitignore",
          save,
          t("settings.advanced.respectGitignoreDesc"),
        ),
        groupLabel(t("settings.advanced.group.config")),
        field(t("settings.advanced.configFile"), openConfigButton()),
      ],
      t("settings.advanced.desc"),
    ),
};
