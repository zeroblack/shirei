import { convertFileSrc } from "@tauri-apps/api/core";
import { mediaKind } from "./icons";
import { basename } from "./path";

export class MediaSession {
  readonly id: string;
  readonly path: string;
  private readonly container: HTMLElement;
  private media: HTMLVideoElement | HTMLAudioElement | null = null;

  constructor(id: string, path: string, container: HTMLElement) {
    this.id = id;
    this.path = path;
    this.container = container;
    this.container.classList.add("media-host");
    // Focusable so focus() actually lands here: an iframe/PDF embed can't hold
    // DOM focus, and without it the focus stays on the file tree, leaving the
    // viewer dimmed as an inactive surface.
    this.container.tabIndex = -1;
  }

  async open(): Promise<void> {
    const name = basename(this.path);
    const kind = mediaKind(name);
    const src = convertFileSrc(this.path);

    if (kind === "pdf") {
      const frame = document.createElement("iframe");
      frame.className = "pdf-view";
      frame.src = src;
      this.container.replaceChildren(frame);
      return;
    }

    const el =
      kind === "audio"
        ? document.createElement("audio")
        : document.createElement("video");
    el.className = "media-view";
    el.controls = true;
    el.src = src;
    this.container.replaceChildren(el);
    this.media = el;
  }

  togglePlay(): void {
    if (!this.media) return;
    if (this.media.paused) void this.media.play();
    else this.media.pause();
  }

  show(visible: boolean): void {
    this.container.classList.toggle("active", visible);
  }

  focus(): void {
    this.container.focus();
  }

  setBg(color: string): void {
    this.container.style.background = color;
  }

  dispose(): void {
    if (this.media) {
      this.media.pause();
      this.media.src = "";
      this.media = null;
    }
    this.container.remove();
  }
}
