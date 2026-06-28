import { getLocale, t } from "./i18n";

const WEEKDAYS = [
  "domingo",
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
];

function iso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(now: Date, n: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + n);
}

// Intentionally bilingual: accepts both Spanish (mañana, en N días, weekday names)
// and English (tomorrow, in N days) natural-language tokens as user input.
export function parseNaturalDate(input: string, now: Date): string | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (s === "hoy" || s === "today") return iso(now);
  if (s === "mañana" || s === "manana" || s === "tomorrow")
    return iso(addDays(now, 1));
  if (s === "pasado mañana" || s === "pasado manana")
    return iso(addDays(now, 2));

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : s;
  }

  const inDays = s.match(/^(?:in|en)\s+(\d+)\s+(?:days?|d[ií]as?)$/);
  if (inDays) return iso(addDays(now, Number(inDays[1])));

  const wd = WEEKDAYS.indexOf(
    s.replace("miercoles", "miércoles").replace("sabado", "sábado"),
  );
  if (wd >= 0) {
    const delta = (wd - now.getDay() + 7) % 7 || 7;
    return iso(addDays(now, delta));
  }
  return null;
}

export function relativeTime(epochSecs: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - epochSecs));
  if (secs < 60) return t("ui.time.now");
  const mins = Math.floor(secs / 60);
  if (mins < 60)
    return t(mins === 1 ? "ui.time.minute" : "ui.time.minutes", { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24)
    return t(hours === 1 ? "ui.time.hour" : "ui.time.hours", { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 30)
    return t(days === 1 ? "ui.time.day" : "ui.time.days", { n: days });
  const months = Math.floor(days / 30);
  if (months < 12)
    return t(months === 1 ? "ui.time.month" : "ui.time.months", { n: months });
  const years = Math.floor(days / 365);
  return t(years === 1 ? "ui.time.year" : "ui.time.years", { n: years });
}

export function compactAge(epochSecs: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - epochSecs));
  if (secs < 60) return t("ui.tabbar.ageNow");
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}d`;
  return `${Math.floor(days / 365)}y`;
}

export function absoluteDate(epochSecs: number): string {
  return new Date(epochSecs * 1000).toLocaleDateString(getLocale(), {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
