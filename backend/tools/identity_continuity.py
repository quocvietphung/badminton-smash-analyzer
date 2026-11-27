"""Measure identity continuity by re-deriving stored analyses under tracker settings. Read-only, no model run.

For each job the stored raw person boxes (raw/detections.jsonl), the stored shuttle file and the automatic court are
derived again exactly as the pipeline does, with the clip's frames for the appearance features. The tool reports, per
setting, how many tracker tracks each logical identity was assembled from (tracks_per_identity: 1 means it never
broke), how often an identity moved to another track, the identity coverage and the number of identity events.

The default setting must reproduce the stored player_tracks.json; the tool says so in its first line per clip.
Fewer tracks per identity is better continuity, not correct identity: there is no ground truth for these clips, so a
setting that joins two people would also score well. Read the switches and the coverage beside it.

Usage (from backend/):
  .venv-dev/bin/python tools/identity_continuity.py --out ../outputs/test-runs/<stamp>-identity \
      ../outputs/<job A> ../data/samples/sample-a-singles-rally.mp4 ...
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.pipeline.derive import DeriveConfig, court_from_auto, derive, identity_segments  # noqa: E402
from app.pipeline.media import iter_frames  # noqa: E402
from app.pipeline.runner import load_raw_detections, load_refined_shuttle  # noqa: E402
from app.services.golden import identity_continuity  # noqa: E402

# ByteTrack settings tried beside the default. max_age: frames a lost track is kept; match_iou: first-stage overlap.
SETTINGS = {
    "default": {},
    "max_age_60": {"max_age": 60},
    "max_age_90": {"max_age": 90},
    "match_iou_0.2": {"match_iou": 0.2},
    "max_age_60_match_iou_0.2": {"max_age": 60, "match_iou": 0.2},
    "high_threshold_0.4": {"high_threshold": 0.4, "new_track_threshold": 0.45},
}


def rederive(job_dir: Path, video: Path, tracker_kwargs: dict) -> dict:
    raw = job_dir / "raw"
    meta = json.loads((raw / "inference_meta.json").read_text(encoding="utf-8"))
    court = court_from_auto(json.loads((raw / "court_auto.json").read_text(encoding="utf-8")))
    output = derive(
        fps=float(meta["fps"]), width=int(meta["width"]), height=int(meta["height"]),
        total_frames=int(meta["analysed_frames"]) or int(meta["frame_count"]),
        detections=load_raw_detections(str(raw)), shuttle=load_refined_shuttle(str(job_dir)), court=court,
        corrections_doc={"entries": []}, config=DeriveConfig(mode="auto", render=False, tracker_kwargs=tracker_kwargs),
        frames=iter_frames(str(video)),
    )
    by_track_frame = {(frame, state.track_id): state.identity for frame, states in output.identity_states for state in states
                      if state.track_id is not None}
    tracks = {"tracks": [{"track_id": record["track_id"],
                          "observations": [{"frame": obs["frame"], "identity": by_track_frame.get((obs["frame"], record["track_id"]))}
                                           for obs in record["observations"]]}
                         for record in output.track_records]}
    total = int(meta["analysed_frames"]) or int(meta["frame_count"])
    coverage = {}
    for identity, segments in identity_segments(output.identity_states).items():
        covered = sum(s["end_frame"] - s["start_frame"] + 1 for s in segments if s["status"] in ("matched", "recovered", "manual"))
        coverage[identity] = round(covered / total, 4) if total else None
    events: dict[str, int] = {}
    for event in output.identity_events:
        kind = event["kind"] if isinstance(event, dict) else getattr(event, "kind", str(event))
        events[kind] = events.get(kind, 0) + 1
    return {**identity_continuity(tracks), "coverage": dict(sorted(coverage.items())), "events": dict(sorted(events.items())),
            "mode": output.mode}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", required=True)
    parser.add_argument("pairs", nargs="+", help="job folder and sample video, repeated")
    args = parser.parse_args(argv)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    report = {"schema": "smashlab.identity-continuity/v1", "settings": SETTINGS,
              "note": "Continuity, not correctness: there is no ground truth for identities in these clips.", "analyses": []}
    for job, video in zip(args.pairs[0::2], args.pairs[1::2]):
        job_dir = Path(job)
        stored = identity_continuity(json.loads((job_dir / "player_tracks.json").read_text(encoding="utf-8")))
        entry = {"job_id": job_dir.name, "video": Path(video).name, "stored": stored, "settings": {}}
        for name, kwargs in SETTINGS.items():
            began = time.perf_counter()
            entry["settings"][name] = {**rederive(job_dir, Path(video), kwargs), "seconds": round(time.perf_counter() - began, 1)}
        default = entry["settings"]["default"]
        entry["default_reproduces_stored"] = (default["tracks_per_identity"], default["track_switches"]) == (
            stored["tracks_per_identity"], stored["track_switches"])
        report["analyses"].append(entry)
        print(f"{job_dir.name[:8]} {Path(video).name}: default reproduces stored = {entry['default_reproduces_stored']}")
        for name, value in entry["settings"].items():
            print(f"  {name:28s} tracks/identity {value['tracks_per_identity']} switches {value['track_switches']} "
                  f"coverage {value['coverage']} events {value['events']}")
    (out / "identity_continuity.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
