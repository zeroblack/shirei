import type {
  CliRegistryEntry,
  Config,
  NotifyChannel,
  PayloadVerbosity,
  SoundTimbre,
} from "../config";
import { t } from "../i18n";
import type { SettingsSection } from "./shell";
import {
  boolField,
  checkbox,
  fieldsGrid,
  groupLabel,
  iconButton,
  numField,
  selectField,
  textField,
  textInput,
  timeField,
} from "./widgets";

const TRASH =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

function cliRow(
  entry: CliRegistryEntry,
  save: () => void,
  onRemove: () => void,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "cli-item";
  if (!entry.enabled) row.classList.add("disabled");
  if (!entry.ready) row.classList.add("soon");

  const meta = document.createElement("div");
  meta.className = "cli-meta";
  const label = document.createElement("span");
  label.className = "cli-label";
  label.textContent = entry.label;
  const match = document.createElement("span");
  match.className = "cli-match";
  match.textContent = entry.process_match;
  meta.append(label, match);

  // A CLI whose detection isn't validated yet can't be turned on — it wears a
  // "Soon" tag instead of a toggle, so the UI never implies it already works.
  if (entry.ready) {
    const toggle = checkbox(entry.enabled, (v) => {
      entry.enabled = v;
      row.classList.toggle("disabled", !v);
      save();
    });
    row.append(meta, toggle);
  } else {
    const soon = document.createElement("span");
    soon.className = "cli-soon";
    soon.textContent = t("settings.agents.clis.soon");
    soon.title = t("settings.agents.clis.soonHint");
    row.append(meta, soon);
  }

  if (entry.custom) {
    row.append(
      iconButton(
        TRASH,
        "project-icon-btn",
        t("settings.agents.clis.remove"),
        onRemove,
      ),
    );
  }

  return row;
}

function clisTab(config: Config, save: () => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "cli-tab";

  const desc = document.createElement("p");
  desc.className = "section-desc";
  desc.textContent = t("settings.agents.clis.desc");
  wrap.append(desc);

  const list = document.createElement("div");
  list.className = "cli-list";
  wrap.append(list);

  const rebuild = (): void => {
    list.replaceChildren();
    for (const entry of config.cli_registry) {
      list.append(
        cliRow(entry, save, () => {
          const idx = config.cli_registry.indexOf(entry);
          if (idx !== -1) config.cli_registry.splice(idx, 1);
          save();
          rebuild();
        }),
      );
    }
  };
  rebuild();

  const form = document.createElement("div");
  form.className = "cli-add";
  const labelInput = textInput("", () => {});
  labelInput.placeholder = t("settings.agents.clis.customLabelPlaceholder");
  const matchInput = textInput("", () => {});
  matchInput.placeholder = t("settings.agents.clis.customMatchPlaceholder");
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "settings-action";
  addBtn.textContent = t("settings.agents.clis.addCustom");
  addBtn.addEventListener("click", () => {
    const label = labelInput.value.trim();
    const match = matchInput.value.trim();
    if (!label || !match) return;
    config.cli_registry.push({
      id: crypto.randomUUID(),
      label,
      process_match: match,
      enabled: true,
      ready: true,
      custom: true,
    });
    labelInput.value = "";
    matchInput.value = "";
    save();
    rebuild();
  });
  form.append(labelInput, matchInput, addBtn);
  wrap.append(form);

  return wrap;
}

function detectionTab(config: Config, save: () => void): HTMLElement {
  const d = config.detection;
  return fieldsGrid([
    numField(
      t("settings.agents.detection.idleThreshold"),
      d,
      "idle_threshold_ms",
      {
        min: 200,
        max: 5000,
        step: 100,
        desc: t("settings.agents.detection.idleThresholdDesc"),
      },
      save,
    ),
    numField(
      t("settings.agents.detection.tentativeThreshold"),
      d,
      "tentative_threshold_ms",
      {
        min: 15000,
        max: 120000,
        step: 5000,
        desc: t("settings.agents.detection.tentativeThresholdDesc"),
      },
      save,
    ),
    numField(
      t("settings.agents.detection.hysteresis"),
      d,
      "hysteresis_samples",
      {
        min: 1,
        max: 10,
        desc: t("settings.agents.detection.hysteresisDesc"),
      },
      save,
    ),
    numField(
      t("settings.agents.detection.pollInterval"),
      d,
      "poll_interval_ms",
      {
        min: 100,
        max: 2000,
        step: 50,
        desc: t("settings.agents.detection.pollIntervalDesc"),
      },
      save,
    ),
    textField(
      t("settings.agents.detection.termProgram"),
      d,
      "term_program",
      save,
      "shirei",
      t("settings.agents.detection.termProgramDesc"),
    ),
  ]);
}

function notificationsTab(config: Config, save: () => void): HTMLElement {
  const n = config.notifications;

  const channelOptions: [NotifyChannel, string][] = [
    ["os", t("settings.agents.notifications.channel.os")],
    ["in-app", t("settings.agents.notifications.channel.inApp")],
    ["off", t("settings.agents.notifications.channel.off")],
  ];
  const timbreOptions: [SoundTimbre, string][] = [
    ["soft", t("settings.agents.notifications.timbre.soft")],
    ["deep", t("settings.agents.notifications.timbre.deep")],
  ];
  const verbosityOptions: [PayloadVerbosity, string][] = [
    ["full", t("settings.agents.notifications.payload.full")],
    ["redacted", t("settings.agents.notifications.payload.redacted")],
    ["identity-only", t("settings.agents.notifications.payload.identityOnly")],
  ];

  return fieldsGrid([
    groupLabel(t("settings.agents.notifications.group.channels")),
    selectField(
      t("settings.agents.notifications.channelWaiting"),
      channelOptions,
      n.channels,
      "waiting",
      save,
    ),
    selectField(
      t("settings.agents.notifications.channelDone"),
      channelOptions,
      n.channels,
      "done",
      save,
    ),
    selectField(
      t("settings.agents.notifications.channelErrored"),
      channelOptions,
      n.channels,
      "errored",
      save,
    ),

    groupLabel(t("settings.agents.notifications.group.sound")),
    boolField(
      t("settings.agents.notifications.soundEnabled"),
      n.sound,
      "enabled",
      save,
      t("settings.agents.notifications.soundEnabledDesc"),
    ),
    selectField(
      t("settings.agents.notifications.waitingTimbre"),
      timbreOptions,
      n.sound,
      "waiting_timbre",
      save,
    ),
    selectField(
      t("settings.agents.notifications.errorTimbre"),
      timbreOptions,
      n.sound,
      "error_timbre",
      save,
    ),
    numField(
      t("settings.agents.notifications.coalescing"),
      n,
      "coalescing_ms",
      {
        min: 0,
        max: 30,
        step: 0.5,
        scale: 1000,
        desc: t("settings.agents.notifications.coalescingDesc"),
      },
      save,
    ),

    groupLabel(t("settings.agents.notifications.group.quietHours")),
    boolField(
      t("settings.agents.notifications.quietHoursEnabled"),
      n.quiet_hours,
      "enabled",
      save,
    ),
    timeField(
      t("settings.agents.notifications.quietHoursStart"),
      n.quiet_hours,
      "start",
      save,
    ),
    timeField(
      t("settings.agents.notifications.quietHoursEnd"),
      n.quiet_hours,
      "end",
      save,
    ),

    groupLabel(t("settings.agents.notifications.group.payload")),
    selectField(
      t("settings.agents.notifications.payloadVerbosity"),
      verbosityOptions,
      n,
      "payload_verbosity",
      save,
      t("settings.agents.notifications.payloadVerbosityDesc"),
    ),
    boolField(
      t("settings.agents.notifications.appendCli"),
      n.identity,
      "append_cli",
      save,
    ),
    boolField(
      t("settings.agents.notifications.appendBranch"),
      n.identity,
      "append_branch",
      save,
    ),
    numField(
      t("settings.agents.notifications.truncation"),
      n,
      "truncation_length",
      { min: 40, max: 400, step: 10 },
      save,
    ),
  ]);
}

function shortcutsTab(): HTMLElement {
  const wrap = document.createElement("div");
  const hint = document.createElement("p");
  hint.className = "templates-hint";
  hint.textContent = t("settings.agents.shortcuts.note");
  wrap.append(hint);
  return wrap;
}

interface AgentsTab {
  id: string;
  label: string;
  render: () => HTMLElement;
}

function buildAgents(config: Config, save: () => void): HTMLElement {
  const tabs: AgentsTab[] = [
    {
      id: "clis",
      label: t("settings.agents.tab.clis"),
      render: () => clisTab(config, save),
    },
    {
      id: "detection",
      label: t("settings.agents.tab.detection"),
      render: () => detectionTab(config, save),
    },
    {
      id: "notifications",
      label: t("settings.agents.tab.notifications"),
      render: () => notificationsTab(config, save),
    },
    {
      id: "shortcuts",
      label: t("settings.agents.tab.shortcuts"),
      render: () => shortcutsTab(),
    },
  ];

  let active = tabs[0].id;
  const sec = document.createElement("section");
  sec.className = "settings-section";
  const h = document.createElement("h2");
  h.textContent = t("settings.agents.title");
  const desc = document.createElement("p");
  desc.className = "section-desc";
  desc.textContent = t("settings.agents.desc");
  const tabbar = document.createElement("div");
  tabbar.className = "appearance-tabs";
  const content = document.createElement("div");

  const render = (): void => {
    tabbar.replaceChildren();
    for (const tab of tabs) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = tab.id === active ? "seg-tab active" : "seg-tab";
      btn.textContent = tab.label;
      btn.addEventListener("click", () => {
        active = tab.id;
        render();
      });
      tabbar.appendChild(btn);
    }
    const tab = tabs.find((x) => x.id === active) ?? tabs[0];
    content.replaceChildren(tab.render());
  };

  sec.append(h, desc, tabbar, content);
  render();
  return sec;
}

export const agentsSection: SettingsSection = {
  id: "agents",
  label: () => t("settings.agents.label"),
  searchText: () => t("settings.agents.search"),
  build: (config, save) => buildAgents(config, save),
};
