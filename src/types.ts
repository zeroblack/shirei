export interface TerminalTab {
  id: string;
  kind: "terminal";
  title: string;
  color: string | null;
  projectId?: string;
  lastUsedAt: number;
  pinned: boolean;
  memory?: "ok" | "stale";
}

export interface EditorTab {
  id: string;
  kind: "editor";
  title: string;
  path: string;
  dirty: boolean;
  lastUsedAt: number;
  pinned: boolean;
  openerId?: string;
  memory?: "ok" | "stale";
}

export type TabState = TerminalTab | EditorTab;

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface DirListing {
  entries: DirEntry[];
  truncated: boolean;
}

export interface FileContent {
  content: string;
  mtime: number;
}

export interface MatchItem {
  rel: string;
  name: string;
  is_dir: boolean;
  positions: number[];
}

export type SearchEvent =
  | { kind: "indexing"; count: number }
  | {
      kind: "results";
      generation: number;
      items: MatchItem[];
      partial: boolean;
    }
  | { kind: "done"; total: number; partial: boolean };
