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
