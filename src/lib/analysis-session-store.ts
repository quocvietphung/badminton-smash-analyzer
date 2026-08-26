"use client";

import { useSyncExternalStore } from "react";
import {
  EMPTY_ANALYSIS_SNAPSHOT,
  type AnalysisSnapshot,
} from "@/lib/analysis-types";

let currentSnapshot = EMPTY_ANALYSIS_SNAPSHOT;
const listeners = new Set<() => void>();

export function publishAnalysisSnapshot(snapshot: AnalysisSnapshot) {
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
