export type GitKind =
  | "modified"
  | "added"
  | "untracked"
  | "deleted"
  | "renamed"
  | "conflicted";

export interface GitFileStatus {
  path: string;
  kind: GitKind;
  staged: boolean;
  unstaged: boolean;
}

export type Stage = "none" | "partial" | "full";

export interface FolderSummary {
  total: number;
  conflicts: number;
}

const LETTERS: Record<GitKind, string> = {
  modified: "M",
  added: "A",
  untracked: "U",
  deleted: "D",
  renamed: "R",
  conflicted: "!",
};

export const letterOf = (kind: GitKind): string => LETTERS[kind];

export function stageOf(s: GitFileStatus): Stage {
  if (s.staged && s.unstaged) return "partial";
  return s.staged ? "full" : "none";
}

export const statusMap = (files: GitFileStatus[]): Map<string, GitFileStatus> =>
  new Map(files.map((f) => [f.path, f]));

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf("/"));

export function folderSummaries(
  files: GitFileStatus[],
  root: string,
): Map<string, FolderSummary> {
  const out = new Map<string, FolderSummary>();
  for (const file of files) {
    const conflict = file.kind === "conflicted" ? 1 : 0;
    let dir = parentOf(file.path);
    while (dir.length >= root.length && dir.startsWith(root)) {
      const prev = out.get(dir) ?? { total: 0, conflicts: 0 };
      out.set(dir, {
        total: prev.total + 1,
        conflicts: prev.conflicts + conflict,
      });
      if (dir === root) break;
      dir = parentOf(dir);
    }
  }
  return out;
}

export const countLabel = (total: number): string =>
  total <= 0 ? "" : total > 9 ? "9+" : String(total);

export const deletedIn = (files: GitFileStatus[], dir: string): string[] =>
  files
    .filter((f) => f.kind === "deleted" && parentOf(f.path) === dir)
    .map((f) => f.path);
