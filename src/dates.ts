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
