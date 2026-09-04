import type { AnalysisReplayWindow } from "./analysis-types.ts";

export const REPLAY_PRE_ROLL_MS = 900;
export const REPLAY_POST_ROLL_MS = 850;
export const MIN_PLAYABLE_REPLAY_MS = 120;

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

export function isPlayableReplayWindow(replay: AnalysisReplayWindow | undefined) {
  return Boolean(replay && replay.endMs - replay.startMs >= MIN_PLAYABLE_REPLAY_MS);
}

type ReplayMovement = {
  recordedAt: string;
  replay?: AnalysisReplayWindow;
};

export function normalizeSessionReplayWindows<T extends ReplayMovement>(
  movements: T[],
  recordingDurationMs: number,
  sessionCreatedAt: string,
): T[] {
  const durationMs = Math.max(0, recordingDurationMs);
  if (!durationMs) return movements;

  const sessionCreatedAtMs = Date.parse(sessionCreatedAt);
  const recordingStartedAtMs = Number.isFinite(sessionCreatedAtMs)
    ? sessionCreatedAtMs - durationMs
    : Number.NaN;

  return movements.map((movement, index) => {
    const clamped = movement.replay
      ? clampReplayWindow(movement.replay, durationMs)
      : undefined;
    if (isPlayableReplayWindow(clamped)) return { ...movement, replay: clamped };

    const recordedAtMs = Date.parse(movement.recordedAt);
    const estimatedPeakMs = recordedAtMs - recordingStartedAtMs;
    const fallbackPeakMs = durationMs * ((index + 1) / (movements.length + 1));
    const peakMs = Number.isFinite(estimatedPeakMs)
      && estimatedPeakMs >= 0
      && estimatedPeakMs <= durationMs
      ? estimatedPeakMs
      : fallbackPeakMs;

    let startMs = Math.max(0, peakMs - REPLAY_PRE_ROLL_MS);
    let endMs = Math.min(durationMs, peakMs + REPLAY_POST_ROLL_MS);
    const minimumDurationMs = Math.min(MIN_PLAYABLE_REPLAY_MS, durationMs);
    if (endMs - startMs < minimumDurationMs) {
      startMs = Math.max(0, Math.min(peakMs - minimumDurationMs / 2, durationMs - minimumDurationMs));
      endMs = startMs + minimumDurationMs;
    }

    return {
      ...movement,
      replay: {
        startMs: Math.round(startMs),
        peakMs: Math.round(Math.max(startMs, Math.min(peakMs, endMs))),
        endMs: Math.round(endMs),
      },
    };
  });
}
