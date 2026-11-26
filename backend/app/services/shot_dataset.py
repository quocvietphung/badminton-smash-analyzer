"""Per-shot derived dataset: one trajectory-rules/v2 record for every row of the Shot timeline of one analysis.

Written to outputs/<job-id>/derived/ only. Raw TrackNet output, analysis.json, shots.json, model_execution.json and
corrections.json are never written here. The dataset can be rebuilt from the raw outputs with the same rule version.

Every record is for this job only: the shuttle trajectory and court calibration are read from this job's folder, and the
player positions come from this job's match document. Nothing is copied from another analysis or sample.

This file is the Observed 2D tier only: image positions in pixels and image-space speeds in px/s, from the shared
observed-2d/v1 track. The Estimated 3D and Measured 3D tiers are kept in their own files.
"""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from statistics import median
from typing import Iterable, Mapping, Optional

from app.analytics import observed2d as O
from app.analytics import trajectory_rules as R
from app.analytics.match import player_foot_at

SCHEMA = "smashlab.shot-trajectory/v2"
DERIVED_DIR = "derived"
DATASET_FILE = "shot_trajectory_dataset.jsonl"
SUMMARY_FILE = "shot_trajectory_summary.json"
NEAREST_POSITION_FRAMES = 3
FEATURE_ALIASES = {
    "rise_norm": "rise_normalized",
    "flight_s": "observed_flight_s",
    "curvature_rad": "trajectory_curvature",
}
SIX_CLASSES = set(R.CLASSES)


def derived_dir(job_dir: str) -> str:
    return os.path.join(job_dir, DERIVED_DIR)


def dataset_path(job_dir: str) -> str:
    return os.path.join(derived_dir(job_dir), DATASET_FILE)


def summary_path(job_dir: str) -> str:
    return os.path.join(derived_dir(job_dir), SUMMARY_FILE)


def _sha256(path: str) -> Optional[str]:
    if not os.path.isfile(path):
        return None
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def relative_to_net(distance_m: Optional[float]) -> Optional[str]:
    if distance_m is None:
        return None
    if distance_m <= 2.0:
        return "front_court"
    if distance_m <= 4.0:
        return "mid_court"
    return "back_court"


def player_foot(doc: Mapping, player: Optional[str], frame: int) -> Optional[tuple[float, float]]:
    """The player's foot position on the floor plane in metres, from the same match document (calibrated only)."""
    if not player or doc.get("court", {}).get("status") != "calibrated":
        return None
    series = (doc.get("positions", {}) or {}).get("series", {}).get(player, [])
    return player_foot_at(series, frame, NEAREST_POSITION_FRAMES)


def _camel(name: str) -> str:
    return FEATURE_ALIASES.get(name, name)


def _points(track: O.ObservedTrack, lo: int, hi: int) -> list[dict]:
    return [O.point_record(point) for point in track.window(lo, hi)]


def person_labels(shot: Mapping) -> tuple[Optional[str], Optional[str]]:
    """(a person's six-class label, a person's note outside the six classes such as "unknown" or a legacy label)."""
    manual = shot.get("type") if shot.get("type_source") == "manual" and shot.get("type") in SIX_CLASSES else None
    note = shot.get("person_label_note")
    return manual, (note if note not in SIX_CLASSES else None)


def build_record(*, job_id: str, run_id: str, shot: Mapping, track: O.ObservedTrack, doc: Mapping,
                 speed_ref: Optional[float], court_calibrated: bool, config: Optional[Mapping] = None) -> dict:  # noqa: C901
    frame = int(shot["frame"])
    player = shot.get("player")
    foot = player_foot(doc, player, frame)
    rules = R.CONFIG if config is None else config
    result = R.classify_contact(
        track, frame, fps=track.fps, width=track.width, height=track.height, speed_ref=speed_ref,
        player_foot=foot, court_calibrated=court_calibrated, contact_status=shot.get("contact_status", "candidate"),
        config=rules,
    )
    features = {_camel(name): value for name, value in result["features"].items()}
    contact_point = O.contact_point(track, frame)
    lo, hi = frame - rules["window_before"], frame + rules["window_after"]
    before = _points(track, lo, frame - 1)
    after = _points(track, frame + 1, hi)
    distance = result["features"].get("contact_net_m")
    manual, note = person_labels(shot)
    contact_status = shot.get("contact_status", "candidate")
    speed = {**O.image_speed_around(track, frame),
             "basis": "confirmed_contact" if contact_status == "confirmed" else "automatic_candidate"}
    last_frame = track.last_frame
    truncated = None
    if len(after) < rules["window_after"]:
        truncated = "video_end" if last_frame is not None and hi > last_frame else "tracking"
    window_counts = track.counts(lo, hi)
    return {
        "schema": SCHEMA,
        "job_id": job_id,
        "run_id": run_id,
        "shot_id": f"{job_id}-frame-{frame}",
        "timeline_id": shot.get("id"),
        "frame": frame,
        "timestamp_s": round(track.time_of(frame), 3),
        "player": player,
        "contact_status": contact_status,
        "best_guess_label": result["best_guess_label"],
        "label": manual or result["best_guess_label"],
        "label_source": "manual" if manual else "trajectory_estimate",
        "review_status": result["review_status"],
        "evidence_tier": result["evidence_tier"],
        "evidence_quality": result["evidence_quality"],
        "rule_version": R.RULE_VERSION,
        "observed_2d_version": O.VERSION,
        "frame_size": [track.width, track.height],
        "label_kind": "trajectory_estimate_unverified",
        "manual_label": manual,
        "person_label_note": note,
        "contact_image": {
            "x_px": None if contact_point is None else round(contact_point.x, 2),
            "y_px": None if contact_point is None else round(contact_point.y, 2),
            "x_normalized": result["features"].get("contact_x_norm"),
            "y_normalized": result["features"].get("contact_y_norm"),
            "coordinate_space": O.COORDINATE_SPACE,
        },
        "player_court_context": {
            "court_calibrated": court_calibrated,
            "player_side": result["features"].get("player_side"),
            "player_foot_x_m": foot[0] if foot else None,
            "player_foot_y_m": foot[1] if foot else None,
            "distance_to_net_m": distance,
            "relative_to_net": relative_to_net(distance),
            "coordinate_space": "floor-plane metres of the player's foot (court calibrated only)",
        },
        "trajectory_before": before,
        "trajectory_after": after,
        "rejected_points": [item.as_record() for item in track.rejected_in(lo, hi)],
        "tracking_checks": O.tracking_checks(track, lo, hi),
        "window": {
            "first_frame": lo,
            "last_frame": hi,
            "before": {"expected": rules["window_before"], "kept": len(before)},
            "after": {"expected": rules["window_after"], "kept": len(after), "truncated_reason": truncated},
            "detected": window_counts["detected"],
            "interpolated": window_counts["interpolated"],
            "rejected": window_counts["rejected"],
            "invalid_steps": window_counts["invalid_steps"],
        },
        "image_speed": speed,
        "detected_ratio": result["features"].get("detected_ratio"),
        "interpolated_ratio": result["features"].get("interpolated_ratio"),
        "features": {key: features[key] for key in sorted(features)},
        "scores": result["scores"],
        "top3": result["top3"],
        "margin": result["margin"],
        "missing_features": result["missing_features"],
        "review_reasons": result["review_reasons"],
        "quality_warnings": result["quality_warnings"],
        "offset_labels": result["offset_labels"],
    }


def build_records(doc: Mapping, shuttle_doc: Mapping, *, job_id: str, run_id: str, config: Optional[Mapping] = None,
                  video: Optional[Mapping] = None, track: Optional[O.ObservedTrack] = None,
                  observed_config: Optional[O.Config] = None) -> tuple[list[dict], dict]:
    """Records in timeline order, one per shot of the match document, plus the inputs used.

    video is the analysis's own video block (width, height, fps). It is used only when the shuttle file lacks them.
    track is the sanitized track of the same shuttle file, when the caller already has it.
    """
    rules = dict(R.CONFIG if config is None else config)
    video = video or {}
    if track is None:
        track = O.sanitize(shuttle_doc, width=video.get("width"), height=video.get("height"),
                           fps=video.get("fps") or doc.get("fps"), config=observed_config or O.DEFAULT_CONFIG)
    shots = doc.get("shots", {}).get("items", [])
    if shots and (track.width <= 0 or track.height <= 0 or track.fps <= 0):
        raise R.PipelineIntegrityError(int(shots[0]["frame"]), "the analysis has no frame size or frame rate")
    speed_ref = O.speed_reference(track)
    court_calibrated = doc.get("court", {}).get("status") == "calibrated"
    records = [
        build_record(job_id=job_id, run_id=run_id, shot=shot, track=track, doc=doc, speed_ref=speed_ref,
                     court_calibrated=court_calibrated, config=rules)
        for shot in shots
    ]
    return records, {"fps": track.fps, "width": track.width, "height": track.height, "speed_ref_px_s": speed_ref,
                     "court_calibrated": court_calibrated, "observed_2d": track.summary(),
                     "config": {k: list(v) if isinstance(v, tuple) else v for k, v in rules.items()}}


def summarise(records: list[dict], inputs: dict) -> dict:
    labels = {cls: 0 for cls in R.CLASSES}
    tiers = {"full_trajectory": 0, "partial_trajectory": 0, "contact_fallback": 0}
    qualities = {"high": 0, "medium": 0, "low": 0}
    status = {"accepted_by_gate": 0, "needs_review": 0}
    reasons: dict[str, int] = {}
    for record in records:
        labels[record["best_guess_label"]] += 1
        tiers[record["evidence_tier"]] += 1
        qualities[record["evidence_quality"]] += 1
        status[record["review_status"]] += 1
        for reason in record["review_reasons"]:
            key = reason.split(" (")[0]
            reasons[key] = reasons.get(key, 0) + 1
    speeds = [record["image_speed"]["px_per_s"] for record in records if record["image_speed"]["px_per_s"] is not None]
    return {
        "schema": SCHEMA,
        "rule_version": R.RULE_VERSION,
        "observed_2d_version": O.VERSION,
        "records": len(records),
        "label_distribution": labels,
        "evidence_tier_distribution": tiers,
        "evidence_quality_distribution": qualities,
        "review_status": status,
        "review_reasons": sorted(reasons.items(), key=lambda kv: kv[1], reverse=True),
        "image_speed_px_s": {
            "unit": "px/s",
            "records_with_speed": len(speeds),
            "min": min(speeds) if speeds else None,
            "median": round(median(speeds), 1) if speeds else None,
            "max": max(speeds) if speeds else None,
            "note": "All timeline rows, candidates included. Official statistics use confirmed contacts only.",
        },
        "label_kind": "trajectory_estimate_unverified",
        "validation": "not evaluated: no ground truth",
        "inputs": inputs,
    }


def write_dataset(job_dir: str, *, job_id: str, doc: Mapping, shuttle_doc: Mapping, court_doc: Optional[Mapping],
                  video: Optional[Mapping] = None, track: Optional[O.ObservedTrack] = None,
                  records: Optional[list[dict]] = None, extra: Optional[Mapping] = None) -> dict:
    """Writes the JSONL dataset and summary. Replaces only files under derived/."""
    created = datetime.now(timezone.utc)
    run_id = f"{created.strftime('%Y%m%dT%H%M%SZ')}-{R.RULE_VERSION.replace('/', '-')}"
    built, meta = build_records(doc, shuttle_doc, job_id=job_id, run_id=run_id, video=video, track=track)
    if records is not None:
        built = [{**record, "run_id": run_id} for record in records]
    if len(built) != len(doc.get("shots", {}).get("items", [])):
        raise R.PipelineIntegrityError(0, "dataset rows do not match the shot timeline")
    inputs = {
        "shuttle_trajectory.json": _sha256(os.path.join(job_dir, "shuttle_trajectory.json")),
        "court_coordinates.json": _sha256(os.path.join(job_dir, "court_coordinates.json")),
    }
    summary = summarise(built, inputs)
    summary.update({
        "job_id": job_id,
        "run_id": run_id,
        "created_utc": created.isoformat(),
        "fps": meta["fps"],
        "frame_size": [meta["width"], meta["height"]],
        "speed_reference_px_s_p95": None if meta["speed_ref_px_s"] is None else round(meta["speed_ref_px_s"], 2),
        "court_calibrated": meta["court_calibrated"],
        "observed_2d": meta["observed_2d"],
        "config": meta["config"],
        **(dict(extra) if extra else {}),
    })
    os.makedirs(derived_dir(job_dir), exist_ok=True)
    tmp = dataset_path(job_dir) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        for record in built:
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=False) + "\n")
    os.replace(tmp, dataset_path(job_dir))
    with open(summary_path(job_dir) + ".tmp", "w", encoding="utf-8") as handle:
        json.dump(summary, handle, ensure_ascii=False, indent=2)
    os.replace(summary_path(job_dir) + ".tmp", summary_path(job_dir))
    return summary


def read_records(job_dir: str) -> Optional[list[dict]]:
    path = dataset_path(job_dir)
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def read_summary(job_dir: str) -> Optional[dict]:
    path = summary_path(job_dir)
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def by_frame(records: Iterable[dict]) -> dict[int, dict]:
    return {int(record["frame"]): record for record in records}
