import { commandsEs } from "./commands.es";
import type { MessageKey } from "./en";
import { errorsEs } from "./errors.es";
import { settingsEs } from "./settings.es";
import { uiEs } from "./ui.es";

export const es: Record<MessageKey, string> = {
  ...commandsEs,
  ...errorsEs,
  ...settingsEs,
  ...uiEs,
};
