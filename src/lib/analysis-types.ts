import type {
  MotionAssessment,
  TrainingDrill,
  TrainingModule,
} from "./motion-technique";
import type { PreferredHand } from "./pose-metrics";

export type AnalysisSource = "none" | "demo" | "live" | "history";

export type AnalysisReplayWindow = {
  startMs: number;
  peakMs: number;
  endMs: number;
};

export type AnalysisMovement = MotionAssessment & {
  index: number;
  recordedAt: string;
  replay?: AnalysisReplayWindow;
};

export type AnalysisSummary = {
  headline: string;
  insight: string;
  averageScore: number;
  consistency: number;
  strongestPhase: string;
  priority: string;
};

export type AnalysisSnapshot = {
  source: AnalysisSource;
  capturedAt: string;
  trainingModule: TrainingModule;
  drillMode: TrainingDrill;
  preferredHand: PreferredHand;
  movements: AnalysisMovement[];
  summary: AnalysisSummary | null;
};

export const EMPTY_ANALYSIS_SNAPSHOT: AnalysisSnapshot = {
  source: "none",
  capturedAt: "",
  trainingModule: "stroke",
  drillMode: "open",
  preferredHand: "auto",
  movements: [],
  summary: null,
};
