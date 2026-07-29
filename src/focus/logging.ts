import type { FocusConfig, MetricsConfig } from "../config";

export type FocusStatus =
  | "running"
  | "paused"
  | "completed"
  | "skipped"
  | "abandoned"
  | "crashed";

export type InterruptionKind = "internal" | "external" | "system" | "mixed";

export interface FocusSessionStartPayload {
  uuid: string;
  presetId: string | null;
  method: string;
  phase: string;
  plannedDurationS: number;
  startTs: number;
  projectId: string | null;
  shireiSessionId: string | null;
  agentId: string | null;
}

export interface FocusSessionPatch {
  phase?: string;
  status?: FocusStatus;
  pausedDurationS?: number;
  pauseCount?: number;
  interruptionCount?: number;
  interruptionKind?: InterruptionKind | null;
  energyRating?: number | null;
  focusRating?: number | null;
  note?: string | null;
}

export interface FocusSessionEndPayload {
  endTs: number;
  actualDurationS: number;
  status: FocusStatus;
  energyRating?: number;
  focusRating?: number;
  note?: string;
}

export type FocusLogEvent =
  | { cmd: "start"; payload: FocusSessionStartPayload }
  | { cmd: "update"; uuid: string; patch: FocusSessionPatch }
  | { cmd: "end"; uuid: string; end: FocusSessionEndPayload };

export type FocusLogTransition =
  | ({ kind: "start" } & FocusSessionStartPayload)
  | {
      kind: "pause";
      uuid: string;
      pauseCount: number;
      pausedDurationS: number;
    }
  | {
      kind: "interruption";
      uuid: string;
      interruptionCount: number;
      interruptionKind: InterruptionKind;
    }
  | {
      kind: "end";
      uuid: string;
      endTs: number;
      actualDurationS: number;
      status: FocusStatus;
      energyRating?: number;
      focusRating?: number;
      note?: string;
    };

export interface FocusLogConfig {
  metrics: Pick<MetricsConfig, "enabled">;
  focus: Pick<FocusConfig, "session_note">;
}

export function logEventsFor(
  transition: FocusLogTransition,
  cfg: FocusLogConfig,
): FocusLogEvent[] {
  if (!cfg.metrics.enabled) return [];

  switch (transition.kind) {
    case "start":
      return [
        {
          cmd: "start",
          payload: {
            uuid: transition.uuid,
            presetId: transition.presetId,
            method: transition.method,
            phase: transition.phase,
            plannedDurationS: transition.plannedDurationS,
            startTs: transition.startTs,
            projectId: transition.projectId,
            shireiSessionId: transition.shireiSessionId,
            agentId: transition.agentId,
          },
        },
      ];

    case "pause":
      return [
        {
          cmd: "update",
          uuid: transition.uuid,
          patch: {
            pauseCount: transition.pauseCount,
            pausedDurationS: transition.pausedDurationS,
          },
        },
      ];

    case "interruption":
      return [
        {
          cmd: "update",
          uuid: transition.uuid,
          patch: {
            interruptionCount: transition.interruptionCount,
            interruptionKind: transition.interruptionKind,
          },
        },
      ];

    case "end": {
      const end: FocusSessionEndPayload = {
        endTs: transition.endTs,
        actualDurationS: transition.actualDurationS,
        status: transition.status,
      };
      if (transition.energyRating !== undefined) {
        end.energyRating = transition.energyRating;
      }
      if (transition.focusRating !== undefined) {
        end.focusRating = transition.focusRating;
      }
      if (cfg.focus.session_note && transition.note !== undefined) {
        end.note = transition.note;
      }
      return [{ cmd: "end", uuid: transition.uuid, end }];
    }
  }
}
