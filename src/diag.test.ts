import { describe, expect, it } from "vitest";
import { RendererDiag } from "./diag";

type Watch = { watchStall(stalled: boolean, dr: number): void };

const makeDiag = () => {
  let recoveries = 0;
  const diag = new RendererDiag(
    "t",
    false,
    () => "dom",
    () => {
      recoveries += 1;
    },
  );
  return { watch: diag as unknown as Watch, recoveries: () => recoveries };
};

describe("RendererDiag stall watchdog", () => {
  it("requests recovery once after two stalled ticks, not on every tick", () => {
    const { watch, recoveries } = makeDiag();
    watch.watchStall(true, 0);
    expect(recoveries()).toBe(0);
    watch.watchStall(true, 0);
    expect(recoveries()).toBe(1);
    watch.watchStall(true, 0);
    watch.watchStall(true, 0);
    expect(recoveries()).toBe(1);
  });

  it("re-arms only once painting resumes, then can trip again", () => {
    const { watch, recoveries } = makeDiag();
    watch.watchStall(true, 0);
    watch.watchStall(true, 0);
    expect(recoveries()).toBe(1);
    watch.watchStall(false, 5);
    watch.watchStall(true, 0);
    watch.watchStall(true, 0);
    expect(recoveries()).toBe(2);
  });

  it("never trips while paints keep up with incoming data", () => {
    const { watch, recoveries } = makeDiag();
    for (let i = 0; i < 6; i += 1) watch.watchStall(false, 3);
    expect(recoveries()).toBe(0);
  });

  it("a single isolated stall tick does not trip recovery", () => {
    const { watch, recoveries } = makeDiag();
    watch.watchStall(true, 0);
    watch.watchStall(false, 2);
    watch.watchStall(true, 0);
    watch.watchStall(false, 2);
    expect(recoveries()).toBe(0);
  });
});
