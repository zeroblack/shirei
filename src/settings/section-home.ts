import type { Config } from "../config";
import { t } from "../i18n";
import { formatKeystroke, resolveBindings } from "../keys";
import type { SettingsSection } from "./shell";

export function describeEnvironment(
  config: Config,
): { label: string; value: string }[] {
  return [
    {
      label: t("settings.home.env.theme"),
      value:
        config.theme.preset === "dark"
          ? t("settings.home.env.themeDark")
          : t("settings.home.env.themeLight"),
    },
    { label: t("settings.home.env.font"), value: config.font.family },
    {
      label: t("settings.home.env.persistentSessions"),
      value: config.session.keep_alive
        ? t("settings.home.env.on")
        : t("settings.home.env.off"),
    },
    {
      label: t("settings.home.env.defaultTemplate"),
      value: config.layout.default_template || t("settings.home.env.terminal"),
    },
  ];
}

function hero(): HTMLElement {
  const el = document.createElement("div");
  el.className = "home-hero";
  const title = document.createElement("h1");
  title.className = "home-title";
  title.textContent = t("settings.home.title");
  const tag = document.createElement("p");
  tag.className = "home-tag";
  tag.textContent = t("settings.home.tagline");
  el.append(title, tag);
  return el;
}

function envCard(config: Config): HTMLElement {
  const card = document.createElement("div");
  card.className = "home-env";
  for (const { label, value } of describeEnvironment(config)) {
    const row = document.createElement("div");
    row.className = "home-env-row";
    const k = document.createElement("span");
    k.className = "home-env-label";
    k.textContent = label;
    const v = document.createElement("span");
    v.className = "home-env-value";
    v.textContent = value;
    row.append(k, v);
    card.append(row);
  }
  return card;
}

function key(label: string): HTMLElement {
  const k = document.createElement("kbd");
  k.className = "home-key";
  k.textContent = label;
  return k;
}

function stroke(config: Config, action: string): string {
  const ks = resolveBindings(config.keybindings ?? {})[action]?.[0];
  return ks ? formatKeystroke(ks) : "";
}

function quickStart(config: Config): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "home-block";
  const h = document.createElement("h3");
  h.className = "home-block-title";
  h.textContent = t("settings.home.quickStart");
  wrap.append(h);
  const items: [string, string][] = [
    [t("settings.home.quick.palette"), stroke(config, "palette.open")],
    [t("settings.home.quick.tree"), stroke(config, "tree.focus")],
    [t("settings.home.quick.todo"), stroke(config, "todo.focus")],
  ];
  for (const [text, s] of items) {
    if (!s) continue;
    const row = document.createElement("div");
    row.className = "home-quick-row";
    const label = document.createElement("span");
    label.textContent = text;
    row.append(label, key(s));
    wrap.append(row);
  }
  return wrap;
}

function loopDemo(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "home-block";
  const h = document.createElement("h3");
  h.className = "home-block-title";
  h.textContent = t("settings.home.loop");
  const desc = document.createElement("p");
  desc.className = "home-block-desc";
  desc.textContent = t("settings.home.loopDesc");
  const demo = document.createElement("div");
  demo.className = "loop-demo";
  const session = t("settings.home.loop.session");
  const steps = [
    session,
    t("settings.home.loop.fileLine"),
    t("settings.home.loop.editorDiff"),
    session,
  ];
  steps.forEach((label, i) => {
    if (i > 0) {
      const arrow = document.createElement("span");
      arrow.className = "loop-arrow";
      arrow.textContent = "→";
      demo.append(arrow);
    }
    const step = document.createElement("span");
    step.className = "loop-step";
    step.style.setProperty("--i", String(i));
    step.textContent = label;
    demo.append(step);
  });
  wrap.append(h, desc, demo);
  return wrap;
}

export const homeSection: SettingsSection = {
  id: "home",
  label: () => t("settings.home.label"),
  searchText: () => t("settings.home.search"),
  build: (config) => {
    const root = document.createElement("section");
    root.className = "home";
    root.append(hero(), envCard(config), quickStart(config), loopDemo());
    return root;
  },
};
