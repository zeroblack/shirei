import type { MemoryStatus } from "./config";

export const promptLine = (prompt: string): string =>
  `${prompt.replace(/\s*\n\s*/g, " ").trim()}\r`;

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
