import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { contentBounds, normalizeUrl } from "./browser-core";
import {
  browserBack,
  browserClose,
  browserFocus,
  browserForward,
  browserHide,
  browserNavigate,
  browserOpen,
  browserReload,
  browserSetBounds,
  browserSetColorScheme,
  browserShow,
  browserUrl,
} from "./commands";
import { t } from "./i18n";
import { BROWSER_GLYPH, CLOSE, NAV_BACK, NAV_FORWARD, RELOAD } from "./icons";

// Expanded height of the chrome bar; collapsed is a thin strip that stays
// real DOM (unlike the video below it, which is a native view mouse events
// never reach), so hovering it is the only way to reveal the bar again once
// the mouse has left it.
export const CHROME_H_EXPANDED = 34;
const CHROME_H_COLLAPSED = 6;

interface Navigated {
  label: string;
  url: string;
  title: string;
}

export class BrowserSession {
  readonly id: string;
  readonly label: string;
  path: string;
  onTitle?: (title: string) => void;
  onCloseRequest?: () => void;
  private readonly container: HTMLElement;
  private readonly chrome: HTMLElement;
  private readonly urlInput: HTMLInputElement;
  private opened = false;
  private observer: ResizeObserver | null = null;
  private unlisten: UnlistenFn | null = null;
  private collapsed = false;
  private hideTimer: number | null = null;
  private autoHideEnabled = true;
  private autoHideDelayMs = 2000;

  constructor(id: string, url: string, container: HTMLElement) {
    this.id = id;
    this.label = `browser-${getCurrentWindow().label}-${crypto.randomUUID().slice(0, 8)}`;
    this.path = url;
    this.container = container;
    this.container.classList.add("browser-host");
    this.container.tabIndex = -1;

    this.chrome = document.createElement("div");
    this.chrome.className = "browser-chrome";
    const back = this.button(NAV_BACK, t("ui.browser.back"), () => {
      this.returnFocus();
      void browserBack(this.label);
    });
    const forward = this.button(NAV_FORWARD, t("ui.browser.forward"), () => {
      this.returnFocus();
      void browserForward(this.label);
    });
    const reload = this.button(RELOAD, t("ui.browser.reload"), () => {
      this.returnFocus();
      void browserReload(this.label);
    });
    const urlField = document.createElement("div");
    urlField.className = "browser-url-field";
    const urlIcon = document.createElement("span");
    urlIcon.className = "browser-url-icon";
    urlIcon.innerHTML = BROWSER_GLYPH;
    this.urlInput = document.createElement("input");
    this.urlInput.className = "browser-url";
    this.urlInput.placeholder = t("ui.browser.urlPlaceholder");
    this.urlInput.value = url;
    this.urlInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      this.navigate(this.urlInput.value);
      this.returnFocus();
    });
    this.urlInput.addEventListener("focus", () => this.expand());
    this.urlInput.addEventListener("blur", () => this.scheduleHide());
    urlField.append(urlIcon, this.urlInput);
    const close = this.button(CLOSE, t("ui.browser.close"), () => {
      this.onCloseRequest?.();
    });
    close.classList.add("browser-btn-close");
    this.chrome.append(back, forward, reload, urlField, close);
    this.chrome.addEventListener("mouseenter", () => this.expand());
    this.container.appendChild(this.chrome);
  }

  private button(
    glyph: string,
    label: string,
    run: () => void,
  ): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "browser-btn";
    b.innerHTML = glyph;
    b.title = label;
    b.setAttribute("aria-label", label);
    b.tabIndex = -1;
    b.addEventListener("click", run);
    return b;
  }

  // The chrome bar is the focus escape hatch: while the native child webview
  // holds first responder, no DOM shortcut reaches the main webview. Every
  // chrome control returns focus here so ⌘L / tab-switch / ⌘W work again.
  private returnFocus(): void {
    this.container.focus();
    this.scheduleHide();
  }

  configureAutoHide(enabled: boolean, delayMs: number): void {
    this.autoHideEnabled = enabled;
    this.autoHideDelayMs = delayMs;
    if (enabled) this.scheduleHide();
    else this.expand();
  }

  private expand(): void {
    if (this.hideTimer !== null) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    if (this.collapsed) {
      this.collapsed = false;
      this.chrome.classList.remove("collapsed");
      this.syncBounds();
    }
    this.scheduleHide();
  }

  // Idle-based stand-in for "hide while media plays": the native page gives
  // us no signal for actual playback state, so the bar hides after a quiet
  // period instead, exactly like a fullscreen video player's own chrome.
  private scheduleHide(): void {
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
    this.hideTimer = null;
    if (!this.autoHideEnabled) return;
    if (document.activeElement === this.urlInput) return;
    this.hideTimer = window.setTimeout(() => {
      this.hideTimer = null;
      this.collapsed = true;
      this.chrome.classList.add("collapsed");
      this.syncBounds();
    }, this.autoHideDelayMs);
  }

  async open(): Promise<void> {
    const url = normalizeUrl(this.path) ?? "https://www.youtube.com/";
    this.path = url;
    this.urlInput.value = url;
    const b = this.bounds();
    await browserOpen(this.label, url, b.x, b.y, b.width, b.height);
    this.opened = true;
    this.observer = new ResizeObserver(() => this.syncBounds());
    this.observer.observe(this.container);
    this.unlisten = await listen<Navigated>("browser://navigated", (e) => {
      if (e.payload.label !== this.label) return;
      if (e.payload.url && document.activeElement !== this.urlInput) {
        this.path = e.payload.url;
        this.urlInput.value = e.payload.url;
      }
      if (e.payload.title) this.onTitle?.(e.payload.title);
    });
    this.scheduleHide();
  }

  private bounds() {
    const h = this.collapsed ? CHROME_H_COLLAPSED : CHROME_H_EXPANDED;
    return contentBounds(this.container.getBoundingClientRect(), h);
  }

  syncBounds(): void {
    if (!this.opened) return;
    const b = this.bounds();
    void browserSetBounds(this.label, b.x, b.y, b.width, b.height);
  }

  setColorScheme(scheme: "dark" | "light"): void {
    void browserSetColorScheme(this.label, scheme);
  }

  show(visible: boolean): void {
    this.container.classList.toggle("active", visible);
    if (!this.opened) return;
    if (visible) {
      this.syncBounds();
      void browserShow(this.label);
      // SPA navigations (e.g. YouTube) fire neither on_navigation nor
      // on_page_load, so the url bar can only resync by asking on promote.
      void browserUrl(this.label).then((u) => {
        if (u && document.activeElement !== this.urlInput) {
          this.path = u;
          this.urlInput.value = u;
        }
      });
    } else {
      void browserHide(this.label);
    }
  }

  focus(): void {
    this.expand();
    this.urlInput.focus();
  }

  // The keyboard path INTO the native page; the chrome bar is the path back.
  focusPage(): void {
    void browserFocus(this.label);
  }

  navigate(input: string): void {
    const url = normalizeUrl(input);
    if (!url) return;
    this.path = url;
    this.urlInput.value = url;
    void browserNavigate(this.label, url);
  }

  dispose(): void {
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
    this.observer?.disconnect();
    this.unlisten?.();
    if (this.opened) void browserClose(this.label);
    this.container.remove();
  }
}
