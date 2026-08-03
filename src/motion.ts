import type { Config } from "./config";

// Shared by every window that renders overlay/panel transitions (main and
// settings): translates config.motion into the CSS custom properties the
// stylesheets animate on, so a reduced-motion or disabled-motion preference
// zeroes every transition duration at the token source instead of each
// call site checking it independently.
export function applyMotionVars(
  root: HTMLElement,
  motion: Config["motion"],
): void {
  const reduced =
    motion.respect_reduced_motion &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ms = (v: number): string =>
    !motion.enabled || reduced ? "0ms" : `${v}ms`;
  root.style.setProperty("--task-sink", ms(motion.task_sink_ms));
  root.style.setProperty("--modal-in", ms(motion.modal_in_ms));
  root.style.setProperty("--modal-out", ms(motion.modal_out_ms));
  root.style.setProperty("--reveal", ms(motion.reveal_ms));
  root.style.setProperty("--reveal-stagger", ms(motion.reveal_stagger_ms));
  root.style.setProperty("--divider-snap", ms(motion.divider_snap_ms));
  root.style.setProperty("--dur-fast", ms(motion.fast_ms));
  root.style.setProperty("--dur-base", ms(motion.base_ms));
  root.style.setProperty("--dur-slow", ms(motion.slow_ms));
}
