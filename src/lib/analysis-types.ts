export type AnalysisSource = "none" | "demo" | "live" | "history";
export type AnalysisPlayer = "A" | "B";
export type AnalysisCertainty = "likely" | "possible" | "unknown";

export type AnalysisStroke = {
  index: number;
  hitter: AnalysisPlayer;
  strokeType: "smash" | "drop_shot" | "clear" | "drive" | "overhead_control" | "unknown";
  label: string;
  evidence: number;
  certainty: AnalysisCertainty;
  swingIntensity: number;
  postureScore: number;
  reason: string;
  family?: "overhead_attack" | "overhead_control" | "lateral" | "unknown";
  position?: { x: number; y: number };
};

export type AnalysisSummary = {
  headline: string;
  insight: string;
  averageEvidence: number;
};

export type AnalysisSnapshot = {
  source: AnalysisSource;
  capturedAt: string;
  calibrated: boolean;
  strokes: AnalysisStroke[];
  movement: Record<AnalysisPlayer, number>;
  summary: AnalysisSummary | null;
};

export const EMPTY_ANALYSIS_SNAPSHOT: AnalysisSnapshot = {
  source: "none",
  capturedAt: "",
  calibrated: false,
  strokes: [],
  movement: { A: 0, B: 0 },
  summary: null,
};
