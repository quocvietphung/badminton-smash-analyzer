// The match document served by GET /api/v1/analyses/{id}/match (schema smashlab.match/v1).
// Every value is derived on the backend from saved analysis outputs; nothing here is invented in the browser.

export type ContactStatus = "candidate" | "confirmed" | "rejected";

/** One row of the per-shot trajectory dataset (schema smashlab.shot-trajectory/v1). An automatic estimate, never a label. */
export type TrajectoryEstimate = {
  shot_id: string;
  job_id: string;
  run_id: string;
  frame: number;
  timestamp_s: number;
  player: string | null;
  contact_status: ContactStatus;
  best_guess_label: string;
  review_status: "accepted_by_gate" | "needs_review";
  evidence_tier: "full_trajectory" | "partial_trajectory" | "contact_fallback";
  evidence_quality: "high" | "medium" | "low";
  rule_version: string;
  frame_size: [number, number];
  label_kind: "trajectory_estimate_unverified";
  manual_label: string | null;
  contact_image: { x_px: number | null; y_px: number | null; x_normalized: number | null; y_normalized: number | null };
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
  features: Record<string, number | string | boolean | null>;
  scores: Record<string, number>;
  top3: [string, number][];
  missing_features: string[];
  review_reasons: string[];
  quality_warnings: string[];
  offset_labels: Record<string, string>;
};

export type TrajectoryPoint = { frame: number; time_s: number; x_px: number; y_px: number; confidence: number; interpolated: boolean };

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
  trajectory?: { best_guess_label: string; evidence_tier: string; evidence_quality: string; review_status: string; shot_id: string } | null;
  hit_frame?: number | null;
  flags: string[];
  speed: ShotSpeed | null;
  physical_speed: PhysicalSpeed;
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

/** Image-space shuttle motion near a contact. It is not a physical speed; kmh is always null. */
export type ShotSpeed = {
  kmh: number | null;
  px_per_s: number | null;
  kind: string | null;
  reason?: string;
  points?: number;
  method?: string;
  physical_speed_available?: false;
  basis?: "confirmed_contact" | "automatic_candidate";
};

export type PhysicalSpeed = {
  status: "available" | "unavailable";
  label: string;
  not_radar_validated: true;
  reason_codes: string[];
  speed_first_observed_kmh: number | null;
  speed_at_net_kmh: number | null;
  speed_at_net_time_s?: number | null;
  speed_at_contact_extrapolated_kmh: number | null;
  uncertainty_kmh: [number, number] | null;
  method: string;
  evidence: {
    measurement_time_s?: number;
    measurement_frame?: number;
    usable_observations?: number;
    timestamp_source?: string;
    reprojection_rms_px?: number;
    reprojection_p95_px?: number;
    multistart_speed_spread_fraction?: number;
  };
  calibration: { source?: string; reason?: string | null; reprojection_rms_px?: number | null };
  assumptions: { terminal_velocity_m_s?: number; drag_k_per_m?: number; camera_model?: string };
  quality: { passed: boolean; reprojection_rms_px?: number; reprojection_p95_px?: number };
  runtime_ms: number;
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
  mean_identity_confidence: number | null;
  hits: number;
  coverage: number | null;
  shots_by_type: Record<string, number>;
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
    shots: { by_type: Record<string, number>; labelled: number; unknown: number };
    speed: {
      max_kmh: number | null;
      physical_measurements: number;
      physical_label: string;
      max_px_per_s: number | null;
      candidate_max_px_per_s: number | null;
      measured_shots: number;
      by_basis: { confirmed_contact: number; automatic_candidate: number };
      method: string | null;
    };
    players: Record<string, PlayerSummary>;
  };
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
