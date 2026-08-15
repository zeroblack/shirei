import {
  type MemoryRegistration,
  memoryAdapterPreview,
  memoryAdapterRegister,
  memoryAdaptersStatus,
  memoryAdapterUnregister,
} from "../config";
import { confirmDialog } from "../confirm";
import { errorMessage } from "../errors";
import { type MessageKey, t } from "../i18n";
import { showToast } from "../toast";
import type { SettingsSection } from "./shell";
import { boolField, groupLabel, numField, section, textField } from "./widgets";

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

  const name = document.createElement("span");
  name.className = "memory-adapter-name";
  name.textContent = label;

  const detected = document.createElement("span");
  detected.className = "memory-adapter-detected";
  detected.textContent = reg.detected
    ? t("settings.memory.detected")
    : t("settings.memory.notDetected");

  const state = document.createElement("span");
  state.className = "memory-adapter-state";
  state.dataset.state = reg.state;
  state.textContent = t(`settings.memory.state.${reg.state}` as MessageKey);

  const path = document.createElement("code");
  path.className = "memory-adapter-path";
  path.textContent = reg.config_path;
  path.title = reg.config_path;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "memory-adapter-action";
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
  row.append(name, detected, state, path, btn);
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
    const labels = new Map(m.cli_adapters.map((a) => [a.id, a.display_name]));
    const refresh = async () => {
      try {
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
          await memoryAdapterRegister(id);
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
          "",
        ),
        textField(t("settings.memory.savePrompt"), m, "save_prompt", save, ""),
        groupLabel(t("settings.memory.group.clis")),
        list,
      ],
      t("settings.memory.desc"),
    );
  },
};
