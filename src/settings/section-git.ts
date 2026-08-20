import { t } from "../i18n";
import type { SettingsSection } from "./shell";
import { boolField, numField, section, selectField } from "./widgets";

export const gitSection: SettingsSection = {
  id: "git",
  label: () => t("settings.git.label"),
  searchText: () => t("settings.git.search"),
  build: (config, save) => {
    const g = config.git;
    return section(
      t("settings.git.title"),
      [
        boolField(
          t("settings.git.blameEnabled"),
          g.blame,
          "enabled",
          save,
          t("settings.git.blameEnabledDesc"),
        ),
        numField(
          t("settings.git.blameDelay"),
          g.blame,
          "delay_ms",
          {
            min: 0,
            max: 2000,
            step: 20,
            desc: t("settings.git.blameDelayDesc"),
          },
          save,
        ),
        selectField(
          t("settings.git.historyView"),
          [
            ["diff", t("settings.git.historyViewDiff")],
            ["working", t("settings.git.historyViewWorking")],
            ["full", t("settings.git.historyViewFull")],
          ],
          g.history,
          "default_view",
          save,
          t("settings.git.historyViewDesc"),
        ),
        boolField(
          t("settings.git.statusInTree"),
          g.status,
          "status_in_tree",
          save,
          t("settings.git.statusInTreeDesc"),
        ),
        boolField(
          t("settings.git.showDeleted"),
          g.status,
          "show_deleted",
          save,
          t("settings.git.showDeletedDesc"),
        ),
      ],
      t("settings.git.desc"),
    );
  },
};
