import type { MemoryStatus } from "./config";
import type { Confidence, SessionState } from "./sessionstate";

export const promptLine = (prompt: string): string =>
  `${prompt.replace(/\s*\n\s*/g, " ").trim()}\r`;

export const resolveTemplate = (override: string, fallback: string): string =>
  override.trim() ? override : fallback;

// Autosave only ever fires on the transition into a high-confidence "done":
// a "waiting" agent is asking the user something, and typing the save prompt
// into the terminal would answer that prompt with prose instead of an answer.
export function shouldAutosave(
  prev: SessionState | undefined,
  next: SessionState,
  confidence: Confidence,
  lastFiredAt: number | undefined,
  cooldownMin: number,
  now: number,
): boolean {
  if (next.kind !== "done" || confidence !== "high") return false;
  if (prev?.kind === "done") return false;
  if (lastFiredAt !== undefined && now - lastFiredAt < cooldownMin * 60_000) {
    return false;
  }
  return true;
}

export function memoryBadgeState(
  status: MemoryStatus | null,
  resumeStaleHours: number,
): "ok" | "stale" | undefined {
  if (!status?.exists) return undefined;
  const resumeStale =
    status.resume_age_hours !== null &&
    status.resume_age_hours > resumeStaleHours;
  return status.stale || resumeStale ? "stale" : "ok";
}

// A project is only ever offered the seed prompt once per app run: a
// declining agent should not get nagged again on every idle transition.
// The gate is "filled in", not "present": the app's own "open memory" action
// creates an empty skeleton, and that must still be seeded.
export function shouldBootstrapMemory(
  active: boolean,
  status: Pick<MemoryStatus, "exists" | "overview_filled"> | null,
  prev: SessionState | undefined,
  next: SessionState,
  confidence: Confidence,
  alreadySeeded: boolean,
): boolean {
  const filled = status ? status.exists && status.overview_filled : true;
  if (!active || filled || alreadySeeded) return false;
  if (next.kind !== "done" || confidence !== "high") return false;
  if (prev?.kind === "done") return false;
  return true;
}
