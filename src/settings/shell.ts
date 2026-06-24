import type { Config } from "../config";
import { type MessageKey, t } from "../i18n";
import { navIcon } from "./nav-icons";

export interface SettingsSection {
  id: string;
  label: string | (() => string);
  group?: string;
  build: (config: Config, save: () => void) => HTMLElement;
  searchText: (config: Config) => string;
}

const sectionLabel = (s: SettingsSection): string =>
  typeof s.label === "function" ? s.label() : s.label;
const groupLabel = (slug: string): string =>
  t(`settings.group.${slug}` as MessageKey);

export interface SettingsHandle {
  showSection: (id: string) => void;
}

export function mountSettings(
  root: HTMLElement,
  config: Config,
  save: () => void,
  sections: SettingsSection[],
): SettingsHandle {
  root.replaceChildren();
  root.classList.add("settings-shell");

  const sidebar = document.createElement("nav");
  sidebar.className = "settings-sidebar";
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = t("settings.shell.searchPlaceholder");
  search.className = "settings-search";
  const list = document.createElement("ul");
  list.className = "settings-nav";
  const content = document.createElement("div");
  content.className = "settings-content";

  const saved = document.createElement("div");
  saved.className = "settings-saved";
  saved.textContent = t("settings.shell.saved");
  saved.setAttribute("role", "status");
  saved.setAttribute("aria-live", "polite");
  let savedTimer: ReturnType<typeof setTimeout> | undefined;
  const notifySave = (): void => {
    save();
    saved.classList.add("show");
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => saved.classList.remove("show"), 1400);
  };

  let activeId = sections[0]?.id ?? "";

  const renderContent = (): void => {
    content.replaceChildren();
    const sec = sections.find((s) => s.id === activeId);
    if (sec) content.appendChild(sec.build(config, notifySave));
  };

  const renderList = (filter: string): void => {
    list.replaceChildren();
    const q = filter.trim().toLowerCase();
    const visible = sections.filter(
      (s) =>
        !q ||
        sectionLabel(s).toLowerCase().includes(q) ||
        s.searchText(config).toLowerCase().includes(q),
    );
    if (visible.length && !visible.some((s) => s.id === activeId)) {
      activeId = visible[0].id;
      renderContent();
    }
    let lastGroup: string | undefined;
    for (const s of visible) {
      if (s.group && s.group !== lastGroup) {
        const head = document.createElement("li");
        head.className = "nav-group";
        head.textContent = groupLabel(s.group);
        head.setAttribute("aria-hidden", "true");
        list.appendChild(head);
        lastGroup = s.group;
      }
      const li = document.createElement("li");
      const icon = document.createElement("span");
      icon.className = "nav-icon";
      icon.innerHTML = navIcon(s.id);
      icon.setAttribute("aria-hidden", "true");
      const text = document.createElement("span");
      text.className = "nav-label";
      text.textContent = sectionLabel(s);
      li.append(icon, text);
      li.tabIndex = 0;
      li.className = s.id === activeId ? "active" : "";
      const go = (): void => {
        activeId = s.id;
        renderList(filter);
        renderContent();
      };
      li.addEventListener("click", go);
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          go();
        }
      });
      list.appendChild(li);
    }
  };

  search.addEventListener("input", () => renderList(search.value));
  sidebar.append(search, list);
  root.append(sidebar, content, saved);
  renderList("");
  renderContent();

  return {
    showSection: (id) => {
      if (!sections.some((s) => s.id === id)) return;
      activeId = id;
      search.value = "";
      renderList("");
      renderContent();
    },
  };
}
