// A remaining-time estimate that uses only this run's own measured progress. It is shown as an estimate, and it
// stays hidden until enough progress and elapsed time have been measured, so no figure is invented.

export const MIN_ESTIMATE_PROGRESS = 0.1;
export const MIN_ESTIMATE_ELAPSED_S = 20;

/** Seconds remaining at the rate measured so far, or null when the measurement is not yet meaningful. */
export function measuredRemainingSeconds(progress: number, elapsedS: number): number | null {
  if (!Number.isFinite(progress) || !Number.isFinite(elapsedS)) return null;
  if (progress < MIN_ESTIMATE_PROGRESS || progress >= 1 || elapsedS < MIN_ESTIMATE_ELAPSED_S) return null;
  return Math.round((elapsedS * (1 - progress)) / progress);
}
