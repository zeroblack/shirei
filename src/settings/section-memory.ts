import {
  type MemoryHandshake,
  type MemoryRegistration,
  memoryAdapterPreview,
  memoryAdapterRegister,
  memoryAdaptersStatus,
  memoryAdapterUnregister,
  memoryHandshake,
} from "../config";
import { confirmDialog } from "../confirm";
import { errorMessage } from "../errors";
import { type MessageKey, t } from "../i18n";
import { showToast } from "../toast";
import type { SettingsSection } from "./shell";
import {
  boolField,
  groupLabel,
  numField,
  section,
  textAreaField,
  textField,
} from "./widgets";

interface RowHandlers {
  onRegister: (id: string) => void;
  onUnregister: (id: string) => void;
}

export function renderAdapterRow(
  reg: MemoryRegistration,
  label: string,
  h: RowHandlers,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "memory-adapter";
  row.dataset.state = reg.state;
  row.dataset.detected = String(reg.detected);

  const name = document.createElement("span");
  name.className = "memory-adapter-name";
  name.textContent = label;

  const path = document.createElement("code");
  path.className = "memory-adapter-path";
  path.textContent = reg.config_path;
  path.title = reg.config_path;

  const state = document.createElement("span");
  state.className = "memory-adapter-state";
  state.dataset.state = reg.state;
  state.textContent = t(`settings.memory.state.${reg.state}` as MessageKey);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "settings-action";
  if (reg.state === "registered") {
    btn.dataset.action = "unregister";
    btn.textContent = t("settings.memory.unregister");
    btn.onclick = () => h.onUnregister(reg.id);
  } else {
    btn.dataset.action = "register";
    btn.textContent =
      reg.state === "drifted"
        ? t("settings.memory.repair")
        : t("settings.memory.register");
    btn.onclick = () => h.onRegister(reg.id);
  }
  row.append(name, path);
  if (!reg.detected) {
    const missing = document.createElement("span");
    missing.className = "memory-adapter-detected";
    missing.textContent = t("settings.memory.notDetected");
    row.append(missing);
  }
  row.append(state, btn);
  return row;
}

// A written config file only proves the text landed. This row reports whether the server
// behind it actually answers, so a stale shim or a broken binary is visible here instead of
// showing up later as an agent that quietly has no memory.
export function renderHandshakeRow(h: MemoryHandshake): HTMLElement {
  const row = document.createElement("div");
  row.className = "memory-handshake";
  row.dataset.ok = String(h.ok);

  const name = document.createElement("span");
  name.className = "memory-adapter-name";
  name.textContent = t("settings.memory.handshake");

  const detail = document.createElement("code");
  detail.className = "memory-adapter-path";
  detail.textContent = h.ok ? `${h.server} · ${h.tools.length} tools` : h.error;
  detail.title = h.shim_path;

  const state = document.createElement("span");
  state.className = "memory-adapter-state";
  state.dataset.state = h.ok ? "registered" : "missing";
  state.textContent = h.ok
    ? t("settings.memory.handshakeOk")
    : t("settings.memory.handshakeFail");

  row.append(name, detail, state);
  return row;
}

async function confirmPreview(id: string): Promise<boolean> {
  const p = await memoryAdapterPreview(id);
  const box = document.createElement("div");
  box.className = "memory-preview";
  const pre = document.createElement("pre");
  pre.textContent = p.diff || p.after;
  box.append(pre);
  return confirmDialog({
    title: `${t("settings.memory.previewTitle")} ${p.config_path}`,
    content: box,
    confirmLabel: t("settings.memory.apply"),
    danger: false,
  });
}

export const memorySection: SettingsSection = {
  id: "memory",
  label: () => t("settings.memory.label"),
  searchText: () => t("settings.memory.search"),
  build: (config, save) => {
    const m = config.memory;
    const list = document.createElement("div");
    list.className = "memory-adapters";
    const server = document.createElement("div");
    server.className = "memory-adapters";
    const labels = new Map(m.cli_adapters.map((a) => [a.id, a.display_name]));
    const refresh = async () => {
      try {
        memoryHandshake()
          .then((h) => server.replaceChildren(renderHandshakeRow(h)))
          .catch((e) => showToast(errorMessage(e)));
        const regs = await memoryAdaptersStatus();
        list.replaceChildren(
          ...regs.map((r) =>
            renderAdapterRow(r, labels.get(r.id) ?? r.id, {
              onRegister: (id) => void handleRegister(id),
              onUnregister: (id) => void handleUnregister(id),
            }),
          ),
        );
      } catch (e) {
        showToast(errorMessage(e));
      }
    };
    const handleRegister = async (id: string): Promise<void> => {
      try {
        if (await confirmPreview(id)) {
          const state = await memoryAdapterRegister(id);
          showToast(`${t("settings.memory.shimInstalled")} ${state.shim_path}`);
        }
      } catch (e) {
        showToast(errorMessage(e));
      } finally {
        await refresh();
      }
    };
    const handleUnregister = async (id: string): Promise<void> => {
      try {
        await memoryAdapterUnregister(id);
      } catch (e) {
        showToast(errorMessage(e));
      } finally {
        await refresh();
      }
    };
    void refresh();
    return section(
      t("settings.memory.title"),
      [
        groupLabel(t("settings.memory.group.general")),
        boolField(
          t("settings.memory.enabled"),
          m,
          "enabled",
          save,
          t("settings.memory.enabledDesc"),
        ),
        numField(
          t("settings.memory.overviewMax"),
          m,
          "overview_max_bytes",
          { min: 1024, max: 32768, step: 512 },
          save,
        ),
        boolField(
          t("settings.memory.bootstrapAuto"),
          m,
          "bootstrap_auto",
          save,
          t("settings.memory.bootstrapAutoDesc"),
        ),
        boolField(
          t("settings.memory.autosave"),
          m,
          "autosave",
          save,
          t("settings.memory.autosaveDesc"),
        ),
        numField(
          t("settings.memory.autosaveCooldown"),
          m,
          "autosave_cooldown_min",
          { min: 5, max: 240, step: 5 },
          save,
        ),
        groupLabel(t("settings.memory.group.staleness")),
        numField(
          t("settings.memory.staleDays"),
          m,
          "stale_after_days",
          { min: 1, max: 365, step: 1 },
          save,
        ),
        numField(
          t("settings.memory.staleCommits"),
          m,
          "stale_after_commits",
          { min: 1, max: 1000, step: 1 },
          save,
        ),
        numField(
          t("settings.memory.resumeHours"),
          m,
          "resume_stale_hours",
          { min: 1, max: 720, step: 1 },
          save,
        ),
        groupLabel(t("settings.memory.group.prompts")),
        textField(
          t("settings.memory.resumePrompt"),
          m,
          "resume_prompt",
          save,
          t("ui.memory.prompt.resume"),
          undefined,
          { stack: true },
        ),
        textField(
          t("settings.memory.savePrompt"),
          m,
          "save_prompt",
          save,
          t("ui.memory.prompt.save"),
          undefined,
          { stack: true },
        ),
        textField(
          t("settings.memory.bootstrapPrompt"),
          m,
          "bootstrap_prompt",
          save,
          t("ui.memory.prompt.bootstrap"),
          undefined,
          { stack: true },
        ),
        groupLabel(t("settings.memory.group.templates")),
        textAreaField(
          t("settings.memory.overviewSkeleton"),
          m,
          "overview_skeleton",
          save,
          t("ui.memory.skeleton.overview"),
          undefined,
          { rows: 6 },
        ),
        textAreaField(
          t("settings.memory.decisionsHeader"),
          m,
          "decisions_header",
          save,
          t("ui.memory.skeleton.decisions"),
          undefined,
          { rows: 2 },
        ),
        groupLabel(t("settings.memory.group.clis")),
        server,
        list,
      ],
      t("settings.memory.desc"),
    );
  },
};
