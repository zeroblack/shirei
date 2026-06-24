import { describe, expect, it } from "vitest";
import { levelClass, type PerfZone, pick, sparkline } from "./statusbar";

describe("statusbar", () => {
  it("maps level to color class", () => {
    expect(levelClass(0)).toBe("ok");
    expect(levelClass(1)).toBe("warn");
    expect(levelClass(2)).toBe("crit");
  });
});

describe("sparkline", () => {
  it("quantizes 0-100 into the block ramp and clamps outliers", () => {
    expect(sparkline([0, 100])).toBe("▁█");
    expect(sparkline([-20, 250])).toBe("▁█");
    expect(sparkline([50])).toBe("▅");
  });
});

describe("pick", () => {
  it("reads scalar metrics by actor", () => {
    const zone: PerfZone = {
      cpu_apps: { text: "12%", level: 0, pct: 12 },
    };
    expect(pick(zone, "cpu", "apps")?.text).toBe("12%");
    expect(pick(zone, "cpu", "shirei")).toBeUndefined();
  });

  it("aggregates net down/up into one value", () => {
    const zone: PerfZone = {
      net_down_apps: { text: "1.0 KB/s", level: 0, pct: 0 },
      net_up_apps: { text: "2.0 KB/s", level: 0, pct: 0 },
    };
    expect(pick(zone, "net", "apps")?.text).toBe("↓1.0 KB/s ↑2.0 KB/s");
    expect(pick(zone, "net", "shirei")).toBeUndefined();
  });
});
