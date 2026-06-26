import type { Config } from "../config";
import { type MessageKey, t } from "../i18n";
import { navIcon } from "./nav-icons";
import { nextSectionIndex } from "./nav-keys";

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
  focusSearch: () => void;
  focusActive: () => void;
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
  let navItems: { id: string; el: HTMLLIElement }[] = [];

  const renderContent = (): void => {
    content.replaceChildren();
    const sec = sections.find((s) => s.id === activeId);
    if (sec) content.appendChild(sec.build(config, notifySave));
  };

  const activate = (id: string, focus: boolean): void => {
    activeId = id;
    for (const it of navItems) {
      const isActive = it.id === id;
      it.el.classList.toggle("active", isActive);
      it.el.tabIndex = isActive ? 0 : -1;
      if (isActive) it.el.setAttribute("aria-current", "true");
      else it.el.removeAttribute("aria-current");
    }
    renderContent();
    if (focus) navItems.find((it) => it.id === id)?.el.focus();
  };

  const renderList = (filter: string): void => {
    list.replaceChildren();
    navItems = [];
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
      const isActive = s.id === activeId;
      li.className = isActive ? "active" : "";
      li.tabIndex = isActive ? 0 : -1;
      if (isActive) li.setAttribute("aria-current", "true");
      li.addEventListener("click", () => activate(s.id, true));
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate(s.id, true);
          return;
        }
        const idx = navItems.findIndex((it) => it.id === activeId);
        const next = nextSectionIndex(navItems.length, idx, e.key);
        if (next >= 0 && next !== idx) {
          e.preventDefault();
          activate(navItems[next].id, true);
        }
      });
      navItems.push({ id: s.id, el: li });
      list.appendChild(li);
    }
  };

  search.addEventListener("input", () => renderList(search.value));
  search.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "Enter") {
      const target = navItems.find((it) => it.id === activeId) ?? navItems[0];
      if (target) {
        e.preventDefault();
        target.el.focus();
      }
    }
  });
  list.setAttribute("aria-label", t("settings.shell.searchPlaceholder"));
  sidebar.append(search, list);
  root.append(sidebar, content, saved);
  renderList("");
  renderContent();

  return {
    showSection: (id) => {
      if (!sections.some((s) => s.id === id)) return;
      search.value = "";
      activeId = id;
      renderList("");
      activate(id, false);
    },
    focusSearch: () => search.focus(),
    focusActive: () => navItems.find((it) => it.id === activeId)?.el.focus(),
  };
}
