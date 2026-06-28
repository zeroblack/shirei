import { t } from "../i18n";
import type { SettingsSection } from "./shell";
import { boolField, groupLabel, section, textField } from "./widgets";

export const editorSection: SettingsSection = {
  id: "editor",
  label: () => t("settings.editor.label"),
  searchText: () => t("settings.editor.search"),
  build: (config, save) => {
    const e = config.editor;
    return section(
      t("settings.editor.title"),
      [
        groupLabel(t("settings.editor.group.markdown")),
        boolField(
          t("settings.editor.livePreview"),
          e,
          "live_preview",
          save,
          t("settings.editor.livePreviewDesc"),
        ),
        groupLabel(t("settings.editor.group.editing")),
        boolField(
          t("settings.editor.vim"),
          e,
          "vim",
          save,
          t("settings.editor.vimDesc"),
        ),
        boolField(t("settings.editor.lineNumbers"), e, "line_numbers", save),
        boolField(t("settings.editor.activeLine"), e, "active_line", save),
        boolField(
          t("settings.editor.bracketMatching"),
          e,
          "bracket_matching",
          save,
        ),
        boolField(t("settings.editor.indentGuides"), e, "indent_guides", save),
        boolField(t("settings.editor.folding"), e, "folding", save),
        boolField(
          t("settings.editor.closeBrackets"),
          e,
          "close_brackets",
          save,
        ),
        groupLabel(t("settings.editor.group.prose")),
        boolField(t("settings.editor.wrapProse"), e, "wrap_prose", save),
        textField(
          t("settings.editor.proseWidth"),
          e,
          "prose_width",
          save,
          "min(90%, 80ch)",
          t("settings.editor.proseWidthDesc"),
        ),
        boolField(t("settings.editor.wrapCode"), e, "wrap_code", save),
        textField(
          t("settings.editor.codeWidth"),
          e,
          "code_width",
          save,
          t("settings.editor.codeWidthPlaceholder"),
        ),
        groupLabel(t("settings.editor.group.search")),
        boolField(
          t("settings.editor.highlightMatches"),
          e,
          "highlight_matches",
          save,
        ),
        boolField(t("settings.editor.searchCase"), e, "search_case", save),
        boolField(t("settings.editor.searchRegex"), e, "search_regex", save),
        boolField(
          t("settings.editor.searchWholeWord"),
          e,
          "search_whole_word",
          save,
        ),
      ],
      t("settings.editor.desc"),
    );
  },
};
