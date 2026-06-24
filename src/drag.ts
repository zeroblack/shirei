export interface DragHandlers {
  onMove: (e: MouseEvent) => void;
  onEnd?: () => void;
  cursor?: string;
}

/**
 * Window-level drag wiring with rAF coalescing: `onMove` runs at most once
 * per frame with the latest pointer position, so drag math that reads and
 * writes layout never thrashes mid-drag.
 */
export function attachDrag(handle: HTMLElement, handlers: DragHandlers): void {
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    if (handlers.cursor) document.body.style.cursor = handlers.cursor;
    let pending: MouseEvent | null = null;
    const move = (ev: MouseEvent) => {
      if (pending === null) {
        requestAnimationFrame(() => {
          if (pending) handlers.onMove(pending);
          pending = null;
        });
      }
      pending = ev;
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      pending = null;
      if (handlers.cursor) document.body.style.cursor = "";
      handlers.onEnd?.();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
}
