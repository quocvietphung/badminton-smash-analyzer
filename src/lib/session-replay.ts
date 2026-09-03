import type { AnalysisReplayWindow } from "./analysis-types.ts";

export const REPLAY_PRE_ROLL_MS = 900;
export const REPLAY_POST_ROLL_MS = 850;

type ReplayCandidate = {
  startedAt: number;
  peakAt: number;
};

export function createReplayWindow(
  candidate: ReplayCandidate,
  endedAt: number,
  recordingStartedAt: number | null,
): AnalysisReplayWindow | undefined {
  if (recordingStartedAt === null) return undefined;
  return {
    startMs: Math.max(0, Math.round(candidate.startedAt - recordingStartedAt - REPLAY_PRE_ROLL_MS)),
    peakMs: Math.max(0, Math.round(candidate.peakAt - recordingStartedAt)),
    endMs: Math.max(0, Math.round(endedAt - recordingStartedAt + REPLAY_POST_ROLL_MS)),
  };
}

export function clampReplayWindow(
  replay: AnalysisReplayWindow,
  recordingDurationMs: number,
): AnalysisReplayWindow {
  const durationMs = Math.max(0, recordingDurationMs);
  const startMs = Math.min(Math.max(0, replay.startMs), durationMs);
  const endMs = Math.max(startMs, Math.min(replay.endMs, durationMs));
  return {
    startMs,
    peakMs: Math.max(startMs, Math.min(replay.peakMs, endMs)),
    endMs,
  };
}
