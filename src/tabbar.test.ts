// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { SessionStateEntry } from "./sessionstate";
import { TabBar, type TabBarCallbacks } from "./tabbar";
import type { TabState } from "./types";

Element.prototype.scrollIntoView = () => {};

Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  value: 100,
});
Object.defineProperty(HTMLElement.prototype, "offsetLeft", {
  configurable: true,
  value: 0,
});

(document as unknown as { fonts: { ready: Promise<void> } }).fonts = {
  ready: Promise.resolve(),
} as unknown as { ready: Promise<void> };

const NO_STATES = new Map<string, SessionStateEntry>();
const NO_ATTENTION = new Set<string>();

function terminalTab(id: string): TabState {
  return {
    id,
    kind: "terminal",
    title: id,
    color: null,
    lastUsedAt: Date.now(),
    pinned: false,
  };
}

function callbacks(): TabBarCallbacks {
  return {
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onRename: vi.fn(),
    onRecolor: vi.fn(),
    onReorder: vi.fn(),
    onReconnect: vi.fn(),
    onKill: vi.fn(),
    onPin: vi.fn(),
    onNew: vi.fn(),
  };
}

function newBar(): { bar: TabBar; container: HTMLElement } {
  const container = document.createElement("div");
  const bar = new TabBar(container, callbacks(), ["#ff0000"]);
  return { bar, container };
}

function indicatorMove(container: HTMLElement): string | undefined {
  return container.querySelector<HTMLElement>(".tab-indicator")?.dataset.move;
}

function tabEl(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-tab-id="${id}"]`);
  if (!el) throw new Error(`missing tab ${id}`);
  return el;
}

describe("TabBar indicator move classification", () => {
  it("slides when a click activates a previously inactive tab", () => {
    const { bar, container } = newBar();
    const tabs = [terminalTab("t1"), terminalTab("t2"), terminalTab("t3")];
    bar.render(tabs, "t1", NO_STATES, NO_ATTENTION);

    tabEl(container, "t2").click();
    bar.render(tabs, "t2", NO_STATES, NO_ATTENTION);

    expect(indicatorMove(container)).toBe("slide");
  });

  it("hops between adjacent tabs at the same tab count", () => {
    const { bar, container } = newBar();
    const tabs = [terminalTab("t1"), terminalTab("t2"), terminalTab("t3")];
    bar.render(tabs, "t1", NO_STATES, NO_ATTENTION);

    bar.render(tabs, "t2", NO_STATES, NO_ATTENTION);

    expect(indicatorMove(container)).toBe("hop");
  });

  it("snaps on a far jump of two or more slots", () => {
    const { bar, container } = newBar();
    const tabs = [terminalTab("t1"), terminalTab("t2"), terminalTab("t3")];
    bar.render(tabs, "t1", NO_STATES, NO_ATTENTION);

    bar.render(tabs, "t3", NO_STATES, NO_ATTENTION);

    expect(indicatorMove(container)).toBe("snap");
  });

  it("snaps when re-rendering with the same active id", () => {
    const { bar, container } = newBar();
    const tabs = [terminalTab("t1"), terminalTab("t2")];
    bar.render(tabs, "t1", NO_STATES, NO_ATTENTION);

    bar.render(tabs, "t1", NO_STATES, NO_ATTENTION);

    expect(indicatorMove(container)).toBe("snap");
  });

  it("snaps when the tab count changed, even for an adjacent index", () => {
    const { bar, container } = newBar();
    const tabs = [terminalTab("t1"), terminalTab("t2")];
    bar.render(tabs, "t1", NO_STATES, NO_ATTENTION);

    const grown = [...tabs, terminalTab("t3")];
    bar.render(grown, "t2", NO_STATES, NO_ATTENTION);

    expect(indicatorMove(container)).toBe("snap");
  });

  it("snaps when the previously active tab can no longer be located", () => {
    const { bar, container } = newBar();
    const tabs = [terminalTab("t1"), terminalTab("t2"), terminalTab("t3")];
    bar.render(tabs, null, NO_STATES, NO_ATTENTION);

    bar.render(tabs, "t2", NO_STATES, NO_ATTENTION);

    expect(indicatorMove(container)).toBe("snap");
  });

  it("hides the indicator with zero tabs and does not throw", () => {
    const { bar, container } = newBar();

    expect(() => bar.render([], null, NO_STATES, NO_ATTENTION)).not.toThrow();

    const indicator = container.querySelector<HTMLElement>(".tab-indicator");
    expect(indicator?.style.opacity).toBe("0");
  });

  it("snaps on wraparound from the last tab to the first", () => {
    const { bar, container } = newBar();
    const tabs = [terminalTab("t1"), terminalTab("t2"), terminalTab("t3")];
    bar.render(tabs, "t3", NO_STATES, NO_ATTENTION);

    bar.render(tabs, "t1", NO_STATES, NO_ATTENTION);

    expect(indicatorMove(container)).toBe("snap");
  });

  it("does not leak a slide into the next render after clicking the already-active tab", () => {
    const { bar, container } = newBar();
    const tabs = [terminalTab("t1"), terminalTab("t2")];
    bar.render(tabs, "t1", NO_STATES, NO_ATTENTION);

    tabEl(container, "t1").click();
    bar.render(tabs, "t1", NO_STATES, NO_ATTENTION);

    expect(indicatorMove(container)).not.toBe("slide");
  });

  it("leaves an in-flight slide's transform and dataset.move untouched on a same-target snap", () => {
    const { bar, container } = newBar();
    const tabs = [terminalTab("t1"), terminalTab("t2"), terminalTab("t3")];
    bar.render(tabs, "t1", NO_STATES, NO_ATTENTION);

    tabEl(container, "t2").click();
    bar.render(tabs, "t2", NO_STATES, NO_ATTENTION);

    const indicator = container.querySelector<HTMLElement>(".tab-indicator");
    const moveAfterSlide = indicator?.dataset.move;
    const transformAfterSlide = indicator?.style.transform;
    expect(moveAfterSlide).toBe("slide");

    bar.render(tabs, "t2", NO_STATES, NO_ATTENTION);

    expect(indicator?.dataset.move).toBe(moveAfterSlide);
    expect(indicator?.style.transform).toBe(transformAfterSlide);
  });
});
