import { getCurrentWindow } from "@tauri-apps/api/window";
import { info } from "@tauri-apps/plugin-log";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";
import { gitCurrentBranch, notifyFire, ptyCwd } from "./commands";
import type {
  CliRegistryEntry,
  IdentityConfig,
  NotificationsConfig,
  PayloadVerbosity,
  QuietHours,
  SoundTimbre,
} from "./config";
import { t } from "./i18n";
import type { BoardRow } from "./orchestration";
import {
  needsYou,
  type SessionState,
  type SessionStateEntry,
} from "./sessionstate";

type InterruptKind = "waiting" | "done" | "errored";

// Guard against re-notifying the same session+state within this window — an
// agent that flickers working<->waiting must not fire a fresh notification each
// bounce. Temporary constant while we diagnose; moves to config once tuned.
const RENOTIFY_COOLDOWN_MS = 5 * 60 * 1000;

export function isTrackedAgent(
  command: string | null,
  registry: readonly CliRegistryEntry[],
): boolean {
  if (!command) return false;
  const lower = command.toLowerCase();
  return registry.some(
    (entry) =>
      entry.enabled && lower.includes(entry.process_match.toLowerCase()),
  );
}

function cliLabelFor(
  command: string,
  registry: readonly CliRegistryEntry[],
): string {
  const lower = command.toLowerCase();
  const match = registry.find(
    (entry) =>
      entry.enabled && lower.includes(entry.process_match.toLowerCase()),
  );
  return match?.label ?? command;
}

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

function parseHm(hm: string): number {
  const [h, m] = hm.split(":").map(Number);
  return ((h || 0) % 24) * 60 + ((m || 0) % 60);
}

// Quiet hours can wrap midnight (e.g. 22:00-08:00), so the window is defined
// by whichever side of the wrap the boundaries fall on rather than assuming
// start < end.
function withinQuietHours(quiet: QuietHours, now: Date): boolean {
  if (!quiet.enabled) return false;
  const start = parseHm(quiet.start);
  const end = parseHm(quiet.end);
  if (start === end) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

const WAITING_SCAFFOLD: Record<
  Extract<SessionState, { kind: "waiting" }>["wait"],
  "notif.waiting.approval" | "notif.waiting.question" | "notif.waiting.unknown"
> = {
  approval: "notif.waiting.approval",
  question: "notif.waiting.question",
  unknown: "notif.waiting.unknown",
};

function scaffoldFor(state: SessionState): string {
  switch (state.kind) {
    case "waiting":
      return t(WAITING_SCAFFOLD[state.wait]);
    case "done":
      return t("notif.done");
    case "errored":
      return t("notif.errored", { code: state.code });
    case "working":
      return "";
  }
}

// Payload verbosity is a privacy control, not a copy variant: redacted drops
// the agent's real bytes but keeps the scaffold verb; identity-only drops the
// scaffold too, so an unfocused-desk glance reveals nothing but who.
function composeBody(
  entry: SessionStateEntry,
  verbosity: PayloadVerbosity,
  truncationLength: number,
): string {
  if (verbosity === "identity-only") return t("notif.checkSession");
  const scaffold = scaffoldFor(entry.state);
  if (verbosity === "redacted") return scaffold;
  if (!entry.payload) {
    // No real command to surface — the title already names the session, so say
    // plainly it is blocked on the user rather than a bare "wants to run".
    return entry.state.kind === "waiting" ? t("notif.needsInput") : scaffold;
  }
  return `${scaffold}  ${truncateMiddle(entry.payload, truncationLength)}`;
}

async function composeIdentity(
  row: BoardRow,
  identity: IdentityConfig,
  registry: readonly CliRegistryEntry[],
): Promise<string> {
  const parts = [row.label];
  if (identity.append_branch) {
    const cwd = await ptyCwd(row.id).catch(() => null);
    const branch = cwd ? await gitCurrentBranch(cwd).catch(() => null) : null;
    if (branch) parts.push(branch);
  }
  if (identity.append_cli && row.entry.command) {
    parts.push(cliLabelFor(row.entry.command, registry));
  }
  return parts.join(" · ");
}

let audioCtx: AudioContext | null = null;

// Synthesized, not a bundled asset: keeps the sound self-contained (no
// licensing, no binary in the repo). The darker error timbre is a lower
// fundamental on a duller (triangle) waveform against the soft sine ping.
function playTimbre(timbre: SoundTimbre): void {
  if (typeof AudioContext === "undefined") return;
  try {
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain).connect(ctx.destination);
    osc.type = timbre === "deep" ? "triangle" : "sine";
    osc.frequency.value = timbre === "deep" ? 220 : 440;
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
    osc.start(now);
    osc.stop(now + 0.45);
    osc.onended = () => osc.disconnect();
  } catch {
    // best-effort: never let sound synthesis take down notification delivery
  }
}

export class NotificationCenter {
  private config: NotificationsConfig | null = null;
  private registry: readonly CliRegistryEntry[] = [];
  private focused = true;
  private activeIds = new Set<string>();
  private defaultTitle = "Shirei";
  private permissionChecked = false;
  private readonly lastKind = new Map<string, SessionState["kind"]>();
  private readonly lastNotifiedAt = new Map<string, number>();
  private pending: BoardRow[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  async init(): Promise<void> {
    const win = getCurrentWindow();
    this.focused = await win.isFocused().catch(() => true);
    this.defaultTitle = await win.title().catch(() => "Shirei");
    await win.onFocusChanged(({ payload }) => {
      this.focused = payload;
    });
    // Ask up front: the grant is a one-time OS prompt, and requesting it only on
    // the first fired notification means a denied-by-default state silently
    // swallows the very notification that would have asked.
    await this.ensurePermission();
  }

  setConfig(
    notifications: NotificationsConfig,
    registry: readonly CliRegistryEntry[],
  ): void {
    this.config = notifications;
    this.registry = registry;
  }

  // The sessions the user is actually looking at (the active tab's panes). A
  // waiting session in any other tab still earns a notification even while the
  // window is focused — window focus alone means the user is in Shirei, not that
  // they can see this particular session.
  setActive(ids: Iterable<string>): void {
    this.activeIds = new Set(ids);
  }

  sync(rows: readonly BoardRow[]): void {
    if (!this.config) return;
    const tracked = rows.filter((r) =>
      isTrackedAgent(r.entry.command, this.registry),
    );
    this.updateAmbient(tracked);
    this.detectTransitions(tracked);
  }

  private updateAmbient(rows: readonly BoardRow[]): void {
    if (!this.config) return;
    const needy = rows.filter((r) => needsYou(r.entry));
    const count = needy.length;
    void info(
      `[notif-badge] needsYou=${count} ids=${JSON.stringify(needy.map((r) => r.id))}`,
    );
    const win = getCurrentWindow();
    void win.setBadgeCount(count > 0 ? count : undefined).catch(() => {});
    void win
      .setTitle(
        count > 0 ? t("notif.titleWaiting", { count }) : this.defaultTitle,
      )
      .catch(() => {});
  }

  private detectTransitions(rows: readonly BoardRow[]): void {
    const liveIds = new Set(rows.map((r) => r.id));
    for (const id of this.lastKind.keys()) {
      if (!liveIds.has(id)) this.lastKind.delete(id);
    }
    for (const row of rows) {
      const kind = row.entry.state.kind;
      const prev = this.lastKind.get(row.id);
      this.lastKind.set(row.id, kind);
      if (kind === "working" || prev === kind) continue;
      void info(`[notif-transition] id=${row.id} ${prev ?? "none"} -> ${kind}`);
      this.route(row);
    }
  }

  private route(row: BoardRow): void {
    if (!this.config) return;
    const kind = row.entry.state.kind as InterruptKind;
    const channel = this.config.channels[kind];
    const key = `${row.id}:${kind}`;
    const sinceLast = Date.now() - (this.lastNotifiedAt.get(key) ?? 0);
    const active = this.activeIds.has(row.id);
    const suppress =
      channel !== "os"
        ? `channel=${channel}`
        : row.entry.confidence !== "high"
          ? "not-confident"
          : this.focused && active
            ? "focused+active"
            : withinQuietHours(this.config.quiet_hours, new Date())
              ? "quiet-hours"
              : sinceLast < RENOTIFY_COOLDOWN_MS
                ? "cooldown"
                : null;
    void info(
      `[notif-route] id=${row.id} cmd=${row.entry.command ?? ""} kind=${kind} conf=${row.entry.confidence} focused=${this.focused} active=${active} -> ${suppress ? `SUPPRESS(${suppress})` : "FIRE"}`,
    );
    if (suppress) return;
    this.lastNotifiedAt.set(key, Date.now());
    this.enqueue(row);
  }

  private enqueue(row: BoardRow): void {
    if (!this.config) return;
    this.pending.push(row);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(
      () => void this.flush(),
      this.config.coalescing_ms,
    );
  }

  private async flush(): Promise<void> {
    const batch = this.pending;
    this.pending = [];
    this.flushTimer = null;
    if (batch.length === 0 || !this.config) return;
    await this.ensurePermission();
    const { title, body } = await this.composeBatch(batch);
    void info(
      `[notif-fire] count=${batch.length} title=${JSON.stringify(title)} body=${JSON.stringify(body)}`,
    );
    await notifyFire(title, body).catch(() => {});
    if (this.config.sound.enabled) {
      const hasError = batch.some((r) => r.entry.state.kind === "errored");
      playTimbre(
        hasError
          ? this.config.sound.error_timbre
          : this.config.sound.waiting_timbre,
      );
    }
  }

  private async composeBatch(
    batch: readonly BoardRow[],
  ): Promise<{ title: string; body: string }> {
    if (!this.config) return { title: "", body: "" };
    if (batch.length === 1) {
      const row = batch[0];
      const title = await composeIdentity(
        row,
        this.config.identity,
        this.registry,
      );
      const body = composeBody(
        row.entry,
        this.config.payload_verbosity,
        this.config.truncation_length,
      );
      return { title, body };
    }
    const names = batch.map((r) => r.label);
    const body =
      names.length === 2
        ? t("notif.coalesced.two", { first: names[0], second: names[1] })
        : t("notif.coalesced.many", {
            first: names[0],
            second: names[1],
            more: names.length - 2,
          });
    return { title: "shirei", body };
  }

  private async ensurePermission(): Promise<void> {
    if (this.permissionChecked) return;
    this.permissionChecked = true;
    const granted = await isPermissionGranted().catch(() => false);
    if (!granted) await requestPermission().catch(() => "denied");
  }
}
