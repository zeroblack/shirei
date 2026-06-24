import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { t } from "../i18n";
import type { SettingsSection } from "./shell";

const SITE = "https://dioni.dev";

const COFFEE =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v2"/><path d="M14 2v2"/><path d="M6 2v2"/><path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"/></svg>';

function line(cls: string, text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = cls;
  el.textContent = text;
  return el;
}

export const aboutSection: SettingsSection = {
  id: "about",
  label: () => t("settings.about.label"),
  searchText: () => t("settings.about.search"),
  build: () => {
    const card = document.createElement("div");
    card.className = "about-pane";

    const version = line("about-version", "");
    void getVersion()
      .then((v) => {
        version.textContent = `v${v}`;
      })
      .catch(() => {});

    const essence = document.createElement("p");
    essence.className = "about-essence";
    essence.textContent = t("settings.about.essence");

    const avatar = document.createElement("img");
    avatar.className = "about-avatar";
    avatar.src = "/avatar.png";
    avatar.alt = t("settings.about.avatarAlt");

    const sign = document.createElement("div");
    sign.className = "about-sign";
    const signText = document.createElement("span");
    signText.textContent = t("settings.about.sign");
    const coffee = document.createElement("span");
    coffee.className = "about-ico";
    coffee.innerHTML = COFFEE;
    coffee.setAttribute("aria-hidden", "true");
    sign.append(signText, coffee);

    const link = document.createElement("button");
    link.type = "button";
    link.className = "about-blog";
    link.textContent = "dioni.dev";
    link.addEventListener("click", () => void openUrl(SITE));

    card.append(
      line("about-title", "指令 Shirei"),
      line("about-tagline", t("settings.about.tagline")),
      version,
      essence,
      avatar,
      sign,
      link,
      line("about-foot", t("settings.about.foot")),
    );
    return card;
  },
};
