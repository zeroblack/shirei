import { t } from "./i18n";
import type { DirEntry } from "./types";

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

export type GitRefreshDecision = "run" | "skip" | "defer";

/** The single-flight guard every refresh trigger checks before fetching.
 *  "skip" means there is nothing worth fetching (disabled, no tree root open
 *  yet, or the sidebar is hidden so nobody would see the result). "defer"
 *  means a fetch is already in flight for a root that
 *  is still worth watching, so the caller should coalesce this trigger into
 *  one more run right after the current one finishes, rather than drop it
 *  outright and risk painting stale marks until an unrelated event fires. */
export function gitRefreshDecision(opts: {
  statusInTree: boolean;
  root: string | null;
  panelVisible: boolean;
  inFlight: boolean;
}): GitRefreshDecision {
  if (!opts.statusInTree || opts.root === null || !opts.panelVisible)
    return "skip";
  return opts.inFlight ? "defer" : "run";
}

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf("/"));

export function folderSummaries(
  files: GitFileStatus[],
  root: string,
): Map<string, FolderSummary> {
  const out = new Map<string, FolderSummary>();
  for (const file of files) {
    const conflict = file.kind === "conflicted" ? 1 : 0;
    let dir = parentOf(file.path);
    while (dir === root || dir.startsWith(`${root}/`)) {
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

// Mirrors the backend's own order (fs.rs: dirs first, then
// name.to_lowercase() in code-point order) so a deleted file merging into a
// listing never reorders it — a locale-aware collation (Intl/localeCompare)
// diverges from that ordinal comparison on accented names.
export function compareEntries(a: DirEntry, b: DirEntry): number {
  if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  return an < bn ? -1 : an > bn ? 1 : 0;
}

export function insertGhosts(
  entries: DirEntry[],
  ghosts: DirEntry[],
): DirEntry[] {
  if (ghosts.length === 0) return entries;
  const merged = entries.slice();
  for (const ghost of ghosts.slice().sort(compareEntries)) {
    let i = merged.length;
    while (i > 0 && compareEntries(merged[i - 1], ghost) > 0) i--;
    merged.splice(i, 0, ghost);
  }
  return merged;
}

export type MarkKind = GitKind | "count" | "conflict-dot";

export interface MarkView {
  text: string;
  kind: MarkKind | null;
  stage: Stage | null;
  conflicted: boolean;
  label: string;
}

const EMPTY_MARK: MarkView = {
  text: "",
  kind: null,
  stage: null,
  conflicted: false,
  label: "",
};

const STAGE_KEY: Record<Stage, "staged" | "partiallyStaged" | "unstaged"> = {
  full: "staged",
  partial: "partiallyStaged",
  none: "unstaged",
};

function statusLabel(kind: GitKind, stage: Stage | null): string {
  const kindLabel = t(`ui.git.status.${kind}`);
  return stage
    ? `${kindLabel}, ${t(`ui.git.status.${STAGE_KEY[stage]}`)}`
    : kindLabel;
}

export function fileMark(status: GitFileStatus | undefined): MarkView {
  if (!status) return EMPTY_MARK;
  const conflicted = status.kind === "conflicted";
  const stage: Stage = conflicted ? "full" : stageOf(status);
  return {
    text: letterOf(status.kind),
    kind: status.kind,
    stage,
    conflicted,
    label: statusLabel(status.kind, conflicted ? null : stage),
  };
}

export function folderMark(
  summary: FolderSummary | undefined,
  expanded: boolean,
): MarkView {
  if (!summary) return EMPTY_MARK;
  if (summary.conflicts > 0) {
    return {
      text: "",
      kind: "conflict-dot",
      stage: null,
      conflicted: false,
      label: t("ui.git.status.conflictBelow"),
    };
  }
  if (expanded) return EMPTY_MARK;
  return {
    text: countLabel(summary.total),
    kind: "count",
    stage: null,
    conflicted: false,
    label: t(
      summary.total === 1
        ? "ui.git.status.changeBelow"
        : "ui.git.status.changesBelow",
      { n: summary.total },
    ),
  };
}
