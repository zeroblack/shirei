import type { FinishAction, RecordFormat } from "./config";

export interface CssRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface PhysicalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface RectOpts {
  dpr: number;
  titlebarOffsetCss: number;
}

export function toPhysicalRect(css: CssRect, opts: RectOpts): PhysicalRect {
  const yCss = Math.max(0, css.y - opts.titlebarOffsetCss);
  const xCss = Math.max(0, css.x);
  return {
    x: Math.round(xCss * opts.dpr),
    y: Math.round(yCss * opts.dpr),
    width: Math.round(css.width * opts.dpr),
    height: Math.round(css.height * opts.dpr),
  };
}

export interface FilenameVars {
  tab: string;
  date: Date;
  ext: string;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// local time: the filename must reflect the user's wall-clock time, not UTC
function stamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export function renderFilename(template: string, vars: FilenameVars): string {
  const tab = slugify(vars.tab) || "shirei";
  const base = template
    .replace(/\{tab\}/g, tab)
    .replace(/\{date\}/g, stamp(vars.date));
  return `${base}.${vars.ext}`;
}

export type RecordTarget = "panel" | "app" | "region";

export const RECORD_TARGETS: RecordTarget[] = ["panel", "app", "region"];

export function moveTarget(current: RecordTarget, delta: number): RecordTarget {
  const n = RECORD_TARGETS.length;
  const i = RECORD_TARGETS.indexOf(current);
  return RECORD_TARGETS[(i + delta + n) % n];
}

export type SelectorAction =
  | { kind: "target"; target: RecordTarget }
  | { kind: "move"; delta: 1 | -1 }
  | { kind: "format"; format: RecordFormat }
  | { kind: "format-cycle" }
  | { kind: "confirm" }
  | { kind: "cancel" };

export function selectorAction(key: string): SelectorAction | null {
  switch (key) {
    case "Enter":
      return { kind: "confirm" };
    case "Escape":
      return { kind: "cancel" };
    case "ArrowDown":
      return { kind: "move", delta: 1 };
    case "ArrowUp":
      return { kind: "move", delta: -1 };
    case "ArrowLeft":
    case "ArrowRight":
      return { kind: "format-cycle" };
  }
  switch (key.toLowerCase()) {
    case "p":
      return { kind: "target", target: "panel" };
    case "a":
      return { kind: "target", target: "app" };
    case "r":
      return { kind: "target", target: "region" };
    case "m":
      return { kind: "format", format: "mp4" };
    case "g":
      return { kind: "format", format: "gif" };
    default:
      return null;
  }
}

export type FinishOp = "copy" | "reveal" | "share" | "none";

export function resolveFinish(
  configured: FinishAction,
  promptChoice: string | null,
): FinishOp {
  if (configured !== "ask") return configured;
  switch ((promptChoice ?? "").toLowerCase()) {
    case "c":
      return "copy";
    case "s":
      return "share";
    default:
      return "reveal";
  }
}
