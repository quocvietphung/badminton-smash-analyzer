// Loads the evidence files of one completed analysis. A file that is missing or unreadable is reported by name,
// and the rest of the evidence still loads (for example, court_coordinates.json does not exist without calibration).
import { artifactUrl, correctionsUrl, fetchJson, type LocalAiArtifactName } from "@/lib/local-ai/client";
import type {
  CorrectionEntry,
  IdentityEventsFile,
  PlayerTracksFile,
  RalliesFile,
  TrajectoryFrameLike,
} from "@/lib/local-ai/evidence";

export type CourtFile = {
  status: string;
  source?: string;
  reason?: string;
  homography_image_from_court?: number[][] | null;
  quad_image_px?: number[][] | null;
};

export type ShotsFile = { status: string; reason: string; evaluation: string };

export type ShuttleFile = { frames: TrajectoryFrameLike[] };

export type EvidenceBundle = {
  tracks: PlayerTracksFile | null;
  events: IdentityEventsFile | null;
  rallies: RalliesFile | null;
  shots: ShotsFile | null;
  court: CourtFile | null;
  shuttle: ShuttleFile | null;
  corrections: CorrectionEntry[];
  missing: string[];
};

async function loadArtifact<T>(apiBase: string, jobId: string, name: LocalAiArtifactName): Promise<T | null> {
  try {
    return await fetchJson<T>(artifactUrl(apiBase, jobId, name));
  } catch {
    return null;
  }
}

/** courtCalibrated false skips court_coordinates.json: the backend writes it only for a calibrated court. */
export async function loadEvidenceBundle(apiBase: string, jobId: string, options: { courtCalibrated?: boolean } = {}): Promise<EvidenceBundle> {
  const [tracks, events, rallies, shots, court, shuttle, corrections] = await Promise.all([
    loadArtifact<PlayerTracksFile>(apiBase, jobId, "player_tracks.json"),
    loadArtifact<IdentityEventsFile>(apiBase, jobId, "identity_events.json"),
    loadArtifact<RalliesFile>(apiBase, jobId, "rallies.json"),
    loadArtifact<ShotsFile>(apiBase, jobId, "shots.json"),
    options.courtCalibrated === false ? Promise.resolve(null) : loadArtifact<CourtFile>(apiBase, jobId, "court_coordinates.json"),
    loadArtifact<ShuttleFile>(apiBase, jobId, "shuttle_trajectory.json"),
    fetchJson<{ entries: CorrectionEntry[] }>(correctionsUrl(apiBase, jobId)).then(
      (body) => body.entries,
      () => null,
    ),
  ]);
  const missing: string[] = [];
  if (!tracks) missing.push("player_tracks.json");
  if (!events) missing.push("identity_events.json");
  if (!rallies) missing.push("rallies.json");
  if (!shuttle) missing.push("shuttle_trajectory.json");
  if (corrections === null) missing.push("corrections");
  return {
    tracks,
    events,
    rallies,
    shots,
    court,
    shuttle,
    corrections: corrections ?? [],
    missing,
  };
}
