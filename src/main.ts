import "./fonts.css";
import "@xterm/xterm/css/xterm.css";
import "./tokens.css";
import "./craft.css";
import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { error as logError } from "@tauri-apps/plugin-log";
import { App } from "./app";
import { configGet, onConfigChanged } from "./config";
import { registerInstalledFonts } from "./fonts";
import { setLocale } from "./i18n";

// WebGL context-loss surfaces as a noisy console error during the renderer's own
// recovery; it is handled in terminal.ts, so keep it out of the crash log.
const RENDER_NOISE = /context_lost|webgl/i;

window.addEventListener("error", (e) => {
  if (RENDER_NOISE.test(e.message)) return;
  void logError(
    `uncaught: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}\n${e.error?.stack ?? ""}`,
  ).catch(() => {});
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  const msg =
    r instanceof Error
      ? `${r.name}: ${r.message}\n${r.stack ?? ""}`
      : String(r);
  void logError(`unhandled rejection: ${msg}`).catch(() => {});
});

window.addEventListener("DOMContentLoaded", async () => {
  const tabbar = document.querySelector<HTMLElement>("#tabbar");
  const host = document.querySelector<HTMLElement>("#terminals");
  if (!tabbar || !host) return;
  const config = await configGet();
  setLocale(config.locale);
  await registerInstalledFonts(config.fonts).catch(() => {});
  const app = new App(tabbar, host, config);
  await onConfigChanged((c) => app.applyConfig(c));
  await app.bindMenu();
  void app.init();
  const title = document.querySelector<HTMLElement>("#app-title");
  if (title)
    title.addEventListener(
      "click",
      () => void invoke("show_settings", { section: "about" }),
    );
});
