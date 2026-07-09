export function normalizeUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.toString();
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Child webview bounds are parent-window-relative logical units, not screen
// coordinates: with titleBarStyle Overlay + hiddenTitle the main webview fills
// the window's contentView, so CSS viewport coordinates already are the child
// coordinate space. No window origin or display scale enters this math.
export function contentBounds(rect: Rect, chromeH: number): Bounds {
  return {
    x: rect.left,
    y: rect.top + chromeH,
    width: Math.max(1, rect.width),
    height: Math.max(1, rect.height - chromeH),
  };
}

export function shouldShowBrowser(v: {
  paneActive: boolean;
  contentFrontmost: boolean;
  overlayOpen: boolean;
}): boolean {
  return v.paneActive && v.contentFrontmost && !v.overlayOpen;
}

export type BrowserColorSchemeMode = "dark" | "light" | "auto" | "theme";

// The backend only ever sets what it is told (native macOS has no cross-mode
// "auto" concept it can apply itself), so "auto"/"theme" resolve here, where
// the app's theme preset and the OS media query are both already known.
export function resolveColorScheme(
  mode: BrowserColorSchemeMode,
  themePreset: "dark" | "light",
  prefersDark: boolean,
): "dark" | "light" {
  if (mode === "theme") return themePreset;
  if (mode === "auto") return prefersDark ? "dark" : "light";
  return mode;
}
