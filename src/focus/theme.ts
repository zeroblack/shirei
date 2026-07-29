import {
  alpha,
  deriveRoleColor,
  deriveStatusColors,
  mix,
  STATUS_MIN_LC,
} from "../colors";
import type { FocusConfig } from "../config";
import {
  DEFAULT_SKIN_ID,
  SKINS,
  type TimerRole,
  type TimerSkin,
} from "./skins";

const ROLES: readonly TimerRole[] = [
  "focus",
  "break",
  "overflow",
  "track",
  "field",
];

// Track/field are graphic (non-text) elements sitting behind the ring's
// numeric readout, not legible copy — 15 mirrors APCA's own floor for
// large-scale, thick, non-text UI, well below the 42 the status badges (real
// text labels) need.
const TIMER_MIN_LC = 15;

function findSkin(skinId: string): TimerSkin | undefined {
  return SKINS.find((skin) => skin.id === skinId);
}

const foundSignalSkin = SKINS.find((skin) => skin.id === "signal");
if (!foundSignalSkin)
  throw new Error("focus/skins.ts must define the signal skin");
const SIGNAL_SKIN: TimerSkin = foundSignalSkin;

function isDark(hex: string): boolean {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

function deriveFromRamp(
  bg: string,
  skin: TimerSkin,
): Record<TimerRole, string> {
  const out = {} as Record<TimerRole, string>;
  for (const role of ROLES)
    out[role] = deriveRoleColor(skin.roles[role], bg, TIMER_MIN_LC);
  return out;
}

// Signal is the one skin that reuses the app's own status ramp verbatim
// instead of a curated ramp of its own, so focus/break go through
// deriveStatusColors directly (bit-identical to the agent-status dots) and
// overflow mirrors --attn via the same status floor.
function deriveSignal(bg: string, skin: TimerSkin): Record<TimerRole, string> {
  const status = deriveStatusColors(bg);
  return {
    focus: status["--status-working"],
    break: status["--status-done"],
    overflow: deriveRoleColor(skin.roles.overflow, bg, STATUS_MIN_LC),
    track: deriveRoleColor(skin.roles.track, bg, TIMER_MIN_LC),
    field: deriveRoleColor(skin.roles.field, bg, TIMER_MIN_LC),
  };
}

// "derive" has no curated ramp of its own: it borrows the same status/attn
// anchors Signal curates (the app's one semantic palette) for the readable
// roles, and washes track/field as a translucent overlay on `bg` instead of a
// fixed hue, so it actually tracks whichever terminal theme is active.
function derivePalette(bg: string): Record<TimerRole, string> {
  const status = deriveStatusColors(bg);
  const overlay = isDark(bg) ? "#ffffff" : "#000000";
  return {
    focus: status["--status-working"],
    break: status["--status-done"],
    overflow: deriveRoleColor(SIGNAL_SKIN.roles.overflow, bg, STATUS_MIN_LC),
    track: alpha(overlay, 0.14),
    field: alpha(overlay, 0.06),
  };
}

export function deriveTimerColors(
  bg: string,
  skinId: string,
  overrides: Record<string, string>,
): Record<TimerRole, string> {
  const base =
    skinId === "derive"
      ? derivePalette(bg)
      : (() => {
          const skin = findSkin(skinId) ?? findSkin(DEFAULT_SKIN_ID);
          if (!skin)
            throw new Error("focus/skins.ts must define the default skin");
          return skin.id === "signal"
            ? deriveSignal(bg, skin)
            : deriveFromRamp(bg, skin);
        })();

  const out = { ...base };
  for (const role of ROLES) {
    // Object.hasOwn needs lib ES2022; tsconfig targets ES2020, so this stays desugared.
    // biome-ignore lint/suspicious/noPrototypeBuiltins: desugared Object.hasOwn, see above
    if (Object.prototype.hasOwnProperty.call(overrides, role)) {
      out[role] = overrides[role];
    }
  }
  return out;
}

// A full-area fill of an accent hue reads far louder than the ring's thin
// stroke of that same hue — on a filled shape (liquid/coffee) the role color
// covers most of the cell instead of a few pixels of arc. Mixing it toward
// the timer's own track tone (already the dimmest role in every skin, see
// skins.ts) and pulling the alpha back keeps every skin calm at full fill and
// leaves --text real headroom on top of it, without inventing a new color:
// both endpoints of the mix are role vars the skin already derived.
const FILL_TRACK_MIX = 0.55;
const FILL_ALPHA = 0.82;

export function fillColorFor(role: string, track: string): string {
  return alpha(mix(role, track, FILL_TRACK_MIX), FILL_ALPHA);
}

function motionScalar(motion: string): number {
  if (motion === "off") return 0;
  const reduced =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) return 0;
  return motion === "lively" ? 1.4 : 1;
}

export function applyTimerTheme(
  root: HTMLElement,
  colors: Record<TimerRole, string>,
  cfg: Pick<FocusConfig, "ring_width" | "glow_intensity" | "motion">,
): void {
  root.style.setProperty("--timer-focus", colors.focus);
  root.style.setProperty("--timer-break", colors.break);
  root.style.setProperty("--timer-overflow", colors.overflow);
  root.style.setProperty("--timer-track", colors.track);
  root.style.setProperty("--timer-field", colors.field);
  root.style.setProperty(
    "--timer-fill-focus",
    fillColorFor(colors.focus, colors.track),
  );
  root.style.setProperty(
    "--timer-fill-break",
    fillColorFor(colors.break, colors.track),
  );
  root.style.setProperty(
    "--timer-fill-overflow",
    fillColorFor(colors.overflow, colors.track),
  );
  root.style.setProperty("--timer-ring-w", `${cfg.ring_width}px`);
  root.style.setProperty("--timer-glow", `${cfg.glow_intensity}`);
  root.style.setProperty("--timer-motion", `${motionScalar(cfg.motion)}`);
}
