"""The match document of one analysis, with its per-shot trajectory dataset attached.

Used by the API (read) and by the worker (write of derived/ files right after an analysis completes). Both go through
the same functions and the same sanitized observed-2d/v1 track, so the timeline shown in the studio, the dashboard
numbers and the exported dataset always describe the same contacts with the same values.

Three tiers are written apart under derived/:
- Observed 2D: shot_trajectory_dataset.jsonl and shot_trajectory_summary.json (image pixels, px/s);
- Estimated 3D: estimated_3d.json (one camera, experimental, gated; "rejected" unless every gate passes);
- Measured 3D: measured_3d.json ("not_run" without two synchronised cameras).
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from typing import Optional

from app.analytics import observed2d as O
from app.analytics import trajectory_rules as R
from app.analytics.match import SIX_CLASSES, build_match_document
from app.physics import stereo
from app.physics.camera import camera_from_document
from app.physics.speed3d import SCHEMA as ESTIMATED_3D_SCHEMA, estimate_monocular
from app.services import corrections as corrections_service
from app.services import sessions as sessions_service
from app.services import shot_dataset

SESSION_TRANSFER_TYPES = ("contact_review", "shot_label", "hit_frame", "rally_boundary")
ESTIMATED_3D_FILE = "estimated_3d.json"
MEASURED_3D_FILE = "measured_3d.json"


def _optional_json(output_dir: str, name: str) -> Optional[dict]:
    try:
        with open(os.path.join(output_dir, name), encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _read_results(output_dir: str) -> dict:
    return _optional_json(output_dir, "results.json") or {}


def _shuttle_or_empty(job) -> dict:
    """The job's shuttle file. A job without one has no shuttle data, so it has no contact rows and an empty dataset."""
    shuttle = _optional_json(job.output_dir, "shuttle_trajectory.json")
    if shuttle is not None:
        return shuttle
    video = _read_results(job.output_dir).get("video", {})
    return {"frames": [], "fps": video.get("fps"), "source_width": video.get("width"), "source_height": video.get("height")}


def observed_track(job) -> O.ObservedTrack:
    """The one sanitized shuttle track of this job (observed-2d/v1). The raw file is only read."""
    video = _read_results(job.output_dir).get("video", {})
    return O.sanitize(_shuttle_or_empty(job), width=video.get("width"), height=video.get("height"), fps=video.get("fps"))


def session_corrections(store, job, *, include_pending: bool = False) -> Optional[list]:
    """Earlier corrections offered to the active analysis, including a rerun while its dataset is being built.

    A running rerun is not yet the session's active completed analysis. The worker still needs the same transferred
    corrections that the rerun will receive immediately after completion, otherwise its saved dataset can disagree
    with the Shot timeline. Historical completed analyses continue to show only their own corrections.
    """
    jobs = store.list_jobs(500)
    key = sessions_service.session_key(job)
    pending_rerun = include_pending and job.status in sessions_service.ACTIVE_STATES
    if not pending_rerun:
        completed = [item for item in jobs if item.status == "completed" and sessions_service.session_key(item) == key]
        active = max(completed, key=lambda item: (item.finished_at or 0.0, item.created_at), default=None)
        if active is None or active.id != job.id:
            return None
    offered: list[dict] = []
    for other in sessions_service.completed_jobs_for(jobs, key, exclude_id=job.id):
        for entry in corrections_service.load(other.output_dir).get("entries", []):
            if entry.get("type") in SESSION_TRANSFER_TYPES:
                offered.append({**entry, "source_job_id": other.id})
    return offered


def assemble(store, job, trajectory: Optional[dict] = None, *, include_pending_session_corrections: bool = False,
             track: Optional[O.ObservedTrack] = None, estimated_3d: Optional[dict] = None,
             compute_estimated_3d: bool = True) -> dict:
    """The match document of this job. trajectory maps a contact frame to its dataset record, or is None."""
    return build_match_document(
        job_id=job.id,
        results=_read_results(job.output_dir),
        tracks_doc=_optional_json(job.output_dir, "player_tracks.json"),
        shuttle_doc=_optional_json(job.output_dir, "shuttle_trajectory.json"),
        rallies_doc=_optional_json(job.output_dir, "rallies.json"),
        corrections=corrections_service.load(job.output_dir).get("entries", []),
        metrics=_optional_json(job.output_dir, "metrics.json"),
        model_execution=_optional_json(job.output_dir, "model_execution.json"),
        court_doc=_optional_json(job.output_dir, "court_coordinates.json"),
        session_corrections=session_corrections(store, job, include_pending=include_pending_session_corrections),
        trajectory=trajectory,
        estimated_3d=estimated_3d,
        track=track if track is not None else observed_track(job),
        compute_estimated_3d=compute_estimated_3d,
    )


def estimated_3d_map(job, doc: dict, track: O.ObservedTrack) -> dict[int, dict]:
    """Estimated 3D of every timeline row. Without an independent 3D camera every row is rejected before any fit."""
    court_doc = _optional_json(job.output_dir, "court_coordinates.json")
    contacts = {contact["id"]: contact for contact in doc.get("contacts", {}).get("items", [])}
    shots = doc.get("shots", {}).get("items", [])
    out: dict[int, dict] = {}
    for index, shot in enumerate(shots):
        next_frame = shots[index + 1]["frame"] if index + 1 < len(shots) else None
        out[int(shot["frame"])] = estimate_monocular(contact=contacts.get(shot["contact_id"]), track=track, court_doc=court_doc,
                                                     next_contact_frame=next_frame)
    return out


def _stored_estimated_3d(job, track: O.ObservedTrack) -> Optional[dict[int, dict]]:
    """The worker's Estimated 3D file, used when an independent camera makes a live fit expensive."""
    court_doc = _optional_json(job.output_dir, "court_coordinates.json")
    camera, _diagnostic = camera_from_document(court_doc, track.width, track.height)
    if camera is None:
        return None  # rejected before any fit: cheap and always current
    stored = _optional_json(os.path.join(job.output_dir, shot_dataset.DERIVED_DIR), ESTIMATED_3D_FILE)
    if not stored or stored.get("observed_2d_version") != O.VERSION:
        return None
    return {int(frame): value for frame, value in (stored.get("shots") or {}).items()}


def for_job(store, job) -> dict:
    """The match document with each shot's trajectory estimate attached. Nothing is written."""
    track = observed_track(job)
    stored_3d = _stored_estimated_3d(job, track)
    base = assemble(store, job, None, track=track, compute_estimated_3d=False)
    if not base.get("shots", {}).get("items"):
        return assemble(store, job, None, track=track, estimated_3d=stored_3d)
    video = _read_results(job.output_dir).get("video", {})
    records, _meta = shot_dataset.build_records(base, _shuttle_or_empty(job), job_id=job.id, run_id="not-written", video=video,
                                                track=track)
    return assemble(store, job, shot_dataset.by_frame(records), track=track, estimated_3d=stored_3d)


def parity_problems(doc: dict, records: list[dict], track: O.ObservedTrack) -> list[str]:
    """Quality gates: each Shot timeline row matches exactly one dataset record, with the same values."""
    problems: list[str] = []
    shots = doc.get("shots", {}).get("items", [])
    if len(records) != len(shots):
        problems.append(f"{len(records)} dataset records for {len(shots)} timeline rows")
    rejected_frames = {item.frame for item in track.rejected}
    last_frame = track.last_frame
    for shot, record in zip(shots, records):
        where = f"timeline row {shot.get('id')} (frame {shot.get('frame')})"
        checks = {
            "shot id": (record.get("shot_id"), shot.get("shot_id")),
            "timeline id": (record.get("timeline_id"), shot.get("id")),
            "frame": (record.get("frame"), shot.get("frame")),
            "player": (record.get("player"), shot.get("player")),
            "contact status": (record.get("contact_status"), shot.get("contact_status")),
            "label": (record.get("label"), shot.get("type")),
            "px/s": ((record.get("image_speed") or {}).get("px_per_s"), (shot.get("speed") or {}).get("px_per_s")),
            "quality": (record.get("evidence_quality"), (shot.get("trajectory") or {}).get("evidence_quality")),
        }
        for name, (left, right) in checks.items():
            if left != right:
                problems.append(f"{where}: {name} differs ({left!r} in the dataset, {right!r} on the timeline)")
        if abs(float(record.get("timestamp_s", -1)) - float(shot.get("time_s", -2))) > 1e-6:
            problems.append(f"{where}: timestamp differs")
        if abs(float(record.get("timestamp_s", -1)) - track.time_of(int(record.get("frame", 0)))) > 0.0015:
            problems.append(f"{where}: timestamp does not match the video timestamp of its frame")
        if shot.get("type") not in SIX_CLASSES:
            problems.append(f"{where}: label {shot.get('type')!r} is outside the six classes")
        if record.get("best_guess_label") not in SIX_CLASSES:
            problems.append(f"{where}: best_guess_label outside the six classes")
        used = set((record.get("image_speed") or {}).get("frames") or [])
        if used & rejected_frames:
            problems.append(f"{where}: its px/s uses frames the sanitizer rejected {sorted(used & rejected_frames)}")
        if last_frame is not None and not 0 <= int(shot.get("frame", -1)) <= last_frame:
            problems.append(f"{where}: frame outside the video")
    official = [shot["speed"]["px_per_s"] for shot in shots
                if shot.get("speed") and shot["speed"].get("basis") == "confirmed_contact" and shot["speed"]["px_per_s"] is not None]
    summary = (doc.get("summary", {}) or {}).get("speed", {}) or {}
    if (summary.get("official") or {}).get("max_px_per_s") != (max(official) if official else None):
        problems.append("official speed summary does not equal the confirmed timeline rows")
    if any(shot.get("contact_status") != "confirmed" for shot in shots
           if shot.get("speed") and shot["speed"].get("basis") == "confirmed_contact"):
        problems.append("a candidate contact entered the official speed basis")
    return problems


def write_for_job(store, job) -> dict:
    """Builds every derived file of this job under derived/. Called once the analysis has completed."""
    stages: dict[str, float] = {}

    def timed(name: str, function):
        began = time.perf_counter()
        value = function()
        stages[name] = round(time.perf_counter() - began, 4)
        return value

    track = timed("trajectory_sanitization", lambda: observed_track(job))
    shuttle_doc = _shuttle_or_empty(job)
    court_doc = _optional_json(job.output_dir, "court_coordinates.json")
    video = _read_results(job.output_dir).get("video", {})
    base = timed("contact_candidates_and_timeline", lambda: assemble(
        store, job, None, include_pending_session_corrections=True, track=track, compute_estimated_3d=False))
    records, _meta = timed("trajectory_features_and_six_class_scoring", lambda: shot_dataset.build_records(
        base, shuttle_doc, job_id=job.id, run_id="pending", video=video, track=track))
    estimated = timed("estimated_3d", lambda: estimated_3d_map(job, base, track))
    full = timed("dashboard_summary", lambda: assemble(
        store, job, shot_dataset.by_frame(records), include_pending_session_corrections=True, track=track, estimated_3d=estimated))
    problems = timed("quality_gates", lambda: parity_problems(full, records, track))
    if problems:
        raise R.PipelineIntegrityError(0, "; ".join(problems[:6]))
    target = os.path.join(job.output_dir, shot_dataset.DERIVED_DIR)
    os.makedirs(target, exist_ok=True)
    began = time.perf_counter()
    available = sum(1 for value in estimated.values() if value.get("status") == "available")
    reasons: dict[str, int] = {}
    for value in estimated.values():
        for reason in value.get("rejection_reasons", []):
            reasons[reason] = reasons.get(reason, 0) + 1
    _write_json(os.path.join(target, ESTIMATED_3D_FILE), {
        "schema": ESTIMATED_3D_SCHEMA,
        "job_id": job.id,
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "observed_2d_version": O.VERSION,
        "mode": "estimated_monocular",
        "label": "Estimated 3D — monocular experimental",
        "summary": {"shots": len(estimated), "available": available, "rejected": len(estimated) - available,
                    "rejection_reasons": dict(sorted(reasons.items()))},
        "shots": {str(frame): value for frame, value in sorted(estimated.items())},
    })
    _write_json(os.path.join(target, MEASURED_3D_FILE), {**stereo.not_run_summary(), "job_id": job.id})
    summary = shot_dataset.write_dataset(
        job.output_dir, job_id=job.id, doc=base, shuttle_doc=shuttle_doc, court_doc=court_doc, video=video, track=track,
        records=records,
        extra={
            "quality_gates": {"passed": True, "checks": ["one record per timeline row", "shot id, frame, timestamp, player, contact status, "
                              "label, px/s and quality equal", "labels within the six classes", "no rejected frame in a px/s",
                              "official speed from confirmed contacts only", "timestamps equal the video timestamps"]},
            "estimated_3d": {"available": available, "rejected": len(estimated) - available, "rejection_reasons": reasons},
            "measured_3d": stereo.not_run_summary(),
            "official_speed": (full.get("summary", {}).get("speed", {}) or {}).get("official"),
            "candidate_speed": (full.get("summary", {}).get("speed", {}) or {}).get("candidates"),
        },
    )
    stages["dataset_write"] = round(time.perf_counter() - began, 4)
    summary["derived_stage_seconds"] = stages
    with open(shot_dataset.summary_path(job.output_dir), "w", encoding="utf-8") as handle:
        json.dump(summary, handle, ensure_ascii=False, indent=2)
    return summary


def _write_json(path: str, payload: dict) -> None:
    with open(path + ".tmp", "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    os.replace(path + ".tmp", path)


def coach_dataset_for(store, job) -> dict:
    """The coach-dataset/v1 document of this job, built from this job's files only. Also written under derived/."""
    from app.services import coach_dataset

    track = observed_track(job)
    stored_3d = _stored_estimated_3d(job, track)
    doc = assemble(store, job, None, track=track, compute_estimated_3d=False)
    results = _read_results(job.output_dir)
    video = results.get("video", {})
    shuttle_doc = _shuttle_or_empty(job)
    records, _meta = shot_dataset.build_records(doc, shuttle_doc, job_id=job.id, run_id="live", video=video, track=track)
    fps = float(video.get("fps") or shuttle_doc.get("fps") or doc.get("fps") or 30.0)
    dataset = coach_dataset.build(
        job_id=job.id,
        match_doc=assemble(store, job, shot_dataset.by_frame(records), track=track, estimated_3d=stored_3d),
        records=records,
        tracks_doc=_optional_json(job.output_dir, "player_tracks.json"),
        results=results,
        fps=fps,
    )
    target = os.path.join(job.output_dir, "derived")
    os.makedirs(target, exist_ok=True)
    with open(os.path.join(target, "coach_dataset.json"), "w", encoding="utf-8") as handle:
        json.dump(dataset, handle, ensure_ascii=False, indent=2)
    return dataset
