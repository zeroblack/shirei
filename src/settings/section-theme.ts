import type { Config } from "../config";
import { t } from "../i18n";
import { THEMES, type ThemeDef, themeMatches } from "./themes";

const CHECK =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

function preview(theme: ThemeDef): HTMLElement {
  const c = theme.terminal;
  const box = document.createElement("div");
  box.className = "theme-preview";
  box.style.background = c.bg;
  box.style.color = c.fg;

  const line = (parts: [string, string?][]): HTMLElement => {
    const row = document.createElement("span");
    row.className = "tp-line";
    for (const [text, color] of parts) {
      const seg = document.createElement("span");
      seg.textContent = text;
      if (color) seg.style.color = color;
      row.appendChild(seg);
    }
    return row;
  };

  box.append(
    line([
      ["❯ ", c.green],
      ["claude", undefined],
    ]),
    line([
      ["● ", c.blue],
      [t("settings.theme.previewEditing"), c.magenta],
    ]),
    line([
      ["+ 24  ", c.green],
      ["− 6", c.red],
    ]),
  );
  return box;
}

export function themeGallery(config: Config, save: () => void): HTMLElement {
  const grid = document.createElement("div");
  grid.className = "theme-gallery";
  const cards: { t: ThemeDef; el: HTMLButtonElement }[] = [];

  const sync = (): void => {
    for (const { t, el } of cards) {
      const on = themeMatches(t, config.theme.terminal);
      el.classList.toggle("selected", on);
      el.setAttribute("aria-pressed", String(on));
    }
  };

  for (const t of THEMES) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "theme-card";

    const tag = document.createElement("span");
    tag.className = "theme-card-tag";
    const name = document.createElement("span");
    name.textContent = t.label;
    const check = document.createElement("span");
    check.className = "theme-card-check";
    check.innerHTML = CHECK;
    check.setAttribute("aria-hidden", "true");
    tag.append(name, check);

    card.append(preview(t), tag);
    card.addEventListener("click", () => {
      config.theme.preset = t.preset;
      Object.assign(config.theme.terminal, t.terminal);
      sync();
      save();
    });
    cards.push({ t, el: card });
    grid.appendChild(card);
  }

  sync();
  return grid;
}
