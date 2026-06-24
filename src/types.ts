export interface TerminalTab {
  id: string;
  kind: "terminal";
  title: string;
  color: string | null;
  projectId?: string;
  lastUsedAt: number;
  pinned: boolean;
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

export interface IndexEntry {
  rel: string;
  name: string;
  is_dir: boolean;
}

export interface FileIndex {
  entries: IndexEntry[];
  truncated: boolean;
}
