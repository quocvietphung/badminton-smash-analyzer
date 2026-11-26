// The selected shot of one analysis, shared by every view that shows shots (the speed monitor, the timeline and the
// trajectory panel). It holds an id only; nothing else about a shot is stored here.
import { useSyncExternalStore } from "react";

type Listener = () => void;

const selected = new Map<string, string | null>();
const listeners = new Set<Listener>();

export function getSelectedShotId(jobId: string): string | null {
  return selected.get(jobId) ?? null;
}

export function setSelectedShotId(jobId: string, shotId: string | null): void {
  if (getSelectedShotId(jobId) === shotId) return;
  selected.set(jobId, shotId);
  listeners.forEach((listener) => listener());
}

export function subscribeSelectedShot(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The selected shot id of an analysis, and a setter. Every component that calls it sees the same selection. */
export function useSelectedShotId(jobId: string): [string | null, (shotId: string | null) => void] {
  const value = useSyncExternalStore(
    subscribeSelectedShot,
    () => getSelectedShotId(jobId),
    () => null,
  );
  return [value, (shotId) => setSelectedShotId(jobId, shotId)];
}
