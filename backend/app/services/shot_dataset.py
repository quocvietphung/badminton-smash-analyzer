"""Per-shot derived dataset: one trajectory-rules/v1 record for every row of the Shot timeline of one analysis.

Written to outputs/<job-id>/derived/ only. Raw TrackNet output, analysis.json, shots.json, model_execution.json and
corrections.json are never written here. The dataset can be rebuilt from the raw outputs with the same rule version.

Every record is for this job only: the shuttle trajectory and court calibration are read from this job's folder, and the
player positions come from this job's match document. Nothing is copied from another analysis or sample.
"""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from typing import Iterable, Mapping, Optional

from app.analytics import trajectory_rules as R

SCHEMA = "smashlab.shot-trajectory/v1"
DERIVED_DIR = "derived"
DATASET_FILE = "shot_trajectory_dataset.jsonl"
SUMMARY_FILE = "shot_trajectory_summary.json"
NEAREST_POSITION_FRAMES = 3
FEATURE_ALIASES = {
    "rise_norm": "rise_normalized",
    "flight_s": "observed_flight_s",
    "curvature_rad": "trajectory_curvature",
}


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
    best = None
    for item in series:
        pos_frame, x, y, state = item[0], item[1], item[2], item[3] if len(item) > 3 else None
        if x is None or y is None or state in ("lost", "uncertain"):
            continue
        gap = abs(int(pos_frame) - frame)
        if gap <= NEAREST_POSITION_FRAMES and (best is None or gap < best[0]):
            best = (gap, float(x), float(y))
    return None if best is None else (best[1], best[2])


def _camel(name: str) -> str:
    return FEATURE_ALIASES.get(name, name)


def _points(track: Mapping[int, R.Point], lo: int, hi: int, fps: float) -> list[dict]:
    out = []
    for frame in range(lo, hi + 1):
        point = track.get(frame)
        if point is None:
            continue
        out.append({
            "frame": frame,
            "time_s": round(frame / fps, 3),
            "x_px": round(point.x, 2),
            "y_px": round(point.y, 2),
            "confidence": round(point.confidence, 4),
            "interpolated": point.interpolated,
        })
    return out


def build_record(*, job_id: str, run_id: str, shot: Mapping, track: Mapping[int, R.Point], doc: Mapping,
                 fps: float, width: int, height: int, speed_ref: Optional[float], court_calibrated: bool) -> dict:  # noqa: C901
    frame = int(shot["frame"])
    player = shot.get("player")
    foot = player_foot(doc, player, frame)
    result = R.classify_contact(
        track, frame, fps=fps, width=width, height=height, speed_ref=speed_ref,
        player_foot=foot, court_calibrated=court_calibrated, contact_status=shot.get("contact_status", "candidate"),
    )
    features = {_camel(name): value for name, value in result["features"].items()}
    contact_point = track.get(frame)
    if contact_point is None:
        near = [track[f] for f in (frame - 2, frame - 1, frame + 1, frame + 2) if f in track]
        contact_point = near[0] if near else None
    before = _points(track, frame - R.CONFIG["window_before"], frame - 1, fps)
    after = _points(track, frame + 1, frame + R.CONFIG["window_after"], fps)
    distance = result["features"].get("contact_net_m")
    return {
        "schema": SCHEMA,
        "job_id": job_id,
        "run_id": run_id,
        "shot_id": f"{job_id}-frame-{frame}",
        "frame": frame,
        "timestamp_s": round(frame / fps, 3),
        "player": player,
        "contact_status": shot.get("contact_status", "candidate"),
        "best_guess_label": result["best_guess_label"],
        "review_status": result["review_status"],
        "evidence_tier": result["evidence_tier"],
        "evidence_quality": result["evidence_quality"],
        "rule_version": R.RULE_VERSION,
        "frame_size": [width, height],
        "label_kind": "trajectory_estimate_unverified",
        "manual_label": shot.get("type") if shot.get("type_source") == "manual" else None,
        "contact_image": {
            "x_px": None if contact_point is None else round(contact_point.x, 2),
            "y_px": None if contact_point is None else round(contact_point.y, 2),
            "x_normalized": result["features"].get("contact_x_norm"),
            "y_normalized": result["features"].get("contact_y_norm"),
        },
        "player_court_context": {
            "court_calibrated": court_calibrated,
            "player_side": result["features"].get("player_side"),
            "player_foot_x_m": foot[0] if foot else None,
            "player_foot_y_m": foot[1] if foot else None,
            "distance_to_net_m": distance,
            "relative_to_net": relative_to_net(distance),
        },
        "trajectory_before": before,
        "trajectory_after": after,
        "features": {key: features[key] for key in sorted(features)},
        "scores": result["scores"],
        "top3": result["top3"],
        "missing_features": result["missing_features"],
        "review_reasons": result["review_reasons"],
        "quality_warnings": result["quality_warnings"],
        "offset_labels": result["offset_labels"],
    }


def build_records(doc: Mapping, shuttle_doc: Mapping, *, job_id: str, run_id: str, config: Optional[Mapping] = None,
                  video: Optional[Mapping] = None) -> tuple[list[dict], dict]:
    """Records in timeline order, one per shot of the match document, plus the inputs used.

    video is the analysis's own video block (width, height, fps). It is used only when the shuttle file lacks them.
    """
    settings = dict(R.CONFIG if config is None else config)
    video = video or {}
    fps = float(shuttle_doc.get("fps") or video.get("fps") or doc.get("fps") or 30.0)
    width = int(shuttle_doc.get("source_width") or video.get("width") or 0)
    height = int(shuttle_doc.get("source_height") or video.get("height") or 0)
    shots = doc.get("shots", {}).get("items", [])
    if shots and (width <= 0 or height <= 0 or fps <= 0):
        raise R.PipelineIntegrityError(int(shots[0]["frame"]), "the analysis has no frame size or frame rate")
    track = R.build_track(shuttle_doc, conf_threshold=float(settings["conf_threshold"]), smoothing=int(settings["smoothing"]))
    speed_ref = R.video_speed_reference(track, fps)
    court_calibrated = doc.get("court", {}).get("status") == "calibrated"
    records = []
    for shot in doc.get("shots", {}).get("items", []):
        records.append(build_record(job_id=job_id, run_id=run_id, shot=shot, track=track, doc=doc, fps=fps, width=width,
                                    height=height, speed_ref=speed_ref, court_calibrated=court_calibrated))
    return records, {"fps": fps, "width": width, "height": height, "speed_ref_px_s": speed_ref,
                     "court_calibrated": court_calibrated, "config": {k: list(v) if isinstance(v, tuple) else v for k, v in settings.items()}}


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
    return {
        "schema": SCHEMA,
        "rule_version": R.RULE_VERSION,
        "records": len(records),
        "label_distribution": labels,
        "evidence_tier_distribution": tiers,
        "evidence_quality_distribution": qualities,
        "review_status": status,
        "review_reasons": sorted(reasons.items(), key=lambda kv: kv[1], reverse=True),
        "label_kind": "trajectory_estimate_unverified",
        "validation": "not validated: no ground-truth evaluation",
        "inputs": inputs,
    }


def write_dataset(job_dir: str, *, job_id: str, doc: Mapping, shuttle_doc: Mapping, court_doc: Optional[Mapping],
                  video: Optional[Mapping] = None) -> dict:
    """Writes the JSONL dataset and summary. Replaces only files under derived/."""
    created = datetime.now(timezone.utc)
    run_id = f"{created.strftime('%Y%m%dT%H%M%SZ')}-{R.RULE_VERSION.replace('/', '-')}"
    records, meta = build_records(doc, shuttle_doc, job_id=job_id, run_id=run_id, video=video)
    if len(records) != len(doc.get("shots", {}).get("items", [])):
        raise R.PipelineIntegrityError(0, "dataset rows do not match the shot timeline")
    inputs = {
        "shuttle_trajectory.json": _sha256(os.path.join(job_dir, "shuttle_trajectory.json")),
        "court_coordinates.json": _sha256(os.path.join(job_dir, "court_coordinates.json")),
    }
    summary = summarise(records, inputs)
    summary.update({
        "job_id": job_id,
        "run_id": run_id,
        "created_utc": created.isoformat(),
        "fps": meta["fps"],
        "frame_size": [meta["width"], meta["height"]],
        "speed_reference_px_s_p95": None if meta["speed_ref_px_s"] is None else round(meta["speed_ref_px_s"], 2),
        "court_calibrated": meta["court_calibrated"],
        "config": meta["config"],
    })
    os.makedirs(derived_dir(job_dir), exist_ok=True)
    tmp = dataset_path(job_dir) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        for record in records:
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
