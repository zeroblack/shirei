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
