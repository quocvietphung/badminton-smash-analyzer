export type AthleteTargetCandidate = {
  trackId: number;
  lockConfidence: number;
  lockReady: boolean;
};

export function resolveTargetConfirmation<T extends AthleteTargetCandidate>(
  pending: T | null,
  visible: T[],
) {
  const live = pending
    ? visible.find((candidate) => candidate.trackId === pending.trackId) ?? null
    : null;
  return {
    display: live ?? pending,
    visible: live !== null,
    ready: live?.lockReady ?? false,
  };
}
