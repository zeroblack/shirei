import { debug, info, warn } from "@tauri-apps/plugin-log";

const BSU = "\x1b[?2026h";
const ESU = "\x1b[?2026l";
const ALT_ENTER = "\x1b[?1049h";
const ALT_LEAVE = "\x1b[?1049l";

type Level = "debug" | "info" | "warn";
const SINK: Record<Level, (message: string) => Promise<void>> = {
  debug,
  info,
  warn,
};

// Logging must never throw into the render/PTY path, and must no-op outside a
// Tauri runtime (unit tests): swallow both a synchronous failure and a rejected
// IPC promise.
function emit(level: Level, message: string): void {
  try {
    void SINK[level](message).catch(() => {});
  } catch {
    // logger/IPC not available
  }
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

export function probeWebgl2(): string {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    if (!gl) return "null";
    const lose = gl.getExtension("WEBGL_lose_context");
    return lose ? "ok+lose_ext" : "ok";
  } catch (err) {
    return `throw:${String(err)}`;
  }
}

export class RendererDiag {
  private bytes = 0;
  private renders = 0;
  private bsu = 0;
  private esu = 0;
  private syncOpen = false;
  private lastBytes = 0;
  private lastRenders = 0;
  private timer?: number;
  private stallStreak = 0;
  private stallArmed = true;

  constructor(
    private readonly id: string,
    private readonly verbose: boolean,
    private readonly activeRenderer: () => string,
    private readonly onStall?: () => void,
    private readonly isVisible: () => boolean = () => true,
  ) {}

  // Rare lifecycle/render events worth keeping at the default level.
  note(line: string): void {
    emit("info", `[render ${this.id}] ${line}`);
  }

  // Per-tick / alt-screen chatter: only when diagnostics is on, so the default
  // log stays small and never carries the PTY firehose.
  private trace(line: string): void {
    if (this.verbose) emit("debug", `[render ${this.id}] ${line}`);
  }

  // The timer always runs: the stall watchdog is a safety net that must work
  // even with diagnostics off. Only the logging volume is gated.
  start(): void {
    if (this.timer !== undefined) return;
    this.trace(
      `probe webgl2=${probeWebgl2()} renderer=${this.activeRenderer()}`,
    );
    this.timer = window.setInterval(() => this.tick(), 1000);
  }

  onRender(): void {
    this.renders++;
  }

  scan(bytes: Uint8Array): void {
    this.bytes += bytes.length;
    if (!this.verbose) return;
    const s = latin1(bytes);
    const opens = countOccurrences(s, BSU);
    const closes = countOccurrences(s, ESU);
    if (opens) {
      this.bsu += opens;
      this.syncOpen = true;
    }
    if (closes) {
      this.esu += closes;
      this.syncOpen = false;
    }
    if (s.includes(ALT_ENTER)) this.trace("alt-screen ENTER");
    if (s.includes(ALT_LEAVE)) this.trace("alt-screen LEAVE");
  }

  private tick(): void {
    const db = this.bytes - this.lastBytes;
    const dr = this.renders - this.lastRenders;
    this.lastBytes = this.bytes;
    this.lastRenders = this.renders;
    // A hidden pane legitimately receives bytes without painting; only a visible
    // pane that takes data and never paints is a real wedge worth recovering.
    this.watchStall(this.isVisible() && db > 0 && dr === 0, dr);
    if (db === 0 && dr === 0) return;
    this.trace(
      `tick bytes=+${db} renders=+${dr} syncOpen=${this.syncOpen} bsu=${this.bsu} esu=${this.esu} renderer=${this.activeRenderer()}`,
    );
  }

  // Bytes arriving with zero paints for 2+ seconds means the renderer wedged
  // (an exhausted GL context or a stale DOM renderer). Trip recovery once, then
  // wait for painting to resume before arming again so we never loop on it.
  private watchStall(stalled: boolean, dr: number): void {
    if (stalled) {
      this.stallStreak += 1;
      if (this.stallStreak >= 2 && this.stallArmed) {
        this.stallArmed = false;
        emit(
          "warn",
          `[render ${this.id}] render stall: data arriving, nothing painted -> recovering`,
        );
        this.onStall?.();
      }
      return;
    }
    this.stallStreak = 0;
    if (dr > 0 && !this.stallArmed) {
      this.stallArmed = true;
      this.note("render recovered after stall");
    }
  }

  dispose(): void {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
  }
}
