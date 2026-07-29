// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { Config } from "../config";
import { setLocale } from "../i18n";
import { SHAPE_ORDER, shapeGallery } from "./section-focus";

function configWith(timerShape: string): Config {
  return { focus: { timer_shape: timerShape } } as unknown as Config;
}

describe("shapeGallery", () => {
  it("renders one card per shape in the config enum, in order", () => {
    setLocale("en");
    const grid = shapeGallery(
      configWith("ring"),
      () => {},
      () => {},
    );
    const cards = Array.from(grid.querySelectorAll(".theme-card"));
    expect(cards).toHaveLength(SHAPE_ORDER.length);
    const labels = cards.map(
      (card) => card.querySelector(".theme-card-tag span")?.textContent,
    );
    expect(labels).toEqual(["Ring", "Liquid", "Coffee", "Hourglass", "Bar"]);
  });

  it("marks only the active shape as selected", () => {
    const grid = shapeGallery(
      configWith("bar"),
      () => {},
      () => {},
    );
    const cards = Array.from(grid.querySelectorAll(".theme-card"));
    const selectedIndex = SHAPE_ORDER.indexOf("bar");
    for (const [i, card] of cards.entries()) {
      expect(card.classList.contains("selected")).toBe(i === selectedIndex);
      expect(card.getAttribute("aria-pressed")).toBe(
        String(i === selectedIndex),
      );
    }
  });

  it("writes config.focus.timer_shape and persists on click", () => {
    const config = configWith("ring");
    let saved = false;
    let rebuilt = false;
    const grid = shapeGallery(
      config,
      () => {
        saved = true;
      },
      () => {
        rebuilt = true;
      },
    );
    const cards = grid.querySelectorAll(".theme-card");
    const hourglassCard = cards[SHAPE_ORDER.indexOf("hourglass")];
    (hourglassCard as HTMLButtonElement).click();

    expect(config.focus.timer_shape).toBe("hourglass");
    expect(saved).toBe(true);
    expect(rebuilt).toBe(true);
  });
});
