function parseHex(hex: string): [number, number, number] {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const n = Number.parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: [number, number, number]): string {
  const clamp = (v: number): number =>
    Math.max(0, Math.min(255, Math.round(v)));
  const part = (v: number): string => clamp(v).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** Linear blend from `a` to `b`; t=0 → a, t=1 → b. */
export function mix(a: string, b: string, t: number): string {
  const pa = parseHex(a);
  const pb = parseHex(b);
  return toHex([
    pa[0] + (pb[0] - pa[0]) * t,
    pa[1] + (pb[1] - pa[1]) * t,
    pa[2] + (pb[2] - pa[2]) * t,
  ]);
}

export function alpha(hex: string, a: number): string {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export function hexToRgb(hex: string): [number, number, number] {
  return parseHex(hex);
}

function screenLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  const lin = (c: number): number => (c / 255) ** 2.4;
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// APCA (SAPC-based) lightness contrast, Lc 0..~108. Soft-clamps near-black so
// dark-on-dark pairs don't report a falsely high contrast.
export function apcaContrast(text: string, bg: string): number {
  // biome-ignore lint/suspicious/noApproximativeNumericConstant: APCA black soft-clamp exponent, not sqrt(2)
  const blackClampExp = 1.414;
  const clampBlack = (y: number): number =>
    y < 0.022 ? y + (0.022 - y) ** blackClampExp : y;
  const yText = clampBlack(screenLuminance(text));
  const yBg = clampBlack(screenLuminance(bg));
  const sapc =
    yBg > yText
      ? (yBg ** 0.56 - yText ** 0.57) * 1.14
      : (yBg ** 0.65 - yText ** 0.62) * 1.14;
  if (Math.abs(sapc) < 0.1) return 0;
  const lc = sapc > 0 ? sapc - 0.027 : sapc + 0.027;
  return Math.abs(lc * 100);
}

// Mixes `color` toward `fg` only as far as needed to clear `minLc` against `bg`.
// Keeps a palette's curated hue while guaranteeing legibility on any background
// (pure black through light themes), so no token ever renders invisible.
export function ensureContrast(
  color: string,
  bg: string,
  fg: string,
  minLc: number,
): string {
  if (apcaContrast(color, bg) >= minLc) return color;
  for (let t = 0.1; t < 1; t += 0.1) {
    const blended = mix(color, fg, t);
    if (apcaContrast(blended, bg) >= minLc) return blended;
  }
  return mix(color, fg, 1);
}

function oklchToHex(l: number, c: number, h: number): string {
  const hRad = (h * Math.PI) / 180;
  const a = c * Math.cos(hRad);
  const b = c * Math.sin(hRad);

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const l3 = l_ * l_ * l_;
  const m3 = m_ * m_ * m_;
  const s3 = s_ * s_ * s_;

  const rLin = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const gLin = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const bLin = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;

  const encode = (v: number): number => {
    const clamped = Math.min(1, Math.max(0, v));
    return clamped <= 0.0031308
      ? 12.92 * clamped
      : 1.055 * clamped ** (1 / 2.4) - 0.055;
  };
  return toHex([encode(rLin) * 255, encode(gLin) * 255, encode(bLin) * 255]);
}

interface StatusRole {
  token: string;
  l: number;
  c: number;
  h: number;
}

// Mirrors the OKLCH values in tokens.css (--status-working/waiting/done/error).
// Kept as numbers here (not parsed from the CSS custom property) so the floor
// search below can walk the OKLCH lightness axis directly.
const STATUS_ROLES: readonly StatusRole[] = [
  { token: "--status-working", l: 0.7, c: 0.06, h: 235 },
  { token: "--status-waiting", l: 0.8, c: 0.15, h: 82 },
  { token: "--status-done", l: 0.78, c: 0.14, h: 155 },
  { token: "--status-error", l: 0.64, c: 0.2, h: 25 },
];

// The 2px underline under a tab is a thin, low-area mark — legible needs a
// real APCA floor, not just "not zero". 42 is where the error role's spec
// lightness (0.64) needs its first real lift, landing around L 0.67-0.70 on
// the catalog's dark themes: exactly the "nudge to ~0.67" the design calls
// for, reached by measurement rather than hardcoded.
export const STATUS_MIN_LC = 42;
const STATUS_LIGHTNESS_STEP = 0.01;
const STATUS_LIGHTNESS_MAX_STEPS = 60;

// Walks the OKLCH lightness axis only (hue and chroma fixed) toward whichever
// end clears the background, so a role keeps its curated hue instead of
// desaturating toward the theme's fg like the generic ensureContrast mix.
// `minLc` defaults to the status-badge floor but is exposed so other role
// systems (e.g. the focus-timer skins) can walk toward their own floor
// without duplicating this search.
export function deriveRoleColor(
  role: { l: number; c: number; h: number },
  bg: string,
  minLc: number = STATUS_MIN_LC,
): string {
  const base = oklchToHex(role.l, role.c, role.h);
  if (apcaContrast(base, bg) >= minLc) return base;
  const step =
    screenLuminance(bg) < 0.5 ? STATUS_LIGHTNESS_STEP : -STATUS_LIGHTNESS_STEP;
  let l = role.l;
  let hex = base;
  for (let i = 0; i < STATUS_LIGHTNESS_MAX_STEPS; i++) {
    l = Math.min(1, Math.max(0, l + step));
    hex = oklchToHex(l, role.c, role.h);
    if (apcaContrast(hex, bg) >= minLc || l <= 0 || l >= 1) break;
  }
  return hex;
}

// Derives the four status-role colors against a theme's tab background,
// APCA-validated per role (see colors.test.ts, which checks every catalog
// theme plus pure black).
export function deriveStatusColors(bg: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const role of STATUS_ROLES) out[role.token] = deriveRoleColor(role, bg);
  return out;
}

export interface GitRole {
  token: string;
  l: number;
  c: number;
  h: number;
  minLc: number;
}

// Conflict takes a lower floor than the rest on purpose: forced to 60 the
// lightness walk washes it to pink and it stops reading as an alarm. Its
// legibility comes from the knockout letter on the solid chip.
export const GIT_ROLES: readonly GitRole[] = [
  { token: "--git-modified", l: 0.8, c: 0.13, h: 85, minLc: 60 },
  { token: "--git-new", l: 0.78, c: 0.14, h: 150, minLc: 60 },
  { token: "--git-renamed", l: 0.76, c: 0.1, h: 255, minLc: 60 },
  { token: "--git-deleted", l: 0.62, c: 0.02, h: 25, minLc: 60 },
  { token: "--git-conflict", l: 0.62, c: 0.2, h: 25, minLc: 45 },
];

// Derives the five git-status role colors against a theme's tab background,
// APCA-validated per role in both directions (see colors.test.ts).
export function deriveGitColors(bg: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const role of GIT_ROLES)
    out[role.token] = deriveRoleColor(role, bg, role.minLc);
  return out;
}
