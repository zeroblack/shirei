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
