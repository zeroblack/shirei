import { getVersion } from "@tauri-apps/api/app";
import { emit, listen } from "@tauri-apps/api/event";
import { t } from "../i18n";
import type { UpdateState } from "../updatestate";
import type { SettingsSection } from "./shell";
import { boolField, field, section } from "./widgets";

// One listener for the whole Settings window lifetime rather than one per
// visit to this section (build() reruns every time the sidebar navigates
// back here). latestState is applied to whichever row is currently mounted,
// and the request event covers a Settings window opened after a check
// already ran elsewhere (main window auto-check, or a prior visit here).
let latestState: UpdateState | null = null;
let subscribed = false;
let mountedRow: {
  statusText: HTMLElement;
  updateBtn: HTMLElement;
  checkBtn: HTMLButtonElement;
} | null = null;

function statusText(state: UpdateState | null): string {
  switch (state?.kind) {
    case "checking":
      return t("ui.update.checking");
    case "available":
      return state.version
        ? t("ui.update.available", { version: state.version })
        : "";
    case "uptodate":
      return t("ui.update.upToDate");
    case "error":
      return t("ui.update.checkFailed");
    default:
      return "";
  }
}

function applyLatestState(): void {
  if (!mountedRow) return;
  const s = latestState;
  mountedRow.statusText.textContent = statusText(s);
  mountedRow.updateBtn.classList.toggle(
    "hidden",
    !(s?.kind === "available" && s.version),
  );
  mountedRow.checkBtn.disabled = s?.kind === "checking";
}

function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  void listen<UpdateState>("shirei://update-state", (e) => {
    latestState = e.payload;
    applyLatestState();
  });
  void emit("shirei://update-state-request");
}

export const updatesSection: SettingsSection = {
  id: "updates",
  label: () => t("settings.updates.label"),
  searchText: () => t("settings.updates.search"),
  build: (config, save) => {
    const versionEl = document.createElement("span");
    versionEl.className = "updates-status-version";
    void getVersion()
      .then((v) => {
        versionEl.textContent = `v${v}`;
      })
      .catch(() => {});

    const statusSpan = document.createElement("span");
    statusSpan.className = "updates-status-text";

    const updateBtn = document.createElement("button");
    updateBtn.type = "button";
    updateBtn.className = "settings-action hidden";
    updateBtn.textContent = t("ui.update.view");
    updateBtn.addEventListener("click", () => {
      void emit("shirei://update-open-modal");
    });

    const statusRow = document.createElement("div");
    statusRow.className = "updates-status";
    statusRow.append(versionEl, statusSpan, updateBtn);

    const checkBtn = document.createElement("button");
    checkBtn.type = "button";
    checkBtn.className = "settings-action";
    checkBtn.textContent = t("settings.updates.checkNow");
    checkBtn.addEventListener("click", () => {
      latestState = { kind: "checking" };
      applyLatestState();
      void emit("menu://check-updates");
    });

    mountedRow = { statusText: statusSpan, updateBtn, checkBtn };
    ensureSubscribed();
    applyLatestState();

    return section(
      t("settings.updates.title"),
      [
        boolField(
          t("settings.updates.autoCheck"),
          config.updates,
          "auto_check",
          save,
          t("settings.updates.autoCheckDesc"),
        ),
        field(t("settings.updates.checkNowLabel"), checkBtn),
        field(t("settings.updates.statusLabel"), statusRow),
      ],
      t("settings.updates.desc"),
    );
  },
};
