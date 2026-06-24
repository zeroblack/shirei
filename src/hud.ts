import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { configGet } from "./config";
import { setLocale, t } from "./i18n";

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

window.addEventListener("DOMContentLoaded", () => {
  void configGet()
    .then((c) => {
      setLocale(c.locale);
      document.title = t("ui.screencast.recordingTitle");
    })
    .catch(() => {});

  const time = document.querySelector<HTMLElement>("#time");

  void listen<number>("screencast://tick", (e) => {
    if (time) time.textContent = formatElapsed(e.payload);
  });

  let stopping = false;
  document.body.addEventListener("click", async () => {
    if (stopping) return;
    stopping = true;
    try {
      await invoke("screencast_stop");
    } finally {
      await getCurrentWindow().close();
    }
  });
});
