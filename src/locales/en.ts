import { commandsEn } from "./commands.en";
import { errorsEn } from "./errors.en";
import { settingsEn } from "./settings.en";
import { uiEn } from "./ui.en";

export const en = { ...commandsEn, ...errorsEn, ...settingsEn, ...uiEn };
export type MessageKey = keyof typeof en;
