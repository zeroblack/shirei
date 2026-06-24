import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { PerformanceConfig } from "./config";
import { t } from "./i18n";

interface PerfVal {
  text: string;
  level: number;
  pct: number;
  approx?: boolean;
}

type Actor = "shirei" | "apps";
type Metric = "cpu" | "mem" | "disk" | "net";
type ScalarMetric = Exclude<Metric, "net">;

export type PerfZone = Partial<
  Record<
    `${ScalarMetric}_${Actor}` | `net_down_${Actor}` | `net_up_${Actor}`,
    PerfVal
  >
>;

interface PerfPayload {
  tab: PerfZone;
  app: PerfZone;
}

const ZONES: { key: "tab" | "app"; label: string }[] = [
  { key: "tab", label: "tab" },
  { key: "app", label: "app" },
];
const METRICS: Metric[] = ["cpu", "mem", "disk", "net"];
const ACTORS: Actor[] = ["shirei", "apps"];
const actorLabel = (actor: Actor): string =>
  actor === "shirei" ? "Shirei" : t("ui.statusbar.apps");

const SPARK_LEN = 10;
const BLOCKS = "▁▂▃▄▅▆▇█";

export function levelClass(n: number): string {
  return n >= 2 ? "crit" : n >= 1 ? "warn" : "ok";
}

export function sparkline(vals: number[]): string {
  return vals
    .map((v) => {
      const i = Math.round(
        (Math.min(100, Math.max(0, v)) / 100) * (BLOCKS.length - 1),
      );
      return BLOCKS[i];
    })
    .join("");
}

function span(cls: string, text?: string): HTMLElement {
  const el = document.createElement("span");
  el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

export function pick(
  zone: PerfZone,
  metric: Metric,
  actor: Actor,
): PerfVal | undefined {
  if (metric === "net") {
    const down = zone[`net_down_${actor}`];
    const up = zone[`net_up_${actor}`];
    if (!down && !up) return undefined;
    return {
      text: `↓${down?.text ?? "0"} ↑${up?.text ?? "0"}`,
      level: 0,
      pct: 0,
    };
  }
  return zone[`${metric}_${actor}`];
}

export class StatusBar {
  private readonly root: HTMLElement;
  private cfg: PerformanceConfig | null = null;
  private unlisten?: UnlistenFn;
  private readonly histories = new Map<string, number[]>();
  private pending: PerfPayload | null = null;
  private frame = 0;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  async start(): Promise<void> {
    this.unlisten = await listen<PerfPayload>("perf", (e) =>
      this.onData(e.payload),
    );
  }

  setConfig(cfg: PerformanceConfig): void {
    this.cfg = cfg;
    const on = cfg?.enabled ?? false;
    this.root.classList.toggle("hidden", !on);
    if (!on) {
      this.root.replaceChildren();
      this.histories.clear();
    }
  }

  private onData(p: PerfPayload): void {
    this.pending = p;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.pending) this.paint(this.pending);
    });
  }

  private paint(p: PerfPayload): void {
    const frag = document.createDocumentFragment();
    ZONES.forEach((z, i) => {
      if (i > 0) frag.append(span("perf-spacer"));
      frag.append(span("perf-zone", z.label));
      for (const metric of METRICS) {
        const cell = this.metricCell(z.key, p[z.key], metric);
        if (cell) frag.append(cell);
      }
    });
    this.root.replaceChildren(frag);
  }

  private metricCell(
    zoneKey: string,
    zone: PerfZone,
    metric: Metric,
  ): HTMLElement | null {
    const present = ACTORS.map((a) => ({
      a,
      val: pick(zone, metric, a),
    })).filter((x): x is { a: Actor; val: PerfVal } => x.val !== undefined);
    if (present.length === 0) return null;
    const cell = span("perf-cell");
    cell.append(span("perf-label", metric));
    present.forEach((x, idx) => {
      if (idx > 0) cell.append(span("perf-sep", "·"));
      cell.append(this.actorEl(zoneKey, metric, x.a, x.val));
    });
    return cell;
  }

  private actorEl(
    zoneKey: string,
    metric: Metric,
    actor: Actor,
    val: PerfVal,
  ): HTMLElement {
    const wrap = span("perf-actor");
    wrap.append(span("perf-actor-name", actorLabel(actor)));
    if (metric === "cpu" && actor === "apps" && this.cfg?.sparklines) {
      const key = `${zoneKey}.cpu`;
      const hist = this.histories.get(key) ?? [];
      hist.push(val.pct);
      if (hist.length > SPARK_LEN) hist.shift();
      this.histories.set(key, hist);
      wrap.append(span(`perf-spark ${levelClass(val.level)}`, sparkline(hist)));
    }
    const cls =
      metric === "cpu" ? levelClass(val.level) : metric === "mem" ? "mem" : "";
    const v = span(`perf-val ${cls}`.trim());
    v.textContent = (val.approx ? "~" : "") + val.text;
    wrap.append(v);
    return wrap;
  }

  dispose(): void {
    this.unlisten?.();
    this.unlisten = undefined;
    if (this.frame) cancelAnimationFrame(this.frame);
  }
}
