// Types and display rules for model_execution.json. A model is shown as run only when the backend record says so.

export type ModelRecord = {
  executed?: boolean;
  name?: string;
  family?: string;
  file?: string;
  onnx_sha256?: string;
  checkpoint?: string;
  checkpoint_sha256?: string;
  providers?: string[];
  licence?: string;
  frames_processed?: number;
  windows_processed?: number;
  ms_per_frame?: number | null;
  conf_threshold?: number;
  input_size?: number;
  class_filter?: string;
  status?: string;
  not_applied_reason?: string | null;
  motion_model?: string;
  assignment?: string;
  logical_identities?: number;
  events?: number;
  tracks_total?: number;
  tracks_confirmed?: number;
  score?: number | null;
  coverage?: number | null;
  source?: string;
};

export type ModelExecutionFile = {
  schema: string;
  job_id: string;
  status: string;
  device: string;
  threads: number;
  runtime: Record<string, string | null>;
  models: Record<string, ModelRecord>;
  timing: Record<string, number | null>;
  not_implemented: string[];
};

export type RunState = "ran" | "not-run" | "unknown";

/** "ran" only when the record says executed: true. Missing or unknown records never count as run. */
export function runState(model: ModelRecord | undefined): RunState {
  if (!model || typeof model.executed !== "boolean") return "unknown";
  return model.executed ? "ran" : "not-run";
}

/** A short form of a sha256 for display; the full value stays in the record. */
export function shortDigest(value: string | undefined | null): string {
  return value ? `${value.slice(0, 12)}…` : "–";
}
