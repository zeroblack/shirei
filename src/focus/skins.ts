export type TimerRole = "focus" | "break" | "overflow" | "track" | "field";

interface OklchRamp {
  l: number;
  c: number;
  h: number;
}

export interface TimerSkin {
  id: string;
  label: string;
  roles: Record<TimerRole, OklchRamp>;
}

export const DEFAULT_SKIN_ID = "sumi";

export const SKINS: TimerSkin[] = [
  {
    id: "sumi",
    label: "Sumi",
    roles: {
      focus: { l: 0.92, c: 0.01, h: 0 },
      break: { l: 0.72, c: 0.06, h: 150 },
      overflow: { l: 0.75, c: 0.14, h: 70 },
      track: { l: 0.4, c: 0.01, h: 0 },
      field: { l: 0.34, c: 0.02, h: 40 },
    },
  },
  {
    id: "hinode",
    label: "Hinode",
    roles: {
      focus: { l: 0.85, c: 0.03, h: 60 },
      break: { l: 0.75, c: 0.06, h: 30 },
      overflow: { l: 0.72, c: 0.13, h: 45 },
      track: { l: 0.42, c: 0.02, h: 50 },
      field: { l: 0.36, c: 0.04, h: 30 },
    },
  },
  {
    id: "shinya",
    label: "Shinya",
    roles: {
      focus: { l: 0.8, c: 0.15, h: 200 },
      break: { l: 0.72, c: 0.19, h: 320 },
      overflow: { l: 0.7, c: 0.22, h: 25 },
      track: { l: 0.4, c: 0.05, h: 280 },
      field: { l: 0.32, c: 0.08, h: 310 },
    },
  },
  {
    id: "kasumi",
    label: "Kasumi",
    roles: {
      focus: { l: 0.92, c: 0, h: 0 },
      break: { l: 0.6, c: 0, h: 0 },
      overflow: { l: 0.78, c: 0, h: 0 },
      track: { l: 0.4, c: 0, h: 0 },
      field: { l: 0.3, c: 0, h: 0 },
    },
  },
  {
    id: "mori",
    label: "Mori",
    roles: {
      focus: { l: 0.78, c: 0.09, h: 145 },
      break: { l: 0.7, c: 0.08, h: 45 },
      overflow: { l: 0.72, c: 0.13, h: 60 },
      track: { l: 0.38, c: 0.02, h: 140 },
      field: { l: 0.3, c: 0.02, h: 50 },
    },
  },
  {
    id: "signal",
    label: "Signal",
    roles: {
      focus: { l: 0.7, c: 0.06, h: 235 },
      break: { l: 0.78, c: 0.14, h: 155 },
      overflow: { l: 0.82, c: 0.14, h: 84 },
      track: { l: 0.4, c: 0.02, h: 235 },
      field: { l: 0.34, c: 0.04, h: 200 },
    },
  },
];
