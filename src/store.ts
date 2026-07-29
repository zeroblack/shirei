import { getCurrentWindow } from "@tauri-apps/api/window";
import type { PaneNode } from "./panetree";

export type SavedTab =
  | {
      kind: "terminal";
      tree: PaneNode;
      projectId?: string;
      title: string;
      color: string | null;
      lastUsedAt?: number;
      pinned?: boolean;
      active?: boolean;
    }
  | {
      kind: "editor";
      path: string;
      lastUsedAt?: number;
      pinned?: boolean;
      active?: boolean;
    };

export type PinnedCellSave =
  | { kind: "browser"; url: string }
  | { kind: "terminal" }
  | { kind: "timer"; preset?: string; name?: string };

const SESSION_KEY_BASE = "shirei.session.v1";
const PIN_KEY_BASE = "shirei.pindock.v1";

function scopedKey(base: string): string {
  const { label } = getCurrentWindow();
  return label === "main" ? base : `${base}:${label}`;
}

function sessionKey(): string {
  return scopedKey(SESSION_KEY_BASE);
}

function isPaneNode(n: unknown): n is PaneNode {
  if (!n || typeof n !== "object") return false;
  const node = n as Record<string, unknown>;
  if (node.kind === "leaf") return typeof node.id === "string";
  if (node.kind === "split") {
    return (
      (node.dir === "h" || node.dir === "v") &&
      typeof node.ratio === "number" &&
      isPaneNode(node.a) &&
      isPaneNode(node.b)
    );
  }
  return false;
}

export function loadSession(): SavedTab[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(sessionKey()) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t) => {
      if (!t) return false;
      if (t.kind === "editor") return typeof t.path === "string";
      if (t.kind === "terminal") return isPaneNode(t.tree);
      return false;
    });
  } catch {
    return [];
  }
}

export function saveSession(tabs: SavedTab[]): void {
  localStorage.setItem(sessionKey(), JSON.stringify(tabs));
}

export function clearSession(): void {
  localStorage.removeItem(sessionKey());
}

export function savePinDock(cells: (PinnedCellSave | null)[]): void {
  localStorage.setItem(scopedKey(PIN_KEY_BASE), JSON.stringify(cells));
}

export function loadPinDock(): (PinnedCellSave | null)[] {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(scopedKey(PIN_KEY_BASE)) ?? "[]",
    );
    if (!Array.isArray(parsed)) return [];
    return parsed.map((c) => {
      if (c?.kind === "browser" && typeof c.url === "string") return c;
      if (c?.kind === "terminal") return { kind: "terminal" as const };
      if (c?.kind === "timer") {
        return {
          kind: "timer" as const,
          ...(typeof c.preset === "string" ? { preset: c.preset } : {}),
          ...(typeof c.name === "string" ? { name: c.name } : {}),
        };
      }
      return null;
    });
  } catch {
    return [];
  }
}
