import "./fonts.css";
import "./tokens.css";
import "./craft.css";
import "./settings.css";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { type Config, configGet, configSet, onConfigChanged } from "./config";
import { assignDeep } from "./deepmerge";
import { registerInstalledFonts } from "./fonts";
import { getLocale, setLocale } from "./i18n";
import { SECTION_LAYOUT, type SectionId } from "./settings/registry";
import { aboutSection } from "./settings/section-about";
import { advancedSection } from "./settings/section-advanced";
import { appearanceSection } from "./settings/section-appearance";
import { homeSection } from "./settings/section-home";
import { performanceSection } from "./settings/section-performance";
import { projectsSection } from "./settings/section-projects";
import { recordingSection } from "./settings/section-recording";
import { sessionSection } from "./settings/section-session";
import { shortcutsSection } from "./settings/section-shortcuts";
import { tabsSection } from "./settings/section-tabs";
import { terminalSection } from "./settings/section-terminal";
import { mountSettings, type SettingsSection } from "./settings/shell";

const BY_ID: Record<SectionId, SettingsSection> = {
  home: homeSection,
  appearance: appearanceSection,
  projects: projectsSection,
  shortcuts: shortcutsSection,
  terminal: terminalSection,
  sessions: sessionSection,
  tabs: tabsSection,
  recording: recordingSection,
  performance: performanceSection,
  about: aboutSection,
  advanced: advancedSection,
};

const SECTIONS: SettingsSection[] = SECTION_LAYOUT.map((l) => ({
  ...BY_ID[l.id],
  group: l.group,
}));

let config: Config;

window.addEventListener("DOMContentLoaded", async () => {
  const root = document.querySelector<HTMLElement>("#settings");
  if (!root) return;
  config = await configGet();
  setLocale(config.locale);
  await registerInstalledFonts(config.fonts).catch(() => {});
  const save = (): void => void configSet(config);
  let handle = mountSettings(root, config, save, SECTIONS);

  // The menu's "About Shirei" opens this window on the About section: a fresh
  // window via the URL hash, an already-open one via this event.
  const initial = location.hash.replace(/^#/, "");
  if (initial) handle.showSection(initial);
  void listen<string>("settings-show-section", (e) =>
    handle.showSection(e.payload),
  );
  // Keeps the in-memory object current when config changes (config_set echoes
  // its own change back here, plus external edits). assignDeep mutates nested
  // objects in place so the references captured by mounted widgets stay live;
  // a shallow replace would strand them and drop later edits. A locale switch is
  // the exception: it must remount so every label re-renders.
  onConfigChanged((c) => {
    const localeChanged = c.locale !== getLocale();
    assignDeep(
      config as unknown as Record<string, unknown>,
      c as unknown as Record<string, unknown>,
    );
    if (localeChanged) {
      setLocale(c.locale);
      handle = mountSettings(root, config, save, SECTIONS);
    }
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      void getCurrentWindow().close();
      return;
    }
    if (e.key === "/") {
      const el = document.activeElement;
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement;
      if (!typing) {
        e.preventDefault();
        handle.focusSearch();
      }
    }
  });
});
