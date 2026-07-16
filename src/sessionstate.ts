import { listen } from "@tauri-apps/api/event";
import { info } from "@tauri-apps/plugin-log";
import { t } from "./i18n";

export type WaitKind = "approval" | "question" | "unknown";

export type SessionState =
  | { kind: "working" }
  | { kind: "waiting"; wait: WaitKind }
  | { kind: "done"; code: number }
  | { kind: "errored"; code: number };

export type Confidence = "high" | "tentative" | "low";

export interface SessionStateEntry {
  state: SessionState;
  confidence: Confidence;
  command: string | null;
  payload: string | null;
  since: number;
}

type RawWaitKind = "Approval" | "Question" | "Unknown";
type RawConfidence = "High" | "Tentative" | "Low";
type RawAgentState =
  | "Working"
  | { Waiting: RawWaitKind }
  | { Done: { code: number } }
  | { Errored: { code: number } };

interface RawSessionStateEvent {
  id: string;
  state: RawAgentState;
  confidence: RawConfidence;
  command: string | null;
  payload: string | null;
}

const WAIT_KIND: Record<RawWaitKind, WaitKind> = {
  Approval: "approval",
  Question: "question",
  Unknown: "unknown",
};

const CONFIDENCE: Record<RawConfidence, Confidence> = {
  High: "high",
  Tentative: "tentative",
  Low: "low",
};

function normalizeState(raw: RawAgentState): SessionState {
  if (raw === "Working") return { kind: "working" };
  if ("Waiting" in raw)
    return { kind: "waiting", wait: WAIT_KIND[raw.Waiting] };
  if ("Done" in raw) return { kind: "done", code: raw.Done.code };
  return { kind: "errored", code: raw.Errored.code };
}

export function sameKind(a: SessionState, b: SessionState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "waiting" && b.kind === "waiting") return a.wait === b.wait;
  if (a.kind === "done" && b.kind === "done") return a.code === b.code;
  if (a.kind === "errored" && b.kind === "errored") return a.code === b.code;
  return true;
}

// A session "needs you" only when it is blocked waiting for the user to advance
// it with a real prompt: a high-confidence Waiting. Low-confidence waits are
// guesses (idle-thinking) and never raise the flag. The tab Bell and the
// notification/badge logic share this one definition so they always agree.
export function needsYou(entry: SessionStateEntry): boolean {
  return entry.state.kind === "waiting" && entry.confidence === "high";
}

// A soft "maybe waiting": the session has been silent long enough to plausibly
// be stuck, but nothing confirms it. Surfaced as the dim breathing ring — never
// a notification or a badge. Distinct from needsYou, which is certain.
export function maybeWaiting(entry: SessionStateEntry): boolean {
  return entry.state.kind === "waiting" && entry.confidence === "tentative";
}

export const STATE_GLYPH: Record<SessionState["kind"], string> = {
  working: "○",
  waiting: "●",
  done: "✓",
  errored: "▲",
};

function atomLayer(cls: string, ...children: HTMLElement[]): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = cls;
  if (children.length) el.append(...children);
  return el;
}

// Two electrons on crossed elliptical orbits around a still nucleus: the
// "working" mark. Motion is the working signal; the still layer (crossed
// rings) shows under prefers-reduced-motion so the shape survives without it.
export function buildWorkingMark(el: HTMLElement): void {
  el.classList.add("state-atom");
  const orbit = (side: string): HTMLSpanElement =>
    atomLayer(
      `atom-orbit live ${side}`,
      atomLayer("atom-spin", atomLayer("atom-e")),
    );
  el.replaceChildren(
    atomLayer("atom-nucleus live"),
    orbit("orbit-a"),
    orbit("orbit-b"),
    atomLayer(
      "atom-still still",
      atomLayer("atom-nucleus"),
      atomLayer("atom-ring ring-a"),
      atomLayer("atom-ring ring-b"),
    ),
  );
}

const WAITING_TITLE_KEY: Record<
  Extract<SessionState, { kind: "waiting" }>["wait"],
  | "ui.tabbar.stateWaitingApproval"
  | "ui.tabbar.stateWaitingQuestion"
  | "ui.tabbar.stateWaitingUnknown"
> = {
  approval: "ui.tabbar.stateWaitingApproval",
  question: "ui.tabbar.stateWaitingQuestion",
  unknown: "ui.tabbar.stateWaitingUnknown",
};

export function stateTitle(entry: SessionStateEntry): string {
  const base = ((): string => {
    switch (entry.state.kind) {
      case "working":
        return t("ui.tabbar.stateWorking");
      case "waiting":
        return t(WAITING_TITLE_KEY[entry.state.wait]);
      case "done":
        return t("ui.tabbar.stateDone");
      case "errored":
        return t("ui.tabbar.stateErrored", { code: entry.state.code });
    }
  })();
  if (entry.confidence === "tentative") return t("ui.tabbar.stateMaybeWaiting");
  return entry.confidence === "low"
    ? `${base} · ${t("ui.tabbar.stateUnconfirmed")}`
    : base;
}

const entries = new Map<string, SessionStateEntry>();
const listeners = new Set<(id: string, entry: SessionStateEntry) => void>();
let started: Promise<void> | null = null;

function applyEvent(raw: RawSessionStateEvent): void {
  const state = normalizeState(raw.state);
  void info(
    `[state] id=${raw.id} kind=${state.kind}${state.kind === "waiting" ? `/${state.wait}` : ""} conf=${raw.confidence} cmd=${raw.command ?? ""} payload=${(raw.payload ?? "").slice(0, 60)}`,
  );
  const prev = entries.get(raw.id);
  const since = prev && sameKind(prev.state, state) ? prev.since : Date.now();
  const entry: SessionStateEntry = {
    state,
    confidence: CONFIDENCE[raw.confidence],
    command: raw.command,
    payload: raw.payload,
    since,
  };
  entries.set(raw.id, entry);
  for (const listener of listeners) listener(raw.id, entry);
}

// Idempotent: safe to call from every module that wants the store live
// without coordinating a single start-up owner.
export function initSessionState(): Promise<void> {
  if (!started) {
    started = listen<RawSessionStateEvent>("session://state", (e) =>
      applyEvent(e.payload),
    ).then(() => undefined);
  }
  return started;
}

export function getSessionState(id: string): SessionStateEntry | undefined {
  return entries.get(id);
}

// The board lists every tracked session, not just the one primary state per
// tab, so it reads the whole store directly rather than going through
// pickPrimaryState.
export function allSessionStates(): ReadonlyMap<string, SessionStateEntry> {
  return entries;
}

export function onSessionStateChange(
  listener: (id: string, entry: SessionStateEntry) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const URGENCY: Record<SessionState["kind"], number> = {
  errored: 3,
  waiting: 2,
  working: 1,
  done: 0,
};

// Aggregates several session ids (a tab can hold split panes, each its own
// session) down to the one worth surfacing: the most urgent kind, ties
// broken by whichever flipped most recently.
export function pickPrimaryState(
  ids: readonly string[],
): SessionStateEntry | undefined {
  let best: SessionStateEntry | undefined;
  for (const id of ids) {
    const entry = entries.get(id);
    if (!entry) continue;
    if (
      !best ||
      URGENCY[entry.state.kind] > URGENCY[best.state.kind] ||
      (URGENCY[entry.state.kind] === URGENCY[best.state.kind] &&
        entry.since > best.since)
    ) {
      best = entry;
    }
  }
  return best;
}

// Oldest-first: the session that has been waiting longest is the one most
// worth surfacing first, mirroring an inbox rather than a most-recent feed.
export function waitingIds(ids: readonly string[]): string[] {
  return ids
    .filter((id) => entries.get(id)?.state.kind === "waiting")
    .sort(
      (a, b) => (entries.get(a)?.since ?? 0) - (entries.get(b)?.since ?? 0),
    );
}

// The keyboard-triage target for "go to who needs me": the oldest
// high-confidence Waiting, falling back to the oldest Errored. Low-confidence
// waits are guesses and never pull focus on their own.
export function needsAttentionId(ids: readonly string[]): string | undefined {
  const waiting = ids
    .filter((id) => {
      const e = entries.get(id);
      return e?.state.kind === "waiting" && e.confidence === "high";
    })
    .sort(
      (a, b) => (entries.get(a)?.since ?? 0) - (entries.get(b)?.since ?? 0),
    );
  if (waiting.length > 0) return waiting[0];

  const errored = ids
    .filter((id) => entries.get(id)?.state.kind === "errored")
    .sort(
      (a, b) => (entries.get(a)?.since ?? 0) - (entries.get(b)?.since ?? 0),
    );
  return errored[0];
}

export function cycleWaitingId(
  ids: readonly string[],
  currentId: string | null,
  dir: 1 | -1,
): string | undefined {
  const waiting = waitingIds(ids);
  if (waiting.length === 0) return undefined;
  const idx = currentId ? waiting.indexOf(currentId) : -1;
  if (idx === -1) return dir === 1 ? waiting[0] : waiting[waiting.length - 1];
  return waiting[(idx + dir + waiting.length) % waiting.length];
}
