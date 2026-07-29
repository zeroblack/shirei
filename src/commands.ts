import { type Channel, invoke } from "@tauri-apps/api/core";
import type { RecordFormat } from "./config";
import type {
  FocusSessionEndPayload,
  FocusSessionPatch,
  FocusSessionStartPayload,
} from "./focus/logging";
import type { MetricEvent } from "./metrics";
import type { PhysicalRect, RecordTarget } from "./screencast-core";
import type { DirListing, FileContent, SearchEvent } from "./types";

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

export const createFile = (path: string) =>
  invoke<void>("fs_create_file", { path });

export const searchStart = (
  root: string,
  scope: "project" | "home",
  generation: number,
  onEvent: Channel<SearchEvent>,
) => invoke<void>("search_start", { root, scope, generation, onEvent });

export const searchQuery = (generation: number, query: string) =>
  invoke<void>("search_query", { generation, query });

export const searchClose = (generation: number) =>
  invoke<void>("search_close", { generation });

export const recordOpen = (path: string) =>
  invoke<void>("record_open", { path });

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

export const gitCurrentBranch = (path: string) =>
  invoke<string | null>("git_current_branch", { path });

export const notifyFire = (title: string, body: string) =>
  invoke<void>("notify_fire", { title, body });

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

export const browserOpen = (
  label: string,
  url: string,
  x: number,
  y: number,
  width: number,
  height: number,
) => invoke<void>("browser_open", { label, url, x, y, width, height });

export const browserNavigate = (label: string, url: string) =>
  invoke<void>("browser_navigate", { label, url });

export const browserBack = (label: string) =>
  invoke<void>("browser_back", { label });

export const browserForward = (label: string) =>
  invoke<void>("browser_forward", { label });

export const browserReload = (label: string) =>
  invoke<void>("browser_reload", { label });

export const browserSetBounds = (
  label: string,
  x: number,
  y: number,
  width: number,
  height: number,
) => invoke<void>("browser_set_bounds", { label, x, y, width, height });

export const browserUrl = (label: string) =>
  invoke<string>("browser_url", { label });

export const browserShow = (label: string) =>
  invoke<void>("browser_show", { label });

export const browserHide = (label: string) =>
  invoke<void>("browser_hide", { label });

export const browserFocus = (label: string) =>
  invoke<void>("browser_focus", { label });

export const browserReleaseFocus = () => invoke<void>("browser_release_focus");

export const browserClose = (label: string) =>
  invoke<void>("browser_close", { label });

export const browserSetColorScheme = (label: string, scheme: string) =>
  invoke<void>("browser_set_color_scheme", { label, scheme });

export const metricsLog = (events: MetricEvent[]) =>
  invoke<void>("metrics_log", { events });

export const focusSessionStart = (payload: FocusSessionStartPayload) =>
  invoke<void>("focus_session_start", { session: payload });

export const focusSessionUpdate = (uuid: string, patch: FocusSessionPatch) =>
  invoke<void>("focus_session_update", { uuid, patch });

export const focusSessionEnd = (uuid: string, end: FocusSessionEndPayload) =>
  invoke<void>("focus_session_end", { uuid, end });
