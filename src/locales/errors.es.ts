import type { errorsEn } from "./errors.en";

export const errorsEs: Record<keyof typeof errorsEn, string> = {
  "error.screencast-permission-denied":
    "Concede Screen Recording en Ajustes y reinicia Shirei",
  "error.screencast-unsupported": "Tu versión de macOS no soporta la grabación",
};
