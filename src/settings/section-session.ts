import type { ConfirmPolicy, RestoreCommands } from "../config";
import { t } from "../i18n";
import type { SettingsSection } from "./shell";
import { boolField, groupLabel, section, selectField } from "./widgets";

const CONFIRM_POLICY_OPTIONS = (): [ConfirmPolicy, string][] => [
  ["running-only", t("settings.sessions.confirm.runningOnly")],
  ["always", t("settings.sessions.confirm.always")],
  ["never", t("settings.sessions.confirm.never")],
];

const RESTORE_COMMANDS_OPTIONS = (): [RestoreCommands, string][] => [
  ["all", t("settings.sessions.restore.all")],
  ["templates", t("settings.sessions.restore.templates")],
  ["never", t("settings.sessions.restore.never")],
];

export const sessionSection: SettingsSection = {
  id: "sessions",
  label: () => t("settings.sessions.label"),
  searchText: () => t("settings.sessions.search"),
  build: (config, save) =>
    section(
      t("settings.sessions.title"),
      [
        groupLabel(t("settings.sessions.group.persistence")),
        boolField(
          t("settings.sessions.keepAlive"),
          config.session,
          "keep_alive",
          save,
          t("settings.sessions.keepAliveDesc"),
        ),
        boolField(
          t("settings.sessions.autostart"),
          config.session,
          "autostart_daemon",
          save,
        ),
        selectField(
          t("settings.sessions.restoreCommands"),
          RESTORE_COMMANDS_OPTIONS(),
          config.session,
          "restore_commands",
          save,
          t("settings.sessions.restoreCommandsDesc"),
        ),
        groupLabel(t("settings.sessions.group.confirmations")),
        selectField(
          t("settings.sessions.confirmKill"),
          CONFIRM_POLICY_OPTIONS(),
          config.session,
          "confirm_kill",
          save,
        ),
        selectField(
          t("settings.sessions.confirmClose"),
          CONFIRM_POLICY_OPTIONS(),
          config.session,
          "confirm_close",
          save,
        ),
      ],
      t("settings.sessions.desc"),
    ),
};
