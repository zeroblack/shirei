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
            ["full", t("settings.git.historyViewFull")],
          ],
          g.history,
          "default_view",
          save,
          t("settings.git.historyViewDesc"),
        ),
      ],
      t("settings.git.desc"),
    );
  },
};
