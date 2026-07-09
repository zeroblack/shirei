export type PaneContentKind = "terminal" | "file" | "browser";

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
  hasFile: boolean;
  recency: number;
}

// The pane a plain file-open lands in: the focused pane if it already holds a
// file (even while showing its terminal), else the most-recently-active pane
// that holds a file, else the focused pane, which becomes the file pane. Never
// null when panes exist, so a plain open reaches a tab only by overflow, never
// by accident.
export function pickFileTarget(
  candidates: FileTargetCandidate[],
): string | null {
  if (candidates.length === 0) return null;
  const withFile = candidates.filter((c) => c.hasFile);
  const focusedWithFile = withFile.find((c) => c.focused);
  if (focusedWithFile) return focusedWithFile.paneId;
  if (withFile.length > 0)
    return withFile.reduce((a, b) => (b.recency > a.recency ? b : a)).paneId;
  const focused = candidates.find((c) => c.focused);
  return (focused ?? candidates[0]).paneId;
}
