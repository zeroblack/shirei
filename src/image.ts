import { convertFileSrc } from "@tauri-apps/api/core";
import { imageMeta } from "./commands";
import { basename } from "./path";

export class ImageSession {
  readonly id: string;
  readonly path: string;
  private readonly container: HTMLElement;

  constructor(id: string, path: string, container: HTMLElement) {
    this.id = id;
    this.path = path;
    this.container = container;
    this.container.classList.add("image-host");
    // Focusable so focus() actually lands here: an <img> can't hold DOM focus,
    // and without it the focus stays on the file tree, leaving the viewer dimmed
    // as an inactive surface.
    this.container.tabIndex = -1;
  }

  async open(): Promise<void> {
    await imageMeta(this.path);
    const img = document.createElement("img");
    img.className = "image-view";
    img.alt = basename(this.path);
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(`cannot load image: ${this.path}`));
      img.src = convertFileSrc(this.path);
    });
    this.container.replaceChildren(img);
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
    this.container.remove();
  }
}
