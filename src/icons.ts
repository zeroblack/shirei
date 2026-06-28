const SHAPES = {
  folder:
    '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>',
  folderOpen:
    '<path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  text: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  config:
    '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>',
  image:
    '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/>',
  video:
    '<path d="m16 13 5.22 3.48a.5.5 0 0 0 .78-.41V7.93a.5.5 0 0 0-.75-.43L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  audio:
    '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
};

const COLOR: Record<string, string> = {
  ts: "#3aa0ff",
  tsx: "#3aa0ff",
  mts: "#3aa0ff",
  cts: "#3aa0ff",
  js: "#f5d03a",
  jsx: "#f5d03a",
  mjs: "#f5d03a",
  cjs: "#f5d03a",
  json: "#f5d03a",
  jsonc: "#f5d03a",
  rs: "#ff7a4d",
  py: "#5fb0e6",
  go: "#36d3e0",
  rb: "#e0524a",
  php: "#a89cf0",
  java: "#e07a3a",
  kt: "#e07a3a",
  c: "#6a98d0",
  h: "#6a98d0",
  cpp: "#6a98d0",
  cc: "#6a98d0",
  hpp: "#6a98d0",
  cs: "#67c47a",
  swift: "#ff7a4a",
  html: "#e8704a",
  htm: "#e8704a",
  css: "#56a0f0",
  scss: "#e066a0",
  sass: "#e066a0",
  vue: "#5fd49a",
  svelte: "#ff5a3a",
  astro: "#c66fff",
  sh: "#8fd45a",
  zsh: "#8fd45a",
  bash: "#8fd45a",
  fish: "#8fd45a",
  lua: "#6a8ff0",
  sql: "#d4a04a",
  md: "#8fb8e8",
  mdx: "#8fb8e8",
  markdown: "#8fb8e8",
  txt: "#9aa0a6",
  log: "#9aa0a6",
  rst: "#9aa0a6",
  yaml: "#d2a93e",
  yml: "#d2a93e",
  toml: "#d2a93e",
  ini: "#d2a93e",
  conf: "#d2a93e",
  cfg: "#d2a93e",
  env: "#d2a93e",
  lock: "#d2a93e",
  png: "#b88ff0",
  jpg: "#b88ff0",
  jpeg: "#b88ff0",
  gif: "#b88ff0",
  webp: "#b88ff0",
  ico: "#b88ff0",
  avif: "#b88ff0",
  bmp: "#b88ff0",
  svg: "#f0a04a",
  mp4: "#ff6b9d",
  mov: "#ff6b9d",
  m4v: "#ff6b9d",
  webm: "#ff6b9d",
  ogv: "#ff6b9d",
  avi: "#ff6b9d",
  mkv: "#ff6b9d",
  mp3: "#5fd49a",
  wav: "#5fd49a",
  m4a: "#5fd49a",
  aac: "#5fd49a",
  ogg: "#5fd49a",
  oga: "#5fd49a",
  flac: "#5fd49a",
  opus: "#5fd49a",
  pdf: "#e0524a",
};

const CODE = new Set([
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "rs",
  "py",
  "go",
  "rb",
  "php",
  "java",
  "kt",
  "c",
  "h",
  "cpp",
  "cc",
  "hpp",
  "cs",
  "swift",
  "html",
  "htm",
  "css",
  "scss",
  "sass",
  "vue",
  "svelte",
  "astro",
  "sh",
  "zsh",
  "bash",
  "fish",
  "lua",
  "sql",
]);
const TEXT = new Set(["md", "mdx", "markdown", "txt", "log", "rst"]);
const CONFIG = new Set([
  "json",
  "jsonc",
  "yaml",
  "yml",
  "toml",
  "ini",
  "conf",
  "cfg",
  "env",
  "lock",
]);
const IMAGE = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "avif",
  "bmp",
  "svg",
]);
const VIDEO = new Set(["mp4", "mov", "m4v", "webm", "ogv", "avi", "mkv"]);
const AUDIO = new Set([
  "mp3",
  "wav",
  "m4a",
  "aac",
  "ogg",
  "oga",
  "flac",
  "opus",
]);
const PDF = new Set(["pdf"]);

const FOLDER_COLOR = "#6c9fd8";
const DEFAULT_COLOR = "#8a93a0";

function svg(inner: string, color: string): string {
  return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function fileIcon(
  name: string,
  isDir: boolean,
  expanded: boolean,
): string {
  if (isDir) {
    return svg(expanded ? SHAPES.folderOpen : SHAPES.folder, FOLDER_COLOR);
  }
  const ext = extOf(name);
  const color = COLOR[ext] ?? DEFAULT_COLOR;
  let shape = SHAPES.file;
  if (CODE.has(ext)) shape = SHAPES.code;
  else if (TEXT.has(ext)) shape = SHAPES.text;
  else if (CONFIG.has(ext)) shape = SHAPES.config;
  else if (IMAGE.has(ext)) shape = SHAPES.image;
  else if (VIDEO.has(ext)) shape = SHAPES.video;
  else if (AUDIO.has(ext)) shape = SHAPES.audio;
  else if (PDF.has(ext)) shape = SHAPES.text;
  return svg(shape, color);
}

export function isImage(name: string): boolean {
  return IMAGE.has(extOf(name));
}

export function mediaKind(name: string): "video" | "audio" | "pdf" | null {
  const ext = extOf(name);
  if (VIDEO.has(ext)) return "video";
  if (AUDIO.has(ext)) return "audio";
  if (PDF.has(ext)) return "pdf";
  return null;
}

export const CHEVRON =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';

export const SEARCH =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';

export const SIDEBAR =
  '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>';

export const COPY =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

export const CHECK =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

export const REVERT =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';

export const COMPARE =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/></svg>';

export const CLOSE =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

export const HISTORY =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l3 2"/></svg>';

export const BLAME =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.2"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/></svg>';

const CALLOUT_PATHS: Record<string, string> = {
  note: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  tip: '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M8 14a5 5 0 1 1 8 0c-.7.7-1 1.5-1 2.5H9c0-1-.3-1.8-1-2.5z"/>',
  success: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  important:
    '<polygon points="12 3 14.5 9 21 9.3 16 13.5 17.6 20 12 16.3 6.4 20 8 13.5 3 9.3 9.5 9"/>',
  warning:
    '<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  caution:
    '<polygon points="8 3 16 3 21 8 21 16 16 21 8 21 3 16 3 8"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  danger:
    '<polygon points="8 3 16 3 21 8 21 16 16 21 8 21 3 16 3 8"/><path d="m9.5 9.5 5 5"/><path d="m14.5 9.5-5 5"/>',
  question:
    '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 0 1 4.5 1.5c0 1.5-2 2-2 3"/><path d="M12 17h.01"/>',
  example:
    '<path d="M9 3h6"/><path d="M10 3v6l-5 9a1 1 0 0 0 .9 1.5h12.2a1 1 0 0 0 .9-1.5l-5-9V3"/>',
  spec: '<path d="M8 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-2"/><path d="M9 3a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1z"/><path d="M8 11h8"/><path d="M8 15h6"/>',
  agent:
    '<rect x="4" y="8" width="16" height="11" rx="2"/><path d="M12 8V5"/><circle cx="12" cy="4" r="1"/><path d="M9 13h.01"/><path d="M15 13h.01"/>',
  acceptance:
    '<path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
};

export function calloutIcon(type: string, color: string): string {
  const inner = CALLOUT_PATHS[type] ?? CALLOUT_PATHS.note;
  return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}
