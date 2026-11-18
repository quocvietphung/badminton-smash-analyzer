"""Validate one analysis output folder produced by the local pipeline.

Usage: python3 -I backend/tools/validate_outputs.py <output_dir> [--expect-court]

Checks: required files exist, JSON parses and carries the expected schema keys, shuttle and
player coordinates lie inside the source frame, the annotated MP4 is H.264 yuv420p with the
expected frame count and the moov atom before mdat (faststart). Exits non-zero on failure.
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
SHOT_SCHEMA = "smashlab.shot-trajectory/v1"
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
    if shot_summary.get("schema") != SHOT_SCHEMA or shot_summary.get("rule_version") != "trajectory-rules/v1":
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
        },
    }
    print(json.dumps(summary, indent=2))
    return 0 if not problems else 1


if __name__ == "__main__":
    raise SystemExit(main())
