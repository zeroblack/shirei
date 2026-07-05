import { alpha } from "./colors";
import { configGet } from "./config";

void configGet()
  .then((c) => {
    const root = document.documentElement.style;
    root.setProperty("--rec", c.recorder.highlight_color);
    root.setProperty("--rec-soft", alpha(c.recorder.highlight_color, 0.55));
    root.setProperty("--rec-dim", alpha(c.recorder.highlight_color, 0.16));
  })
  .catch(() => {});
