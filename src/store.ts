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
    }
  | { kind: "editor"; path: string; lastUsedAt?: number; pinned?: boolean };

const SESSION_KEY_BASE = "shirei.session.v1";

function sessionKey(): string {
  const { label } = getCurrentWindow();
  return label === "main" ? SESSION_KEY_BASE : `${SESSION_KEY_BASE}:${label}`;
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
