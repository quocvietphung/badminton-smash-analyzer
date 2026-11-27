// Explains the automatic court calibration of one analysis: which step stopped it, how the fit compared with its
// thresholds, and what a person can do. Display only: the numbers are copied from results.json, never recomputed.
// The thresholds mirror backend/app/ai/court_detection/court.py (MIN_SCORE, MIN_COVERAGE, MIN_OUTLINE); a test reads
// that file and fails when they drift apart.

export const COURT_THRESHOLDS = { score: 0.55, coverage: 0.5, outline: 0.45 } as const;

/** The step of the automatic calibration that decided the result. */
export type CourtStage =
  | "calibrated"
  | "manual"
  | "no_frames"
  | "no_floor"
  | "no_lines"
  | "no_quad"
  | "below_threshold"
  | "unknown";

/** The backend's failure reasons, in pipeline order. */
export const COURT_REASONS: Record<Exclude<CourtStage, "calibrated" | "manual" | "unknown">, string[]> = {
  no_frames: ["no full-resolution frames were available for calibration"],
  no_floor: ["no dominant floor region was found"],
  no_lines: ["no white court lines were found on the floor", "not enough horizontal and vertical white court lines were visible"],
  no_quad: ["no plausible court quadrilateral was found"],
  below_threshold: ["the best court fit did not reach the score and coverage thresholds"],
};

export type CourtCheck = { id: "score" | "coverage"; value: number | null; threshold: number; passed: boolean | null };

export type CourtExplanation = {
  stage: CourtStage;
  calibrated: boolean;
  source: "auto" | "manual" | null;
  /** Fit score and outline coverage against their thresholds. A step that stopped before the fit has no values. */
  checks: CourtCheck[];
  reason: string;
};

export type CourtBlock = {
  status: string;
  reason?: string | null;
  source?: string | null;
  score?: number | null;
  coverage?: number | null;
};

function stageOf(court: CourtBlock): CourtStage {
  if (court.status === "calibrated") return court.source === "manual" ? "manual" : "calibrated";
  const reason = (court.reason ?? "").trim().toLowerCase();
  for (const [stage, reasons] of Object.entries(COURT_REASONS) as Array<[CourtStage, string[]]>) {
    if (reasons.some((text) => reason.startsWith(text))) return stage;
  }
  return "unknown";
}

export function explainCourt(court: CourtBlock | null | undefined): CourtExplanation {
  if (!court) return { stage: "unknown", calibrated: false, source: null, checks: [], reason: "" };
  const stage = stageOf(court);
  const source = court.source === "manual" ? "manual" : court.source === "auto" ? "auto" : null;
  // Before a fit exists (no floor, no lines, no outline) the backend stores 0.0: that is "not reached", not a score.
  const fitted = stage === "calibrated" || stage === "below_threshold";
  const value = (raw: number | null | undefined) => (fitted && typeof raw === "number" ? raw : null);
  const check = (id: CourtCheck["id"], raw: number | null | undefined, threshold: number): CourtCheck => {
    const measured = value(raw);
    return { id, value: measured, threshold, passed: measured === null ? null : measured >= threshold };
  };
  const checks = stage === "manual" ? [] : [
    check("score", court.score, COURT_THRESHOLDS.score),
    check("coverage", court.coverage, COURT_THRESHOLDS.coverage),
  ];
  return { stage, calibrated: court.status === "calibrated", source, checks, reason: court.reason ?? "" };
}
