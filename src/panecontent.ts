export type PaneContentKind = "terminal" | "file";

export interface PaneContentSession {
  open(): Promise<void>;
  show(visible: boolean): void;
  focus(): void;
  dispose(): void | Promise<void>;
}

export function nextIndex(len: number, current: number, dir: 1 | -1): number {
  if (len <= 1) return current;
  return (current + dir + len) % len;
}

export function canAdd(stackLen: number, cap: number): boolean {
  return stackLen < cap;
}

export interface FileTargetCandidate {
  paneId: string;
  focused: boolean;
  activeIsFile: boolean;
  recency: number;
}

export function pickFileTarget(
  candidates: FileTargetCandidate[],
): string | null {
  const eligible = candidates.filter((c) => c.activeIsFile);
  if (eligible.length === 0) return null;
  const focused = eligible.find((c) => c.focused);
  if (focused) return focused.paneId;
  return eligible.reduce((a, b) => (b.recency > a.recency ? b : a)).paneId;
}
