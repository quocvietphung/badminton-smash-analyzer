"use client";

import { useSyncExternalStore } from "react";
import {
  EMPTY_VIDEO_ANALYSIS_SNAPSHOT,
  type VideoAnalysisSnapshot,
} from "@/lib/video-analysis";

// The AI Coach reads the last video analysis that was completed or opened in the studio.
let currentSnapshot: VideoAnalysisSnapshot = EMPTY_VIDEO_ANALYSIS_SNAPSHOT;
const listeners = new Set<() => void>();

export function publishAnalysisSnapshot(snapshot: VideoAnalysisSnapshot) {
  currentSnapshot = snapshot;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return currentSnapshot;
}

export function useAnalysisSnapshot() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
