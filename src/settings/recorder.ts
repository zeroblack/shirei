import { eventToKeystroke, type Keystroke } from "../keys";

const MODIFIER_ONLY = new Set(["Shift", "Control", "Alt", "Meta"]);

export function captureKeystroke(e: KeyboardEvent): Keystroke | null {
  e.preventDefault();
  if (MODIFIER_ONLY.has(e.key)) return null;
  return eventToKeystroke(e);
}
