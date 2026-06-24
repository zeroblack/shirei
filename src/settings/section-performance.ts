import { t } from "../i18n";
import type { SettingsSection } from "./shell";
import { boolField, groupLabel, numField, section } from "./widgets";

export const performanceSection: SettingsSection = {
  id: "performance",
  label: () => t("settings.performance.label"),
  searchText: () => t("settings.performance.search"),
  build: (config, save) => {
    const p = config.performance;
    const m = p.metrics;
    return section(
      t("settings.performance.title"),
      [
        groupLabel(t("settings.performance.group.bar")),
        boolField(t("settings.performance.enabled"), p, "enabled", save),
        numField(
          t("settings.performance.refresh"),
          p,
          "refresh_secs",
          { min: 1, max: 30 },
          save,
        ),
        boolField(t("settings.performance.sparklines"), p, "sparklines", save),
        groupLabel(t("settings.performance.group.tabMetrics")),
        boolField(t("settings.performance.cpuTab"), m, "cpu_tab", save),
        boolField(t("settings.performance.memTab"), m, "mem_tab", save),
        boolField(t("settings.performance.diskTab"), m, "disk_tab", save),
        boolField(t("settings.performance.netTab"), m, "net_tab", save),
        groupLabel(t("settings.performance.group.appMetrics")),
        boolField(t("settings.performance.cpuApp"), m, "cpu_app", save),
        boolField(t("settings.performance.memApp"), m, "mem_app", save),
        boolField(t("settings.performance.diskApp"), m, "disk_app", save),
        boolField(t("settings.performance.netApp"), m, "net_app", save),
        groupLabel(t("settings.performance.group.thresholds")),
        numField(
          t("settings.performance.warn"),
          p.thresholds,
          "warn",
          { min: 1, max: 100 },
          save,
        ),
        numField(
          t("settings.performance.crit"),
          p.thresholds,
          "crit",
          { min: 1, max: 100 },
          save,
        ),
      ],
      t("settings.performance.desc"),
    );
  },
};
