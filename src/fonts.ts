import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { FontsConfig } from "./config";

const BUILTIN_CSS: Record<string, string> = {
  meslo: "Meslo",
  jetbrains: "JetBrains Mono",
  hack: "Hack",
};

const FALLBACK = '"Menlo", "SF Mono", monospace';

const nerdFontFamily = (asset: string): string => `${asset} Nerd Font Mono`;

export function fontFamilyName(id: string, fonts: FontsConfig): string {
  const entry = fonts.catalog.find((e) => e.id === id);
  if (!entry) return "Meslo";
  if (entry.kind === "builtin") return BUILTIN_CSS[id] ?? "Meslo";
  return nerdFontFamily(entry.asset ?? entry.label);
}

export function fontStack(id: string, fonts: FontsConfig): string {
  return `"${fontFamilyName(id, fonts)}", ${FALLBACK}`;
}

export interface InstallProgress {
  id: string;
  phase: "downloading" | "writing" | "done";
}

export const fontInstall = (id: string) => invoke<void>("font_install", { id });
export const fontInstalled = () => invoke<string[]>("font_installed");
export const fontReadBytes = (id: string) =>
  invoke<number[]>("font_read", { id }).then((b) => new Uint8Array(b));
export const onInstallProgress = (cb: (p: InstallProgress) => void) =>
  listen<InstallProgress>("font-install-progress", (e) => cb(e.payload));

// Tracks faces loaded via the FontFace API. `document.fonts.check()` can't stand
// in for this: it returns true for a download family that has no FontFace yet
// (it assumes an available system font), so it can't tell "loaded" from "never
// loaded" and the download face would never get registered.
const loadedFaces = new Map<string, FontFace>();

export function isFontLoaded(id: string): boolean {
  return loadedFaces.has(id);
}

export const fontRemove = (id: string) => {
  const face = loadedFaces.get(id);
  if (face) {
    document.fonts.delete(face);
    loadedFaces.delete(id);
  }
  return invoke<void>("font_remove", { id });
};

async function loadFace(id: string, fonts: FontsConfig): Promise<void> {
  if (loadedFaces.has(id)) return;
  const family = fontFamilyName(id, fonts);
  const bytes = await fontReadBytes(id);
  const face = new FontFace(family, bytes);
  await face.load();
  document.fonts.add(face);
  loadedFaces.set(id, face);
}

export async function registerInstalledFonts(
  fonts: FontsConfig,
): Promise<void> {
  const ids = await fontInstalled();
  await Promise.allSettled(ids.map((id) => loadFace(id, fonts)));
}

export const registerFont = loadFace;
