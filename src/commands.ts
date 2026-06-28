import { invoke } from "@tauri-apps/api/core";
import type { RecordFormat } from "./config";
import type { PhysicalRect, RecordTarget } from "./screencast-core";
import type { DirListing, FileContent, FileIndex } from "./types";

export const readDir = (path: string) =>
  invoke<DirListing>("fs_read_dir", { path });

export const readFile = (path: string) =>
  invoke<FileContent>("fs_read_file", { path });

export const imageMeta = (path: string) =>
  invoke<number>("fs_image_meta", { path });

export const writeFile = (
  path: string,
  data: string,
  knownMtime: number | null,
) => invoke<number>("fs_write_file", { path, data, knownMtime });

export const indexDir = (root: string) =>
  invoke<FileIndex>("fs_index", { root });

export const revealInFinder = (path: string) =>
  invoke<void>("reveal_in_finder", { path });

export const gitFileHead = (path: string) =>
  invoke<string | null>("git_file_head", { path });

export interface GitCommit {
  sha: string;
  shortSha: string;
  author: string;
  date: number;
  summary: string;
}

export interface GitBlameLine {
  line: number;
  sha: string;
  shortSha: string;
  author: string;
  date: number;
  summary: string;
}

export const gitFileHistory = (path: string) =>
  invoke<GitCommit[]>("git_file_history", { path });

export const gitFileAt = (path: string, sha: string) =>
  invoke<string | null>("git_file_at", { path, sha });

export const gitBlame = (path: string) =>
  invoke<GitBlameLine[]>("git_blame", { path });

export const ptyCwd = (id: string) =>
  invoke<string | null>("session_cwd", { id });

export const ptySnapshot = (id: string) =>
  invoke<{ cwd: string | null; command: string | null }>("session_snapshot", {
    id,
  });

export const screencastStart = (args: {
  mode: RecordTarget;
  rect: PhysicalRect | null;
  format: RecordFormat;
  outPath: string;
}) => invoke<string>("screencast_start", { args });

export const screencastStop = () => invoke<{ path: string }>("screencast_stop");

export const screencastCancel = () => invoke<void>("screencast_cancel");

export const copyFileToClipboard = (path: string) =>
  invoke<void>("screencast_copy_to_clipboard", { path });

export const shareFile = (path: string) =>
  invoke<void>("screencast_share", { path });

export const revealLogs = () => invoke<void>("log_reveal");
