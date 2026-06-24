import { describe, expect, it } from "vitest";
import {
  moveTarget,
  renderFilename,
  resolveFinish,
  selectorAction,
  toPhysicalRect,
} from "./screencast-core";

describe("toPhysicalRect", () => {
  it("scales a CSS rect by dpr and subtracts the titlebar offset", () => {
    const css = { x: 10, y: 50, width: 100, height: 80 };
    const r = toPhysicalRect(css, { dpr: 2, titlebarOffsetCss: 28 });
    expect(r).toEqual({ x: 20, y: 44, width: 200, height: 160 });
  });
  it("clamps negative coords to zero", () => {
    const css = { x: 0, y: 0, width: 50, height: 50 };
    const r = toPhysicalRect(css, { dpr: 1, titlebarOffsetCss: 28 });
    expect(r).toEqual({ x: 0, y: 0, width: 50, height: 50 });
  });
  it("rounds to integer pixels", () => {
    const css = { x: 5.4, y: 10.6, width: 33.3, height: 7.7 };
    const r = toPhysicalRect(css, { dpr: 1, titlebarOffsetCss: 0 });
    expect(r).toEqual({ x: 5, y: 11, width: 33, height: 8 });
  });
});

describe("renderFilename", () => {
  const date = new Date("2026-06-14T16:53:09");
  it("substitutes {tab} and {date} and slugifies the tab", () => {
    expect(
      renderFilename("{tab}-{date}", { tab: "My Project!", date, ext: "mp4" }),
    ).toBe("my-project-20260614-165309.mp4");
  });
  it("falls back to shirei when tab is empty", () => {
    expect(renderFilename("{tab}-{date}", { tab: "", date, ext: "gif" })).toBe(
      "shirei-20260614-165309.gif",
    );
  });
  it("ignores unknown tokens literally", () => {
    expect(renderFilename("cast-{date}", { tab: "x", date, ext: "mp4" })).toBe(
      "cast-20260614-165309.mp4",
    );
  });
});

describe("selectorAction", () => {
  it("maps p/a/r to targets", () => {
    expect(selectorAction("p")).toEqual({ kind: "target", target: "panel" });
    expect(selectorAction("a")).toEqual({ kind: "target", target: "app" });
    expect(selectorAction("r")).toEqual({ kind: "target", target: "region" });
  });
  it("maps m/g to format toggles", () => {
    expect(selectorAction("m")).toEqual({ kind: "format", format: "mp4" });
    expect(selectorAction("g")).toEqual({ kind: "format", format: "gif" });
  });
  it("maps Enter and Escape", () => {
    expect(selectorAction("Enter")).toEqual({ kind: "confirm" });
    expect(selectorAction("Escape")).toEqual({ kind: "cancel" });
  });
  it("is case-insensitive and ignores unknown keys", () => {
    expect(selectorAction("A")).toEqual({ kind: "target", target: "app" });
    expect(selectorAction("z")).toBeNull();
  });
  it("maps arrows: up/down move target, left/right cycle format", () => {
    expect(selectorAction("ArrowDown")).toEqual({ kind: "move", delta: 1 });
    expect(selectorAction("ArrowUp")).toEqual({ kind: "move", delta: -1 });
    expect(selectorAction("ArrowLeft")).toEqual({ kind: "format-cycle" });
    expect(selectorAction("ArrowRight")).toEqual({ kind: "format-cycle" });
  });
});

describe("moveTarget", () => {
  it("walks the target list and wraps around both ends", () => {
    expect(moveTarget("panel", 1)).toBe("app");
    expect(moveTarget("app", 1)).toBe("region");
    expect(moveTarget("region", 1)).toBe("panel");
    expect(moveTarget("panel", -1)).toBe("region");
  });
});

describe("resolveFinish", () => {
  it("returns the configured action when not ask", () => {
    expect(resolveFinish("copy", null)).toBe("copy");
    expect(resolveFinish("none", "f")).toBe("none");
  });
  it("uses the prompt choice when config is ask", () => {
    expect(resolveFinish("ask", "c")).toBe("copy");
    expect(resolveFinish("ask", "f")).toBe("reveal");
    expect(resolveFinish("ask", "s")).toBe("share");
  });
  it("defaults ask with no choice to reveal", () => {
    expect(resolveFinish("ask", null)).toBe("reveal");
  });
});
