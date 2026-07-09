import { t } from "../i18n";
import type { SettingsSection } from "./shell";
import {
  boolField,
  numField,
  section,
  selectField,
  textField,
} from "./widgets";

export const browserSection: SettingsSection = {
  id: "browser",
  label: () => t("settings.browser.label"),
  searchText: () => t("settings.browser.search"),
  build: (config, save) => {
    const b = config.browser;
    return section(
      t("settings.browser.title"),
      [
        boolField(
          t("settings.browser.enabled"),
          b,
          "enabled",
          save,
          t("settings.browser.enabledDesc"),
        ),
        textField(
          t("settings.browser.homeUrl"),
          b,
          "home_url",
          save,
          t("settings.browser.homeUrlPlaceholder"),
          t("settings.browser.homeUrlDesc"),
        ),
        selectField(
          t("settings.browser.colorScheme"),
          [
            ["dark", t("settings.browser.colorScheme.dark")],
            ["light", t("settings.browser.colorScheme.light")],
            ["auto", t("settings.browser.colorScheme.auto")],
            ["theme", t("settings.browser.colorScheme.theme")],
          ],
          b,
          "color_scheme",
          save,
          t("settings.browser.colorSchemeDesc"),
        ),
        boolField(
          t("settings.browser.autoHide"),
          b,
          "auto_hide_chrome",
          save,
          t("settings.browser.autoHideDesc"),
        ),
        numField(
          t("settings.browser.autoHideDelay"),
          b,
          "auto_hide_delay_ms",
          { min: 0.5, max: 15, step: 0.5, scale: 1000 },
          save,
        ),
      ],
      t("settings.browser.desc"),
    );
  },
};
