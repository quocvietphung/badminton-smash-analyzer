"""The match document of one analysis, with its per-shot trajectory dataset attached.

Used by the API (read) and by the worker (write of derived/ files right after an analysis completes). Both go through
the same functions, so the timeline shown in the studio and the exported dataset always describe the same contacts.
"""

from __future__ import annotations

import json
import os
from typing import Optional

from app.analytics.match import build_match_document
from app.services import corrections as corrections_service
from app.services import sessions as sessions_service
from app.services import shot_dataset

SESSION_TRANSFER_TYPES = ("contact_review", "shot_label", "hit_frame", "rally_boundary")


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


def assemble(store, job, trajectory: Optional[dict] = None, *, include_pending_session_corrections: bool = False) -> dict:
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
    )


def for_job(store, job) -> dict:
    """The match document with each shot's trajectory estimate attached. Nothing is written."""
    base = assemble(store, job, None)
    if not base.get("shots", {}).get("items"):
        return base
    shuttle_doc = _shuttle_or_empty(job)
    video = _read_results(job.output_dir).get("video", {})
    records, _meta = shot_dataset.build_records(base, shuttle_doc, job_id=job.id, run_id="not-written", video=video)
    return assemble(store, job, shot_dataset.by_frame(records))


def write_for_job(store, job) -> dict:
    """Builds the trajectory dataset of this job and writes it under derived/. Called once the analysis has completed."""
    base = assemble(store, job, None, include_pending_session_corrections=True)
    shuttle_doc = _shuttle_or_empty(job)
    court_doc = _optional_json(job.output_dir, "court_coordinates.json")
    video = _read_results(job.output_dir).get("video", {})
    return shot_dataset.write_dataset(job.output_dir, job_id=job.id, doc=base, shuttle_doc=shuttle_doc, court_doc=court_doc, video=video)


def coach_dataset_for(store, job) -> dict:
    """The coach-dataset/v1 document of this job, built from this job's files only. Also written under derived/."""
    from app.services import coach_dataset

    doc = assemble(store, job, None)
    results = _read_results(job.output_dir)
    video = results.get("video", {})
    shuttle_doc = _shuttle_or_empty(job)
    records, _meta = shot_dataset.build_records(doc, shuttle_doc, job_id=job.id, run_id="live", video=video)
    fps = float(video.get("fps") or shuttle_doc.get("fps") or doc.get("fps") or 30.0)
    dataset = coach_dataset.build(
        job_id=job.id,
        match_doc=assemble(store, job, shot_dataset.by_frame(records)),
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
