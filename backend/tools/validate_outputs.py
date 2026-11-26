"""Validate one analysis output folder produced by the local pipeline.

Usage: python3 -I backend/tools/validate_outputs.py <output_dir> [--expect-court]

Checks: required files exist, JSON parses and carries the expected schema keys, shuttle and
player coordinates lie inside the source frame, the annotated MP4 is H.264 yuv420p with the
expected frame count and the moov atom before mdat (faststart).

Observed 2D parity: every Shot timeline row matches exactly one dataset record (shot id, frame,
timestamp, player, contact status, label, px/s, quality); labels are six-class only; no speed uses
a frame the observed-2d sanitizer rejected; official speed statistics use confirmed contacts only;
the dashboard block equals the summary; timestamps equal the video timestamps; Estimated 3D is
"available" or "rejected" with reasons; Measured 3D is NOT RUN without stereo input.
Exits non-zero on failure.
"""

from __future__ import annotations

import json
import os
import struct
import subprocess
import sys

REQUIRED = [
    "annotated.mp4",
    "results.json",
    "analysis.json",
    "analysis_report.json",
    "player_tracks.json",
    "identity_events.json",
    "rallies.json",
    "shots.json",
    "shuttle_trajectory.json",
    "metrics.json",
    "inference_report.json",
]
SCHEMA = "smashlab.local-ai.results/v1"
SHOT_SCHEMA = "smashlab.shot-trajectory/v2"
RULE_VERSION = "trajectory-rules/v2"
FORBIDDEN_LABELS = {"serve", "push", "defensive_block", "unknown"}
SHOT_CLASSES = {"smash", "clear", "drop", "drive", "net_shot", "lift"}
SHOT_TIERS = {"full_trajectory", "partial_trajectory", "contact_fallback"}
SHOT_QUALITIES = {"high", "medium", "low"}
SHOT_REVIEW = {"accepted_by_gate", "needs_review"}


def read_jsonl(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def top_level_atoms(path: str) -> list[str]:
    atoms: list[str] = []
    with open(path, "rb") as handle:
        size_total = os.path.getsize(path)
        offset = 0
        while offset < size_total:
            handle.seek(offset)
            header = handle.read(8)
            if len(header) < 8:
                break
            size, kind = struct.unpack(">I4s", header)
            atoms.append(kind.decode("latin-1"))
            if size == 1:
                size = struct.unpack(">Q", handle.read(8))[0]
            elif size == 0:
                size = size_total - offset
            if size < 8:
                break
            offset += size
    return atoms


def probe_mp4(path: str) -> dict:
    command = [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-count_frames",
        "-show_entries",
        "stream=codec_name,pix_fmt,width,height,nb_read_frames,avg_frame_rate",
        "-of",
        "json",
        path,
    ]
    data = json.loads(subprocess.run(command, check=True, capture_output=True, text=True).stdout)
    return data["streams"][0]


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    folder = sys.argv[1]
    expect_court = "--expect-court" in sys.argv
    problems: list[str] = []
    for name in REQUIRED:
        if not os.path.isfile(os.path.join(folder, name)):
            problems.append(f"missing {name}")
    for name in ("match.json", "derived/shot_trajectory_summary.json", "derived/shot_trajectory_records.json",
                 "derived/shot_trajectory_dataset.jsonl"):
        if not os.path.isfile(os.path.join(folder, name)):
            problems.append(f"missing {name}")
    if problems:
        print(json.dumps({"folder": folder, "ok": False, "problems": problems}, indent=2))
        return 1

    results = json.load(open(os.path.join(folder, "results.json"), encoding="utf-8"))
    tracks = json.load(open(os.path.join(folder, "player_tracks.json"), encoding="utf-8"))
    shuttle = json.load(open(os.path.join(folder, "shuttle_trajectory.json"), encoding="utf-8"))
    metrics = json.load(open(os.path.join(folder, "metrics.json"), encoding="utf-8"))
    report = json.load(open(os.path.join(folder, "inference_report.json"), encoding="utf-8"))
    match = json.load(open(os.path.join(folder, "match.json"), encoding="utf-8"))
    shot_summary = json.load(open(os.path.join(folder, "derived/shot_trajectory_summary.json"), encoding="utf-8"))
    shot_records_api = json.load(open(os.path.join(folder, "derived/shot_trajectory_records.json"), encoding="utf-8"))
    shot_records = read_jsonl(os.path.join(folder, "derived/shot_trajectory_dataset.jsonl"))

    if results.get("schema") != SCHEMA or results.get("status") != "completed":
        problems.append("results.json schema or status is wrong")
    for key in ("video", "players", "movement", "shuttle", "court", "rally_segmentation", "shot_classification", "confidence", "artifacts", "limitations"):
        if key not in results:
            problems.append(f"results.json missing key {key}")
    rally = results.get("rally_segmentation", {})
    if rally.get("status") != "heuristic_candidates" or rally.get("validated") is not False:
        problems.append("rally candidates must be labelled heuristic_candidates and not validated")
    if rally.get("evaluation") != "not evaluated (no ground truth)":
        problems.append("rally evaluation must say that no ground truth exists")
    if results.get("shot_classification", {}).get("status") != "unsupported":
        problems.append("shot classification must be reported as unsupported in this build")
    rallies_doc = json.load(open(os.path.join(folder, "rallies.json"), encoding="utf-8"))
    if rallies_doc.get("validated") is not False or rallies_doc.get("count") != len(rallies_doc.get("rallies", [])):
        problems.append("rallies.json must be unvalidated and its count must match the list")
    shots_doc = json.load(open(os.path.join(folder, "shots.json"), encoding="utf-8"))
    if shots_doc.get("status") != "unsupported" or shots_doc.get("shots"):
        problems.append("shots.json must be unsupported and must list no shots")
    identity_doc = json.load(open(os.path.join(folder, "identity_events.json"), encoding="utf-8"))
    if "events" not in identity_doc or "event_counts" not in identity_doc:
        problems.append("identity_events.json is missing events or event_counts")

    width = results["video"]["width"]
    height = results["video"]["height"]
    for frame in shuttle["frames"]:
        if frame["visible"]:
            if not (0 <= frame["x"] < width and 0 <= frame["y"] < height):
                problems.append(f"shuttle point outside frame at frame {frame['frame']}")
                break
    for track in tracks["tracks"]:
        for obs in track["observations"]:
            if not (-1 <= obs["x1"] <= width + 1 and -1 <= obs["x2"] <= width + 1 and -1 <= obs["y2"] <= height + 1):
                problems.append(f"player box outside frame in track {track['track_id']}")
                break
    if "duration_s" in metrics and metrics.get("frames_analysed", 0) <= 0:
        problems.append("metrics report zero analysed frames")

    timeline = match.get("shots", {}).get("items", [])
    if len(shot_records) != len(timeline):
        problems.append(f"trajectory dataset has {len(shot_records)} rows for {len(timeline)} timeline entries")
    if shot_summary.get("records") != len(shot_records):
        problems.append("trajectory summary record count differs from JSONL")
    if shot_summary.get("schema") != SHOT_SCHEMA or shot_summary.get("rule_version") != RULE_VERSION:
        problems.append("trajectory summary schema or rule version is wrong")
    if shot_records_api.get("job_id") != shot_summary.get("job_id") or shot_records_api.get("records") != shot_records:
        problems.append("trajectory records API differs from the exported JSONL")
    if len({record.get("shot_id") for record in shot_records}) != len(shot_records):
        problems.append("trajectory dataset shot ids are not unique")
    timeline_frames = [int(item["frame"]) for item in timeline]
    record_frames = [int(item.get("frame", -1)) for item in shot_records]
    if record_frames != timeline_frames:
        problems.append("trajectory dataset frames differ from the Shot timeline")
    fps = float(match.get("fps") or results.get("video", {}).get("fps") or 0)
    for index, record in enumerate(shot_records):
        prefix = f"trajectory row {index}"
        if record.get("schema") != SHOT_SCHEMA:
            problems.append(f"{prefix} has the wrong schema")
        if record.get("job_id") != shot_summary.get("job_id"):
            problems.append(f"{prefix} belongs to another job")
        if record.get("best_guess_label") not in SHOT_CLASSES:
            problems.append(f"{prefix} has an invalid or unknown label")
        if record.get("evidence_tier") not in SHOT_TIERS or record.get("evidence_quality") not in SHOT_QUALITIES:
            problems.append(f"{prefix} has invalid evidence metadata")
        if record.get("review_status") not in SHOT_REVIEW:
            problems.append(f"{prefix} has an invalid review status")
        if set(record.get("scores", {})) != SHOT_CLASSES:
            problems.append(f"{prefix} does not score all six classes")
        if len(record.get("top3", [])) != 3:
            problems.append(f"{prefix} does not have a top 3")
        if not isinstance(record.get("features"), dict) or not isinstance(record.get("trajectory_before"), list) \
                or not isinstance(record.get("trajectory_after"), list):
            problems.append(f"{prefix} is missing trajectory features")
        expected_time = record.get("frame", 0) / fps if fps > 0 else None
        if expected_time is None or abs(float(record.get("timestamp_s", -1)) - expected_time) > 0.002:
            problems.append(f"{prefix} timestamp does not match its frame")
        if "km/h" in json.dumps(record, ensure_ascii=False):
            problems.append(f"{prefix} incorrectly contains a physical shuttle speed")
        for key in ("scores", "top3", "evidence_tier", "evidence_quality", "review_status", "review_reasons", "missing_features",
                    "rule_version", "contact_status", "detected_ratio", "interpolated_ratio", "image_speed", "observed_2d_version"):
            if key not in record:
                problems.append(f"{prefix} is missing {key}")

    # Observed 2D parity between the Shot timeline, the dataset and the dashboard block.
    times = {int(item["frame"]): float(item["time_s"]) for item in shuttle["frames"] if item.get("time_s") is not None}
    rejected_frames = {int(row[0]) for row in (match.get("observed_2d") or {}).get("rejected_points", [])}
    for shot, record in zip(timeline, shot_records):
        where = f"timeline row {shot.get('id')} (frame {shot.get('frame')})"
        pairs = {
            "shot id": (record.get("shot_id"), shot.get("shot_id")),
            "timeline id": (record.get("timeline_id"), shot.get("id")),
            "frame": (record.get("frame"), shot.get("frame")),
            "player": (record.get("player"), shot.get("player")),
            "contact status": (record.get("contact_status"), shot.get("contact_status")),
            "label": (record.get("label"), shot.get("type")),
            "px/s": ((record.get("image_speed") or {}).get("px_per_s"), (shot.get("speed") or {}).get("px_per_s")),
            "quality": (record.get("evidence_quality"), (shot.get("trajectory") or {}).get("evidence_quality")),
        }
        for name, (left, right) in pairs.items():
            if left != right:
                problems.append(f"{where}: {name} differs between dataset ({left!r}) and timeline ({right!r})")
        if abs(float(record.get("timestamp_s", -1)) - float(shot.get("time_s", -2))) > 1e-6:
            problems.append(f"{where}: timestamp differs between dataset and timeline")
        frame_value = int(record.get("frame", -1))
        if frame_value in times and abs(float(record.get("timestamp_s", -1)) - times[frame_value]) > 0.0015:
            problems.append(f"{where}: timestamp does not match the video timestamp of the frame")
        if not 0 <= frame_value < int(results["video"]["frames_analysed"]):
            problems.append(f"{where}: frame outside the analysed video")
        if shot.get("type") not in SHOT_CLASSES or shot.get("type") in FORBIDDEN_LABELS:
            problems.append(f"{where}: timeline label {shot.get('type')!r} is not one of the six classes")
        used = set((record.get("image_speed") or {}).get("frames") or [])
        if used & rejected_frames:
            problems.append(f"{where}: px/s uses frames the sanitizer rejected {sorted(used & rejected_frames)}")
        estimated = shot.get("estimated_3d") or {}
        if estimated.get("status") not in ("available", "rejected"):
            problems.append(f"{where}: Estimated 3D status {estimated.get('status')!r} is neither available nor rejected")
        if estimated.get("status") == "rejected" and (not estimated.get("rejection_reasons") or estimated.get("speed_candidate_kmh") is not None):
            problems.append(f"{where}: a rejected Estimated 3D result must give reasons and no speed")
        if (shot.get("measured_3d") or {}).get("status") != "not_run":
            problems.append(f"{where}: Measured 3D must be NOT RUN without stereo input")
    confirmed = [shot["speed"]["px_per_s"] for shot in timeline
                 if shot.get("contact_status") == "confirmed" and (shot.get("speed") or {}).get("px_per_s") is not None]
    official = ((match.get("summary") or {}).get("speed") or {}).get("official") or {}
    if official.get("count") != len(confirmed) or official.get("max_px_per_s") != (max(confirmed) if confirmed else None):
        problems.append("official speed summary does not equal the confirmed timeline rows")
    panel = (match.get("dashboard") or {}).get("speed_panel") or {}
    if panel.get("official_count") != official.get("count") or panel.get("official_max_px_per_s") != official.get("max_px_per_s"):
        problems.append("dashboard speed panel differs from the backend speed summary")
    for identity, row in ((match.get("dashboard") or {}).get("players") or {}).items():
        own = [shot["speed"]["px_per_s"] for shot in timeline if shot.get("player") == identity
               and shot.get("contact_status") == "confirmed" and (shot.get("speed") or {}).get("px_per_s") is not None]
        if row.get("official_max_px_per_s") != (max(own) if own else None):
            problems.append(f"dashboard {identity} official max differs from its confirmed timeline rows")
        estimate = row.get("most_frequent_estimate")
        if estimate is not None and estimate.get("label_kind") != "trajectory_estimate_unverified":
            problems.append(f"dashboard {identity} most frequent shot is not labelled as an unverified estimate")
    if ((match.get("measured_3d") or {}).get("status")) != "not_run":
        problems.append("Measured 3D must be NOT RUN without stereo input")

    if expect_court:
        if results["court"].get("status") != "calibrated":
            problems.append("court calibration expected but not calibrated")
        if not os.path.isfile(os.path.join(folder, "court_coordinates.json")):
            problems.append("court_coordinates.json missing although calibrated")

    stream = probe_mp4(os.path.join(folder, "annotated.mp4"))
    atoms = top_level_atoms(os.path.join(folder, "annotated.mp4"))
    faststart = "moov" in atoms and "mdat" in atoms and atoms.index("moov") < atoms.index("mdat")
    if stream["codec_name"] != "h264":
        problems.append(f"annotated video codec is {stream['codec_name']}, expected h264")
    if stream["pix_fmt"] != "yuv420p":
        problems.append(f"annotated video pixel format is {stream['pix_fmt']}, expected yuv420p")
    if not faststart:
        problems.append("annotated video is not faststart (moov not before mdat)")
    if int(stream.get("nb_read_frames", 0)) != int(results["video"]["frames_analysed"]):
        problems.append("annotated frame count differs from analysed frames")

    summary = {
        "folder": folder,
        "ok": not problems,
        "problems": problems,
        "court_status": results["court"].get("status"),
        "frames_analysed": results["video"]["frames_analysed"],
        "annotated": {
            "codec": stream["codec_name"],
            "pix_fmt": stream["pix_fmt"],
            "frames": int(stream.get("nb_read_frames", 0)),
            "faststart": faststart,
            "bytes": os.path.getsize(os.path.join(folder, "annotated.mp4")),
        },
        "json_bytes": {name: os.path.getsize(os.path.join(folder, name)) for name in sorted(os.listdir(folder)) if name.endswith(".json")},
        "inference_models": [m["name"] for m in report.get("models", [])],
        "shot_trajectory": {
            "records": len(shot_records),
            "rule_version": shot_summary.get("rule_version"),
            "labels": shot_summary.get("label_distribution"),
            "review_status": shot_summary.get("review_status"),
            "image_speed_px_s": shot_summary.get("image_speed_px_s"),
            "official_speed": shot_summary.get("official_speed"),
            "estimated_3d": shot_summary.get("estimated_3d"),
            "measured_3d": (shot_summary.get("measured_3d") or {}).get("status"),
            "observed_2d": {key: (shot_summary.get("observed_2d") or {}).get(key)
                            for key in ("detected", "interpolated", "rejected", "invalid_steps", "timestamp_source")},
            "derived_stage_seconds": shot_summary.get("derived_stage_seconds"),
        },
    }
    print(json.dumps(summary, indent=2))
    return 0 if not problems else 1


if __name__ == "__main__":
    raise SystemExit(main())
