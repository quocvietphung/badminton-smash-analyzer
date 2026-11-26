// The match document served by GET /api/v1/analyses/{id}/match (schema smashlab.match/v1).
// Every value is derived on the backend from saved analysis outputs and the shared observed-2d track; nothing here is
// invented or recomputed in the browser.

export type ContactStatus = "candidate" | "confirmed" | "rejected";

/** Where a point of the sanitized track comes from: a TrackNet detection, or an InpaintNet fill. */
export type PointSource = "detected" | "interpolated";

/**
 * One row of the per-shot trajectory dataset (schema smashlab.shot-trajectory/v2, Observed 2D only). An automatic
 * estimate, never a label. Records written by older rule versions lack the v2 fields, so those are optional here.
 */
export type TrajectoryEstimate = {
  schema?: string;
  shot_id: string;
  /** The Shot timeline row this record belongs to ("s3"). */
  timeline_id?: string | null;
  job_id: string;
  run_id: string;
  frame: number;
  timestamp_s: number;
  player: string | null;
  contact_status: ContactStatus;
  best_guess_label: string;
  /** The label the timeline shows: a person's six-class label, else the estimate. */
  label?: string;
  label_source?: "manual" | "trajectory_estimate";
  review_status: "accepted_by_gate" | "needs_review";
  evidence_tier: "full_trajectory" | "partial_trajectory" | "contact_fallback";
  evidence_quality: "high" | "medium" | "low";
  rule_version: string;
  observed_2d_version?: string;
  frame_size: [number, number];
  label_kind: "trajectory_estimate_unverified";
  manual_label: string | null;
  /** A person's note outside the six classes ("unknown" or a legacy label). Never a stroke type. */
  person_label_note?: string | null;
  contact_image: { x_px: number | null; y_px: number | null; x_normalized: number | null; y_normalized: number | null; coordinate_space?: string };
  player_court_context: {
    court_calibrated: boolean;
    player_side: "near" | "far" | null;
    player_foot_x_m: number | null;
    player_foot_y_m: number | null;
    distance_to_net_m: number | null;
    relative_to_net: "front_court" | "mid_court" | "back_court" | null;
  };
  trajectory_before: TrajectoryPoint[];
  trajectory_after: TrajectoryPoint[];
  /** Points the observed-2d sanitizer rejected inside the record window, with the reason. */
  rejected_points?: RejectedPoint[];
  /** Checks to make on the video, computed on the backend from the sanitized track. */
  tracking_checks?: TrackingCheck[];
  window?: TrajectoryWindow;
  /** Image-space speed around the contact (px/s): the same value the Shot timeline row shows. */
  image_speed?: ShotSpeed;
  detected_ratio?: number | null;
  interpolated_ratio?: number | null;
  features: Record<string, number | string | boolean | null>;
  scores: Record<string, number>;
  top3: [string, number][];
  margin?: number;
  missing_features: string[];
  review_reasons: string[];
  quality_warnings: string[];
  offset_labels: Record<string, string>;
};

export type TrajectoryPoint = {
  frame: number;
  time_s: number;
  x_px: number;
  y_px: number;
  confidence: number;
  interpolated: boolean;
  source?: PointSource;
  segment?: number;
};

export type RejectionReason = "missing_coordinates" | "outside_frame" | "low_confidence" | "tracker_jump";

export type RejectedPoint = {
  frame: number;
  time_s: number | null;
  x_px: number | null;
  y_px: number | null;
  confidence: number;
  source: PointSource;
  reason: RejectionReason;
  detail?: Record<string, unknown>;
};

export type TrackingCheck =
  | { kind: "constant_x" | "constant_y"; from: number; to: number; length: number; value: number; other_range_px: number; detected: number; interpolated: number }
  | { kind: "repeated_detection" | "repeated_interpolation" | "repeated_mixed"; from: number; to: number; x: number; y: number; detected: number; interpolated: number }
  | { kind: "tracker_jump_removed"; from: number; to: number; length: number; from_frame: number | null; return_frame: number | null; entry_step_px: number | null; limit_px_s: number | null; detected: number; interpolated: number }
  | { kind: "implausible_step"; from: number; to: number; distance_px: number; speed_px_s: number; limit_px_s: number };

export type TrajectoryWindow = {
  first_frame: number;
  last_frame: number;
  before: { expected: number; kept: number };
  after: { expected: number; kept: number; truncated_reason: "video_end" | "tracking" | null };
  detected: number;
  interpolated: number;
  rejected: Record<string, number>;
  invalid_steps: number;
};

export type ContactEvidence = {
  turn_deg: number;
  step_before_px: number;
  step_after_px: number;
  distance_to_player_px: number;
  shuttle_confidence: number;
  identity_status: string | null;
  interpolated_neighbours: number;
};

export type MatchContact = {
  id: string;
  frame: number;
  time_s: number;
  player: string | null;
  track_id: number | null;
  status: ContactStatus;
  source: "heuristic" | "manual";
  validated: boolean;
  evidence: ContactEvidence | null;
  review_id?: string;
};

export type MatchShot = {
  id: string;
  contact_id: string;
  rally_id: string | null;
  frame: number;
  time_s: number;
  player: string | null;
  type: string;
  confidence: number | null;
  evidence_source: string;
  contact_status: ContactStatus;
  model_version: string | null;
  validation: "unclassified" | "manual" | "trajectory_unverified";
  type_source: "manual" | "trajectory_estimate" | "none";
  type_reason: string | null;
  classifier?: { top3: [string, number][]; review_status: string } | null;
  /** The trajectory estimate beside this contact, kept apart from a person's label. */
  trajectory?: {
    best_guess_label: string;
    evidence_tier: string;
    evidence_quality: string;
    review_status: string;
    shot_id: string;
    rule_version?: string | null;
    top3?: [string, number][] | null;
    label_kind?: "trajectory_estimate_unverified";
  } | null;
  /** The dataset record id of this row ("<job>-frame-<n>"). */
  shot_id?: string;
  /** A person's note outside the six classes ("unknown" or a legacy label). The row keeps its six-class estimate. */
  person_label_note?: string | null;
  hit_frame?: number | null;
  flags: string[];
  speed: ShotSpeed | null;
  estimated_3d: Estimated3D;
  measured_3d: Measured3D;
};

export type MatchRally = {
  id: string;
  index: number;
  start_frame: number;
  end_frame: number;
  start_s: number;
  end_s: number;
  duration_s: number;
  status: "candidate" | "uncertain" | "confirmed";
  source: "contact_sequence" | "shuttle_runs" | "manual";
  validated: boolean;
  contact_ids?: string[];
  evidence?: { reason: string; contacts: number | null; max_gap_s?: number | null; shuttle_coverage: number | null; players: Record<string, number> };
  contacts: number;
  hits_by_player: Record<string, number>;
  shot_ids: string[];
  winner: string | null;
  winner_status: string;
};

/** [frame, court x in metres or null, court y in metres or null, identity status]. */
export type PositionPoint = [number, number | null, number | null, string | null];

export type SpeedCondition = { id: string; checked: string; detail: string };

/** Image-space speed near a contact (px/s) from the shared observed-2d track. Not a physical speed; kmh is always null. */
export type ShotSpeed = {
  kmh: number | null;
  px_per_s: number | null;
  kind: string | null;
  unit?: "px/s";
  reason?: string | null;
  points?: number;
  steps?: number;
  frames?: number[];
  method?: string;
  physical_speed_available?: false;
  basis?: "confirmed_contact" | "automatic_candidate";
};

/** Estimated 3D — monocular experimental. A speed is present only when every gate passed (status "available"). */
export type Estimated3D = {
  schema?: string;
  mode: "estimated_monocular";
  status: "available" | "rejected" | "not_computed";
  label: string;
  trajectory_xyz_m?: Array<{ time_s: number; x: number; y: number; z: number }>;
  speed_candidate_kmh: number | null;
  speed_range_kmh: [number, number] | null;
  reprojection_rms_px?: number | null;
  reprojection_p95_px?: number | null;
  parameter_spread_percent?: number | null;
  quality?: "low" | "medium" | "high";
  assumptions?: string[];
  rejection_reasons: string[];
  gates?: Array<{ id: string; passed: boolean; value: unknown; limit: unknown }>;
  observations?: number;
  method?: string;
};

/** Measured 3D — stereo. "not_run" without two synchronised, calibrated cameras; nothing is ever simulated. */
export type Measured3D = {
  mode: "measured_stereo";
  status: "not_run" | "available" | "rejected";
  label: string;
  reason?: string;
  speed_kmh: number | null;
  trajectory_xyz_m?: Array<{ time_s: number; x: number; y: number; z: number }>;
};

/** Speed statistics of one basis, in image pixels per second. */
export type SpeedStats = { basis: string; count: number; max_px_per_s: number | null; mean_px_per_s: number | null };

export type PlayerDistance = {
  value: number;
  unit: "m" | "px";
  basis: string;
  jumps_skipped: number;
  smoothing_frames: number;
  max_step_rule: string;
} | null;

export type MostFrequentEstimate = {
  label: string;
  count: number;
  of: number;
  label_kind: "trajectory_estimate_unverified";
  badge: string;
} | null;

/** Everything the dashboards show, computed once on the backend. The studio displays it and computes nothing. */
export type DashboardBlock = {
  note: string;
  players: Record<string, {
    contacts: number;
    confirmed_contacts: number;
    official_max_px_per_s: number | null;
    official_mean_px_per_s: number | null;
    official_speed_count: number;
    distance: PlayerDistance;
    most_frequent_estimate: MostFrequentEstimate;
  }>;
  speed_panel: {
    unit: "px/s";
    official_count: number;
    official_mean_px_per_s: number | null;
    official_max_px_per_s: number | null;
    candidate_count: number;
    candidate_mean_px_per_s: number | null;
    rally_mean_duration_s: number | null;
    shot_interval_mean_s: number | null;
    shot_interval_basis: "within_rally";
  };
  distance_chart: { unit: "m" | "px"; basis: string; series: Record<string, Array<[number, number]>> };
  contact_positions: {
    space: "court_m" | "image_normalized";
    label: string;
    frame_size?: [number, number];
    items: Array<{ shot_id: string; timeline_id: string; frame: number; player: string | null; x: number | null; y: number | null }>;
  };
};

/** The sanitized shuttle track of the analysis (observed-2d/v1), compact. */
export type Observed2DBlock = {
  version: string;
  config: Record<string, number>;
  frame_size: [number, number];
  fps: number;
  timestamp_source: string;
  max_speed_px_s: number;
  frames_total: number;
  frames_without_position: number;
  detected: number;
  interpolated: number;
  rejected: Record<string, number>;
  rejected_total: number;
  invalid_steps: number;
  segments: number;
  coordinate_space: string;
  /** [frame, x, y, "d" detected | "i" interpolated, segment]. */
  points: Array<[number, number, number, "d" | "i", number]>;
  /** [frame, x, y, reason]. */
  rejected_points: Array<[number, number | null, number | null, string]>;
};

export type MatchSpeed = {
  status: "image_space" | "experimental_3d";
  kmh: number | null;
  kind: string | null;
  label: string;
  reason: string;
  conditions: SpeedCondition[];
};

export type PlayerSummary = {
  frames_with_identity: number;
  distance_m: number | null;
  jumps_skipped: number;
  distance?: PlayerDistance;
  mean_identity_confidence: number | null;
  hits: number;
  confirmed_contacts?: number;
  official_speed?: SpeedStats;
  coverage: number | null;
  estimates_by_type?: Record<string, number>;
  most_frequent_estimate?: MostFrequentEstimate;
  person_labels_by_type?: Record<string, number>;
};

export type MatchDocument = {
  schema: "smashlab.match/v1";
  job_id: string;
  fps: number;
  frames: number | null;
  duration_s: number | null;
  mode: string;
  players: string[];
  court: {
    status: string | null;
    reason: string | null;
    score: number | null;
    coverage: number | null;
    template: string | null;
    dimensions_m: { length_m: number; doubles_width_m: number; singles_width_m: number };
    map_available: boolean;
    approximation: string | null;
  };
  speed: MatchSpeed;
  positions: { court_available: boolean; reason: string | null; step_frames: number; series: Record<string, PositionPoint[]> };
  observed_2d?: Observed2DBlock;
  contacts: {
    method: string;
    status: string;
    validated: boolean;
    dedupe_window_frames: number;
    turns_without_player: number;
    items: MatchContact[];
  };
  rallies: { status: string; validated: boolean; method: string | null; items: MatchRally[] };
  annotations: {
    transferred: Array<{ type: string; frame: number; original_frame: number; player: string | null; decision: string | null; shot_type: string | null; source_job_id: string; correction_id: string }>;
    unmatched: Array<{ type: string; frame: number | null; player: string | null; reason: string; source_job_id: string; correction_id: string }>;
    rule: string;
  };
  shots: {
    classifier: { available: boolean; model_version: string | null; reason: string };
    types: string[];
    items: MatchShot[];
  };
  summary: {
    rallies: {
      candidates: number;
      uncertain: number;
      confirmed: number;
      count: number;
      mean_duration_s: number | null;
      longest_s: number | null;
      shots_per_rally_mean: number | null;
      player_participation: Record<string, number>;
      method: string;
    };
    contacts: {
      counted: number;
      candidates: number;
      confirmed: number;
      rejected: number;
      turns_without_player: number;
      same_player_twice: number;
      rejected_automatic: number;
    };
    shots: {
      by_type: Record<string, number>;
      labelled: number;
      unknown: number;
      person_notes?: number;
      estimates_by_type?: Record<string, number>;
      estimate_label_kind?: "trajectory_estimate_unverified";
      interval_within_rally?: { mean_s: number | null; count: number; basis: string };
    };
    speed: {
      unit?: "px/s";
      kind?: string;
      label?: string;
      official?: SpeedStats;
      candidates?: SpeedStats;
      max_kmh: number | null;
      physical_measurements: number;
      physical_label: string;
      max_px_per_s: number | null;
      candidate_max_px_per_s: number | null;
      measured_shots: number;
      by_basis: { confirmed_contact: number; automatic_candidate: number };
      method: string | null;
      estimated_3d?: { mode: string; label: string; available: number; rejected: number; rejection_reasons: Record<string, number> };
      measured_3d?: Measured3D;
    };
    players: Record<string, PlayerSummary>;
  };
  dashboard?: DashboardBlock;
  measured_3d?: Measured3D;
  ai: {
    frames: number | null;
    fps: number | null;
    wall_seconds: number | null;
    frames_per_second: number | null;
    shuttle_detected_ratio: number | null;
    identity_coverage: Record<string, number> | null;
    court_status: string | null;
    models: Record<string, { name: string | null; executed: boolean | null }> | null;
    device: string | null;
    note: string;
  };
};
