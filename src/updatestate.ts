export type UpdateStateKind =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "uptodate"
  | "error";

export interface UpdateState {
  kind: UpdateStateKind;
  version?: string;
  notes?: string;
  progress?: number;
  message?: string;
}

// Numeric dotted compare (0.10.0 > 0.9.9). The updater only serves versions we
// tag, which are always plain semver, so a full semver parser is overkill.
export function isNewer(current: string, candidate: string): boolean {
  const a = current.split(".").map((n) => Number.parseInt(n, 10));
  const b = candidate.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (y > x) return true;
    if (y < x) return false;
  }
  return false;
}
