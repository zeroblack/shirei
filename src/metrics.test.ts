import { describe, expect, it, vi } from "vitest";
import { MetricsLogger, makeEvent } from "./metrics";

const cfg = {
  enabled: true,
  retention_days: 0,
  flush_interval_ms: 5000,
  activity_ping_ms: 30000,
  idle_after_ms: 120000,
  dormant_after_ms: 900000,
};

describe("MetricsLogger", () => {
  it("buffers events and flushes them through the sink", async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    const logger = new MetricsLogger(cfg, sink);
    logger.log(makeEvent("session_start", { sessionId: "s1" }));
    logger.log(makeEvent("input_activity", { sessionId: "s1" }));
    await logger.flush();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toHaveLength(2);
    expect(sink.mock.calls[0][0][0].kind).toBe("session_start");
    await logger.flush(); // empty buffer → no extra call
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when disabled", async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    const logger = new MetricsLogger({ ...cfg, enabled: false }, sink);
    logger.log(makeEvent("session_start", {}));
    await logger.flush();
    expect(sink).not.toHaveBeenCalled();
  });

  it("re-queues events if the sink rejects", async () => {
    const sink = vi
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValue(undefined);
    const logger = new MetricsLogger(cfg, sink);
    logger.log(makeEvent("session_start", {}));
    await logger.flush(); // fails, event stays buffered
    await logger.flush(); // retries successfully
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls[1][0]).toHaveLength(1);
  });

  it("starts flushing once setConfig enables a disabled logger", async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    const logger = new MetricsLogger({ ...cfg, enabled: false }, sink);
    logger.log(makeEvent("session_start", {}));
    await logger.flush();
    expect(sink).not.toHaveBeenCalled();

    logger.setConfig({ ...cfg, enabled: true });
    logger.log(makeEvent("session_start", {}));
    await logger.flush();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toHaveLength(1);

    await logger.dispose();
  });

  it("stops flushing once setConfig disables an enabled logger", async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    const logger = new MetricsLogger(cfg, sink);
    logger.setConfig({ ...cfg, enabled: false });
    logger.log(makeEvent("session_start", {}));
    await logger.flush();
    expect(sink).not.toHaveBeenCalled();
  });
});

describe("makeEvent", () => {
  it("stamps utc + tz and passes null project through", () => {
    const e = makeEvent("tab_created", { tabId: "t1", projectId: null });
    expect(e.kind).toBe("tab_created");
    expect(e.tabId).toBe("t1");
    expect(e.projectId).toBeNull();
    expect(typeof e.tsUtc).toBe("number");
    expect(typeof e.tzOffsetMin).toBe("number");
  });
});

import { type DormancyState, dormancyTransition } from "./metrics";

const active: DormancyState = { state: "active", shown: true, lastActiveAt: 0 };
const DORMANT_MS = 900000;

describe("dormancyTransition", () => {
  it("goes dormant only after the timeout while hidden", () => {
    const hidden = dormancyTransition(active, "hidden", 1000, DORMANT_MS);
    expect(hidden.next.shown).toBe(false);
    expect(hidden.emit).toBeUndefined();
    const early = dormancyTransition(
      hidden.next,
      "tick",
      1000 + DORMANT_MS - 1,
      DORMANT_MS,
    );
    expect(early.emit).toBeUndefined();
    const late = dormancyTransition(
      hidden.next,
      "tick",
      1000 + DORMANT_MS,
      DORMANT_MS,
    );
    expect(late.next.state).toBe("dormant");
    expect(late.emit).toBe("tab_dormant");
  });

  it("never goes dormant while shown", () => {
    const r = dormancyTransition(active, "tick", 10 * DORMANT_MS, DORMANT_MS);
    expect(r.next.state).toBe("active");
    expect(r.emit).toBeUndefined();
  });

  it("wakes on activity or re-show and emits once", () => {
    const dormant: DormancyState = {
      state: "dormant",
      shown: false,
      lastActiveAt: 0,
    };
    const woke = dormancyTransition(dormant, "activity", 5000, DORMANT_MS);
    expect(woke.next.state).toBe("active");
    expect(woke.next.lastActiveAt).toBe(5000);
    expect(woke.emit).toBe("tab_woken");
    const again = dormancyTransition(woke.next, "activity", 6000, DORMANT_MS);
    expect(again.emit).toBeUndefined();
  });
});
