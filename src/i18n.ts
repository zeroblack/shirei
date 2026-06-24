import { en, type MessageKey } from "./locales/en";
import { es } from "./locales/es";

export type Locale = "en" | "es";
export type { MessageKey };

const catalogs: Record<Locale, Record<MessageKey, string>> = { en, es };
let current: Locale = "en";
const listeners = new Set<() => void>();

export function setLocale(locale: Locale): void {
  if (typeof document !== "undefined") document.documentElement.lang = locale;
  if (locale === current) return;
  current = locale;
  for (const notify of listeners) notify();
}

export function getLocale(): Locale {
  return current;
}

export function onLocaleChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function t(
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  const template = catalogs[current][key] ?? en[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}
