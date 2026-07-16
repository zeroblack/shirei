import type { MetricsConfig } from "./config";

export interface MetricEvent {
  tsUtc: number;
  tzOffsetMin: number;
  kind: string;
  sessionId?: string;
  projectId?: string | null;
  tabId?: string;
  cliName?: string;
  payload?: string;
}

type EventFields = Omit<MetricEvent, "tsUtc" | "tzOffsetMin" | "kind">;

export function makeEvent(kind: string, fields: EventFields): MetricEvent {
  return {
    kind,
    tsUtc: Date.now(),
    // getTimezoneOffset() is minutes behind UTC (positive west); negate so a
    // stored value reads as the usual "offset from UTC".
    tzOffsetMin: -new Date().getTimezoneOffset(),
    ...fields,
  };
}

export type MetricSink = (events: MetricEvent[]) => Promise<void>;

// Single event producer. Observers push through log(); a timer and dispose()
// flush batches through the injected sink. A no-op when metrics are disabled.
export class MetricsLogger {
  private buffer: MetricEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor(
    private config: MetricsConfig,
    private readonly sink: MetricSink,
  ) {
    if (config.enabled) this.startTimer();
  }

  private startTimer(): void {
    this.timer = setInterval(
      () => void this.flush(),
      Math.max(1000, this.config.flush_interval_ms),
    );
  }

  // Reconfigures a live logger in place: an enabled-change starts/stops the
  // flush timer, and a flush_interval_ms change while enabled restarts it on
  // the new cadence. Without this, toggling metrics on at runtime keeps
  // reading the config the constructor closed over and silently drops events.
  setConfig(config: MetricsConfig): void {
    const wasEnabled = this.config.enabled;
    const prevInterval = this.config.flush_interval_ms;
    this.config = config;
    if (!config.enabled) {
      if (this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
      return;
    }
    if (!wasEnabled || this.timer === null) {
      this.startTimer();
      return;
    }
    if (config.flush_interval_ms !== prevInterval) {
      clearInterval(this.timer);
      this.startTimer();
    }
  }

  log(event: MetricEvent): void {
    if (!this.config.enabled) return;
    this.buffer.push(event);
  }

  async flush(): Promise<void> {
    if (!this.config.enabled || this.flushing || this.buffer.length === 0)
      return;
    this.flushing = true;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.sink(batch);
    } catch {
      // Keep events for the next flush rather than losing them.
      this.buffer = batch.concat(this.buffer);
    } finally {
      this.flushing = false;
    }
  }

  async dispose(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}

export type DormancyState = {
  state: "active" | "dormant";
  shown: boolean;
  lastActiveAt: number;
};

export type DormancyInput = "shown" | "hidden" | "activity" | "tick";

export function dormancyTransition(
  prev: DormancyState,
  input: DormancyInput,
  now: number,
  dormantAfterMs: number,
): { next: DormancyState; emit?: "tab_dormant" | "tab_woken" } {
  const wake = (
    shown: boolean,
  ): { next: DormancyState; emit?: "tab_woken" } => ({
    next: { state: "active", shown, lastActiveAt: now },
    emit: prev.state === "dormant" ? "tab_woken" : undefined,
  });
  switch (input) {
    case "shown":
      return wake(true);
    case "activity":
      return wake(prev.shown);
    case "hidden":
      return { next: { ...prev, shown: false, lastActiveAt: now } };
    case "tick": {
      const stale = now - prev.lastActiveAt >= dormantAfterMs;
      if (prev.state === "active" && !prev.shown && stale) {
        return { next: { ...prev, state: "dormant" }, emit: "tab_dormant" };
      }
      return { next: prev };
    }
  }
}
