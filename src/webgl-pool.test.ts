import { describe, expect, it } from "vitest";
import { WebglPool } from "./webgl-pool";

function spy() {
  const calls = { enable: 0, disable: 0 };
  return {
    calls,
    enable: () => {
      calls.enable += 1;
    },
    disable: () => {
      calls.disable += 1;
    },
  };
}

describe("WebglPool", () => {
  it("touch enables a registered session", () => {
    const pool = new WebglPool(2);
    const a = spy();
    pool.register("a", a.enable, a.disable);
    pool.touch("a");
    expect(a.calls.enable).toBe(1);
  });

  it("honors the cap and evicts the least recent (LRU)", () => {
    const pool = new WebglPool(2);
    const a = spy();
    const b = spy();
    const c = spy();
    pool.register("a", a.enable, a.disable);
    pool.register("b", b.enable, b.disable);
    pool.register("c", c.enable, c.disable);
    pool.touch("a");
    pool.touch("b");
    pool.touch("c");
    expect(a.calls.disable).toBe(1);
    expect(b.calls.disable).toBe(0);
    expect(c.calls.enable).toBe(1);
  });

  it("re-touch reorders the LRU: the just-used entry is not evicted", () => {
    const pool = new WebglPool(2);
    const a = spy();
    const b = spy();
    const c = spy();
    pool.register("a", a.enable, a.disable);
    pool.register("b", b.enable, b.disable);
    pool.register("c", c.enable, c.disable);
    pool.touch("a");
    pool.touch("b");
    pool.touch("a");
    pool.touch("c");
    expect(b.calls.disable).toBe(1);
    expect(a.calls.disable).toBe(0);
  });

  it("idempotent touch does not re-enable", () => {
    const pool = new WebglPool(2);
    const a = spy();
    pool.register("a", a.enable, a.disable);
    pool.touch("a");
    pool.touch("a");
    expect(a.calls.enable).toBe(1);
  });

  it("unregister disables and frees the slot", () => {
    const pool = new WebglPool(1);
    const a = spy();
    const b = spy();
    pool.register("a", a.enable, a.disable);
    pool.register("b", b.enable, b.disable);
    pool.touch("a");
    pool.unregister("a");
    expect(a.calls.disable).toBe(1);
    pool.touch("b");
    expect(b.calls.enable).toBe(1);
    expect(b.calls.disable).toBe(0);
  });

  it("setEnabled(false) disables everything and makes touch inert", () => {
    const pool = new WebglPool(2);
    const a = spy();
    pool.register("a", a.enable, a.disable);
    pool.touch("a");
    pool.setEnabled(false);
    expect(a.calls.disable).toBe(1);
    pool.touch("a");
    expect(a.calls.enable).toBe(1);
  });

  it("markExhausted strands every pane and makes touch inert", () => {
    const pool = new WebglPool(4);
    const a = spy();
    const b = spy();
    pool.register("a", a.enable, a.disable);
    pool.register("b", b.enable, b.disable);
    pool.touch("a");
    pool.markExhausted();
    expect(a.calls.disable).toBe(1);
    expect(pool.isExhausted()).toBe(true);
    pool.touch("b");
    expect(b.calls.enable).toBe(0);
  });

  it("a failed enable trips the fuse and the entry stays on DOM", () => {
    const pool = new WebglPool(4);
    const b = spy();
    pool.register(
      "a",
      () => pool.markExhausted(),
      () => {},
    );
    pool.register("b", b.enable, b.disable);
    pool.touch("a");
    expect(pool.isExhausted()).toBe(true);
    pool.touch("b");
    expect(b.calls.enable).toBe(0);
  });
});
