import { t } from "../i18n";
import type { SettingsSection } from "./shell";
import {
  boolField,
  groupLabel,
  numField,
  pathField,
  section,
  selectField,
  textField,
} from "./widgets";

export const recordingSection: SettingsSection = {
  id: "recording",
  label: () => t("settings.recording.label"),
  searchText: () => t("settings.recording.search"),
  build: (config, save) => {
    const r = config.recorder;
    return section(
      t("settings.recording.title"),
      [
        groupLabel(t("settings.recording.group.output")),
        pathField(
          t("settings.recording.dir"),
          config.recorder.dir,
          (path) => {
            config.recorder.dir = path;
            save();
          },
          {
            placeholder: t("settings.recording.dirPlaceholder"),
            browseLabel: t("settings.recording.chooseFolder"),
          },
        ),
        selectField(
          t("settings.recording.format"),
          [
            ["mp4", t("settings.recording.format.mp4")],
            ["gif", t("settings.recording.format.gif")],
          ],
          r,
          "format",
          save,
        ),
        selectField(
          t("settings.recording.onFinish"),
          [
            ["ask", t("settings.recording.onFinish.ask")],
            ["copy", t("settings.recording.onFinish.copy")],
            ["reveal", t("settings.recording.onFinish.reveal")],
            ["share", t("settings.recording.onFinish.share")],
            ["none", t("settings.recording.onFinish.none")],
          ],
          r,
          "on_finish",
          save,
        ),
        textField(
          t("settings.recording.filename"),
          r,
          "filename_template",
          save,
          t("settings.recording.filenamePlaceholder"),
        ),
        groupLabel(t("settings.recording.group.quality")),
        numField(
          t("settings.recording.fps"),
          r,
          "fps",
          { min: 5, max: 60 },
          save,
        ),
        numField(
          t("settings.recording.gifFps"),
          r,
          "gif_fps",
          { min: 5, max: 30 },
          save,
        ),
        numField(
          t("settings.recording.gifMaxWidth"),
          r,
          "gif_max_width",
          { min: 200, max: 2000 },
          save,
        ),
        groupLabel(t("settings.recording.group.capture")),
        boolField(t("settings.recording.showCursor"), r, "show_cursor", save),
        numField(
          t("settings.recording.countdown"),
          r,
          "countdown_secs",
          { min: 0, max: 10 },
          save,
        ),
        numField(
          t("settings.recording.maxDuration"),
          r,
          "max_duration_secs",
          { min: 0, max: 3600 },
          save,
        ),
      ],
      t("settings.recording.desc"),
    );
  },
};
