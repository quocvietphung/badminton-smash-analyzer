"""HTTP API for local analyses. All paths are under /api/v1 except /health."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import threading
import uuid
from typing import Iterator, Optional

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse

from app.analytics import trajectory_rules as R
from app.pipeline.media import MediaError, probe_video
from app.pipeline.runner import AnalysisRunner, PipelineOptions
from app.services import corrections as corrections_service
from app.services import match_document
from app.services import sessions as sessions_service
from app.services import shot_dataset
from app.services.evaluation import summarise_jobs
from app.services.samples import list_samples, load_manifest, resolve_sample
from app.services.thumbnails import make_thumbnail
from app.services.access import AccessDenied, authorize, issue_upload_ticket
from app.services.uploads import UploadRejected, check_filename, save_upload

def _authorize(request: Request, *, allow_upload_ticket: bool = False) -> None:
    """401 unless the request carries the API token, or (for an upload) a valid single-use upload ticket."""
    try:
        authorize(
            request.headers,
            request.app.state.settings.api_token,
            request.app.state.upload_tickets,
            allow_upload_ticket=allow_upload_ticket,
        )
    except AccessDenied:
        raise _error(401, "auth_required", "Send the API token, or a valid upload ticket for an upload.") from None


def _guard(request: Request) -> None:
    """Every route in this router is protected. Only the analysis upload also accepts an upload ticket."""
    allow_ticket = request.method == "POST" and request.url.path == "/api/v1/analyses"
    _authorize(request, allow_upload_ticket=allow_ticket)


router = APIRouter(dependencies=[Depends(_guard)])
JOB_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")
ARTIFACTS = {
    "annotated.mp4": "video/mp4",
    "results.json": "application/json",
    "analysis.json": "application/json",
    "analysis_report.json": "application/json",
    "player_tracks.json": "application/json",
    "identity_events.json": "application/json",
    "rallies.json": "application/json",
    "shots.json": "application/json",
    "shuttle_trajectory.json": "application/json",
    "court_coordinates.json": "application/json",
    "metrics.json": "application/json",
    "inference_report.json": "application/json",
    "model_execution.json": "application/json",
}
MODES = ("auto", "singles", "doubles")
CORRECTION_LOCK = threading.Lock()
RANGE_PATTERN = re.compile(r"^bytes=(\d*)-(\d*)$")
CHUNK = 1024 * 1024


def _error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def _job_or_404(request: Request, job_id: str):
    if not JOB_ID_PATTERN.match(job_id):
        raise _error(404, "unknown_job", "No analysis exists with this id.")
    job = request.app.state.store.get_job(job_id)
    if job is None:
        raise _error(404, "unknown_job", "No analysis exists with this id.")
    return job


def _safe_name(filename: Optional[str]) -> str:
    base = os.path.basename(filename or "upload")
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", base)[:80]
    return cleaned or "upload"


def _job_payload(job, base: str) -> dict:
    error = None
    if job.status == "failed":
        error = {"code": job.error_code, "message": job.error_message}
    payload = {
        "job_id": job.id,
        "status": job.status,
        "stage": job.stage,
        "progress": round(job.progress, 4),
        "attempts": job.attempts,
        "created_at": job.created_at,
        "started_at": job.started_at,
        "finished_at": job.finished_at,
        "source": {"kind": job.source_kind, "name": job.source_name, "sample_id": _sample_id(job)},
        "error": error,
        "status_url": f"{base}/api/v1/analyses/{job.id}",
        "results_url": f"{base}/api/v1/analyses/{job.id}/results" if job.status == "completed" else None,
    }
    return payload


def _results_summary(output_dir: str) -> Optional[dict]:
    """Derived summary of a completed analysis for the saved-sessions list. No video, no frames."""
    try:
        with open(os.path.join(output_dir, "results.json"), encoding="utf-8") as handle:
            results = json.load(handle)
        return {
            "frames": results["video"]["frames_analysed"],
            "fps": results["video"]["fps"],
            "court_status": results["court"]["status"],
            "court_score": results["court"].get("score"),
            "tracks_confirmed": results["players"]["tracks_confirmed"],
            "max_players": results["players"]["max_concurrent_confirmed"],
            "shuttle_detected": results["shuttle"]["frames_detected"],
            "shuttle_interpolated": results["shuttle"]["frames_interpolated"],
            "shuttle_visible_ratio": results["shuttle"]["visible_ratio"],
            "rally_status": results["rally_segmentation"]["status"],
            "shots_status": results["shot_classification"]["status"],
        }
    except (OSError, ValueError, KeyError, TypeError):
        return None


def _sample_id(job) -> Optional[str]:
    """The server-side sample id for sample analyses. Uploads never expose a file name or path here."""
    return job.source_detail if job.source_kind == "sample" else None


def _job_summary(job) -> dict:
    return {
        "job_id": job.id,
        "status": job.status,
        "stage": job.stage,
        "progress": round(job.progress, 3),
        "created_at": job.created_at,
        "finished_at": job.finished_at,
        "source": {"kind": job.source_kind, "name": job.source_name, "sample_id": _sample_id(job)},
        "error": {"code": job.error_code, "message": job.error_message} if job.status == "failed" else None,
        "summary": _results_summary(job.output_dir) if job.status == "completed" else None,
    }


@router.get("/api/v1/samples")
async def get_samples(request: Request):
    settings = request.app.state.settings
    return {"samples": list_samples(settings.input_dir, settings.samples_manifest)}


@router.get("/api/v1/samples/{sample_id}/video")
async def get_sample_video(request: Request, sample_id: str):
    """The sample itself, for the original-video player before an analysis. Byte ranges supported."""
    settings = request.app.state.settings
    resolved = resolve_sample(settings.input_dir, settings.samples_manifest, sample_id)
    if resolved is None:
        raise _error(404, "unknown_sample", "The requested sample is not in the manifest.")
    _, path = resolved
    if not path:
        raise _error(409, "sample_missing", "The sample file is not on disk.")
    return _file_response(request, path, "video/mp4")


@router.get("/api/v1/samples/{sample_id}/thumbnail")
async def get_sample_thumbnail(request: Request, sample_id: str):
    settings = request.app.state.settings
    resolved = resolve_sample(settings.input_dir, settings.samples_manifest, sample_id)
    if resolved is None:
        raise _error(404, "unknown_sample", "The requested sample is not in the manifest.")
    _, path = resolved
    if not path:
        raise _error(409, "sample_missing", "The sample file is not on disk.")
    try:
        image = make_thumbnail(path)
    except MediaError as exc:
        raise _error(422, exc.code, exc.message) from exc
    return Response(content=image, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})


@router.post("/api/v1/upload-tickets")
async def create_upload_ticket(request: Request):
    """A short-lived, single-use permission to send one video straight to this API. Browsers cannot send large
    bodies through serverless functions, so the studio requests a ticket and then uploads directly."""
    settings = request.app.state.settings
    if settings.api_token is None:
        return {"ticket": None, "expires_at": None, "max_bytes": settings.max_upload_bytes, "mode": "local"}
    ticket, expires_at = issue_upload_ticket(settings.api_token, settings.ticket_ttl_s)
    return {"ticket": ticket, "expires_at": expires_at, "max_bytes": settings.max_upload_bytes, "mode": "token"}


@router.post("/api/v1/analyses", status_code=202)
async def create_analysis(
    request: Request,
    file: Optional[UploadFile] = File(None),
    sample_id: Optional[str] = Form(None),
    mode: str = Form("auto"),
):
    settings = request.app.state.settings
    store = request.app.state.store
    if (file is None or not file.filename) == (not sample_id):
        raise _error(400, "invalid_request", "Send exactly one of: a video file, or a sample_id.")
    if mode not in MODES:
        raise _error(400, "invalid_mode", "mode must be one of: auto, singles, doubles.")

    job_id = uuid.uuid4().hex
    output_dir = os.path.join(settings.outputs_dir, job_id)
    try:
        if sample_id:
            resolved = resolve_sample(settings.input_dir, settings.samples_manifest, sample_id)
            if resolved is None:
                raise _error(404, "unknown_sample", "The requested sample is not in the manifest.")
            entry, path = resolved
            if not path:
                raise _error(409, "sample_missing", "The sample file is not on disk. Run scripts/download-test-data.sh first.")
            sample_digest = _sha256_file(path)
            busy = sessions_service.running_job_for(store.list_jobs(500), f"video:{sample_digest}")
            if busy is not None:
                raise _error(409, "analysis_running", f"An analysis of this sample is already {busy.status} ({busy.id}). Wait for it to finish.")
            input_path = path
            source_kind, source_name, source_detail = "sample", entry["title"], sample_id
        else:
            check_filename(file.filename)
            suffix = os.path.splitext(file.filename)[1].lower()
            input_path = os.path.join(output_dir, "input", f"input{suffix}")
            size = await save_upload(file, input_path, settings.max_upload_bytes)
            digest = _sha256_file(input_path)
            _write_sha256(output_dir, digest)
            busy = sessions_service.running_job_for(store.list_jobs(500), f"video:{digest}")
            if busy is not None:
                raise _error(409, "analysis_running", f"An analysis of this video is already {busy.status} ({busy.id}). Wait for it to finish.")
            source_kind, source_name, source_detail = "upload", _safe_name(file.filename), f"{size} bytes"
        try:
            info = probe_video(input_path)
        except MediaError as exc:
            raise _error(422, exc.code, exc.message) from exc
        if info.duration_s > settings.max_duration_s:
            raise _error(422, "video_too_long", f"Videos must be at most {settings.max_duration_s:.0f} seconds long.")
    except UploadRejected as exc:
        shutil.rmtree(output_dir, ignore_errors=True)
        raise _error(exc.status_code, exc.code, exc.message) from exc
    except HTTPException:
        if not sample_id:
            shutil.rmtree(output_dir, ignore_errors=True)
        raise

    os.makedirs(output_dir, exist_ok=True)
    if sample_id:
        _write_sha256(output_dir, sample_digest)
    if mode != "auto":
        corrections_service.append(
            output_dir,
            job_id,
            {"type": "mode", "mode": mode, "note": "chosen when the analysis was started"},
            frames_total=0,
            width=0,
            height=0,
            players=2,
        )
    job = store.create_job(job_id, source_kind, source_name, source_detail, input_path, output_dir)
    store.enqueue(job_id)
    return JSONResponse(status_code=202, content=_job_payload(job, str(request.base_url).rstrip("/")))


@router.get("/api/v1/analyses")
async def list_analyses(request: Request, limit: int = 20):
    """Saved analyses, newest first. Returns summaries only, never video."""
    store = request.app.state.store
    bounded = max(1, min(limit, 100))
    return {"analyses": [_job_summary(job) for job in store.list_jobs(bounded)]}


@router.get("/api/v1/analyses/{job_id}")
async def get_analysis(request: Request, job_id: str):
    job = _job_or_404(request, job_id)
    return _job_payload(job, str(request.base_url).rstrip("/"))


@router.get("/api/v1/analyses/{job_id}/results")
async def get_results(request: Request, job_id: str):
    job = _job_or_404(request, job_id)
    if job.status == "failed":
        raise _error(409, "analysis_failed", job.error_message or "The analysis failed.")
    if job.status != "completed":
        raise _error(409, "not_ready", f"The analysis is {job.status}.")
    path = os.path.join(job.output_dir, "results.json")
    if not os.path.isfile(path):
        raise _error(500, "results_missing", "The results file is missing for this completed job.")
    with open(path, encoding="utf-8") as handle:
        return JSONResponse(json.load(handle))


@router.get("/api/v1/analyses/{job_id}/artifacts/{name}")
async def get_artifact(request: Request, job_id: str, name: str):
    job = _job_or_404(request, job_id)
    if name not in ARTIFACTS:
        raise _error(404, "unknown_artifact", "This file is not published for analyses.")
    if job.status != "completed":
        raise _error(409, "not_ready", f"The analysis is {job.status}.")
    path = os.path.join(job.output_dir, name)
    if not os.path.isfile(path):
        raise _error(404, "unknown_artifact", "The file was not produced for this analysis.")
    return _file_response(request, path, ARTIFACTS[name])


@router.get("/api/v1/analyses/{job_id}/source")
async def get_source_video(request: Request, job_id: str):
    """The video that was analysed: a sample from the read-only data folder, or the local upload copy."""
    job = _job_or_404(request, job_id)
    if not job.input_path or not os.path.isfile(job.input_path):
        raise _error(404, "unknown_artifact", "The source video is not available for this analysis.")
    media_type = "video/quicktime" if job.input_path.lower().endswith(".mov") else "video/mp4"
    return _file_response(request, job.input_path, media_type)


def _read_results(output_dir: str) -> dict:
    path = os.path.join(output_dir, "results.json")
    if not os.path.isfile(path):
        raise _error(500, "results_missing", "The results file is missing for this completed job.")
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def _optional_json(output_dir: str, name: str) -> Optional[dict]:
    path = os.path.join(output_dir, name)
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


@router.get("/api/v1/analyses/{job_id}/coach-dataset")
def get_coach_dataset(request: Request, job_id: str):
    """The analysis data the AI Coach reasons over: P1/P2 movement, the shot timeline and estimates. This job only."""
    job = _job_or_404(request, job_id)
    if job.status != "completed":
        raise _error(409, "not_ready", f"The analysis is {job.status}.")
    return JSONResponse(match_document.coach_dataset_for(request.app.state.store, job))


@router.get("/api/v1/analyses/{job_id}/export.json")
def export_analysis_json(request: Request, job_id: str):
    """The one export of a completed analysis: the coach dataset as a JSON file."""
    job = _job_or_404(request, job_id)
    if job.status != "completed":
        raise _error(409, "not_ready", f"The analysis is {job.status}.")
    dataset = match_document.coach_dataset_for(request.app.state.store, job)
    body = json.dumps(dataset, ensure_ascii=False, indent=2).encode("utf-8")
    return Response(content=body, media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="smashlab-analysis-{job.id}.json"'})


@router.get("/api/v1/analyses/{job_id}/shot-trajectory")
def get_shot_trajectory_summary(request: Request, job_id: str):
    """Summary of this analysis's trajectory dataset (rule version, distributions, run id). Read only."""
    job = _job_or_404(request, job_id)
    if job.status != "completed":
        raise _error(409, "not_ready", f"The analysis is {job.status}.")
    summary = shot_dataset.read_summary(job.output_dir)
    if summary is None:
        raise _error(404, "dataset_not_built", "The trajectory dataset of this analysis has not been built yet.")
    return JSONResponse({**summary, "job_id": job.id})


@router.get("/api/v1/analyses/{job_id}/shot-trajectory/records")
def list_shot_trajectory_records(request: Request, job_id: str):
    """One record per Shot timeline row of this analysis. The rows are read from this job's folder only."""
    job = _job_or_404(request, job_id)
    records = shot_dataset.read_records(job.output_dir)
    if records is None:
        raise _error(404, "dataset_not_built", "The trajectory dataset of this analysis has not been built yet.")
    return JSONResponse({"job_id": job.id, "records": records})


@router.get("/api/v1/analyses/{job_id}/shot-trajectory/records/{shot_id}")
def get_shot_trajectory_record(request: Request, job_id: str, shot_id: str):
    job = _job_or_404(request, job_id)
    records = shot_dataset.read_records(job.output_dir) or []
    for record in records:
        if record.get("shot_id") == shot_id and record.get("job_id") == job.id:
            return JSONResponse(record)
    raise _error(404, "record_not_found", "No trajectory record with this id in this analysis.")


@router.post("/api/v1/analyses/{job_id}/shot-trajectory/build")
def build_shot_trajectory_dataset(request: Request, job_id: str):
    """Rebuilds this analysis's dataset from its own raw outputs. Writes only under derived/."""
    job = _job_or_404(request, job_id)
    if job.status != "completed":
        raise _error(409, "not_ready", f"The analysis is {job.status}.")
    try:
        summary = match_document.write_for_job(request.app.state.store, job)
    except R.PipelineIntegrityError as exc:
        raise _error(500, exc.code, str(exc))
    return JSONResponse({**summary, "job_id": job.id})


@router.get("/api/v1/analyses/{job_id}/shot-trajectory/export.jsonl")
def export_shot_trajectory_dataset(request: Request, job_id: str):
    """Downloads this analysis's dataset as JSONL. Built on demand when missing, from this job only."""
    job = _job_or_404(request, job_id)
    if job.status != "completed":
        raise _error(409, "not_ready", f"The analysis is {job.status}.")
    path = shot_dataset.dataset_path(job.output_dir)
    if not os.path.isfile(path):
        try:
            match_document.write_for_job(request.app.state.store, job)
        except R.PipelineIntegrityError as exc:
            raise _error(500, exc.code, str(exc))
    return FileResponse(path, media_type="application/x-ndjson",
                        filename=f"shot_trajectory_dataset_{job.id}.jsonl")


@router.get("/api/v1/analyses/{job_id}/match")
def get_match(request: Request, job_id: str):
    """Match analytics computed from the saved outputs and the corrections. Nothing is re-run or written."""
    job = _job_or_404(request, job_id)
    if job.status != "completed":
        raise _error(409, "not_ready", f"The analysis is {job.status}.")
    return JSONResponse(_match_document(request, job))


def _match_document(request: Request, job) -> dict:
    return match_document.for_job(request.app.state.store, job)


def _write_sha256(output_dir: str, digest: str) -> None:
    target = os.path.join(output_dir, sessions_service.SHA_FILE)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w", encoding="utf-8") as handle:
        handle.write(digest + "\n")


def _sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


@router.get("/api/v1/sessions")
async def list_sessions(request: Request):
    """One session per video. The active analysis is the newest successful run; running and failed runs are shown beside it."""
    store = request.app.state.store
    jobs = [job for job in store.list_jobs(500) if not sessions_service.is_hidden(job)]
    payload = []
    for session in sessions_service.group_sessions(jobs):
        item = {
            "session_id": session.session_id,
            "source": {"kind": session.source_kind, "name": session.source_name, "sample_id": session.sample_id},
            "analyses_total": len(session.jobs),
            "failed_since_success": session.failed_since_success,
            "running": _job_summary(session.running_job) if session.running_job else None,
            "active": None,
        }
        if session.active_job is not None:
            counts = None
            try:
                counts = _match_counts(_match_document(request, session.active_job))
            except Exception:  # a broken analysis must not hide the other sessions
                counts = None
            item["active"] = {**_job_summary(session.active_job), "counts": counts}
        payload.append(item)
    return {"sessions": payload}


def _match_counts(document: dict) -> dict:
    rallies = document.get("summary", {}).get("rallies", {})
    annotations = document.get("annotations", {})
    return {
        "shots": len(document.get("shots", {}).get("items", [])),
        "labelled_by_person": sum(1 for item in document.get("shots", {}).get("items", []) if item.get("type_source") == "manual"),
        "rally_candidates": rallies.get("candidates", 0) + rallies.get("uncertain", 0),
        "rally_confirmed": rallies.get("confirmed", 0),
        "transferred_annotations": len(annotations.get("transferred", [])),
        "unmatched_annotations": len(annotations.get("unmatched", [])),
    }


@router.get("/api/v1/analyses/{job_id}/corrections")
async def list_corrections(request: Request, job_id: str):
    job = _job_or_404(request, job_id)
    document = corrections_service.load(job.output_dir)
    return {"job_id": job.id, "entries": document.get("entries", [])}


@router.post("/api/v1/analyses/{job_id}/corrections", status_code=201)
def add_correction(request: Request, job_id: str, payload: dict = Body(...)):
    """Validate and store one manual correction, then rebuild the derived outputs from the raw files."""
    settings = request.app.state.settings
    job = _job_or_404(request, job_id)
    if job.status != "completed":
        raise _error(409, "not_ready", f"The analysis is {job.status}.")
    results = _read_results(job.output_dir)
    video = results["video"]
    if payload.get("type") in corrections_service.ANALYTICS_TYPES:
        # Contact reviews, shot labels and rally boundaries change only the match analytics: no recompute.
        with CORRECTION_LOCK:
            try:
                entry = corrections_service.append(
                    job.output_dir,
                    job.id,
                    payload,
                    frames_total=int(video["frames_analysed"]),
                    width=int(video["width"]),
                    height=int(video["height"]),
                    players=int(results["players"]["logical_identities"]),
                )
            except corrections_service.CorrectionError as exc:
                raise _error(422, "invalid_correction", str(exc)) from exc
            # The trajectory dataset carries the reviewed labels, so it is rebuilt from the same files (no model run).
            # Without this the records would keep the labels of the last build.
            try:
                match_document.write_for_job(request.app.state.store, job)
            except Exception as exc:
                corrections_service.discard(job.output_dir, entry["id"])
                raise _error(500, "dataset_rebuild_failed", f"The trajectory dataset could not be rebuilt: {exc}") from exc
        return {"correction": entry, "summary": None, "recomputed": False}
    if not os.path.isfile(os.path.join(job.output_dir, "raw", "inference_meta.json")):
        raise _error(409, "not_recomputable", "This analysis was made before raw outputs were kept, so it cannot take corrections.")
    with CORRECTION_LOCK:
        try:
            entry = corrections_service.append(
                job.output_dir,
                job.id,
                payload,
                frames_total=int(video["frames_analysed"]),
                width=int(video["width"]),
                height=int(video["height"]),
                players=int(results["players"]["logical_identities"]),
            )
        except corrections_service.CorrectionError as exc:
            raise _error(422, "invalid_correction", str(exc)) from exc
        try:
            AnalysisRunner(PipelineOptions(models_dir=settings.models_dir, threads=settings.onnx_threads)).recompute(
                job.output_dir, job.input_path
            )
        except Exception as exc:
            corrections_service.discard(job.output_dir, entry["id"])
            if isinstance(exc, MediaError):
                raise _error(500, exc.code, exc.message) from exc
            raise _error(500, "recompute_failed", "The derived outputs could not be rebuilt. The correction was not saved.") from exc
    return {"correction": entry, "summary": _results_summary(job.output_dir)}


@router.get("/api/v1/evaluation")
async def get_evaluation(request: Request, limit: int = 100):
    """Measured summary of saved analyses. Ground truth is reported as not evaluated."""
    settings = request.app.state.settings
    store = request.app.state.store
    manifest = load_manifest(settings.samples_manifest)
    labelled = sum(1 for sample in manifest.get("samples", []) if sample.get("ground_truth"))
    # Only the active analysis of each built-in sample counts: superseded runs, uploads and hidden jobs are not listed here.
    return summarise_jobs(sessions_service.active_sample_jobs(store.list_jobs(max(1, min(limit, 200)))), labelled_samples=labelled)


def _file_response(request: Request, path: str, media_type: str) -> Response:
    size = os.path.getsize(path)
    header = request.headers.get("range")
    if not header:
        return FileResponse(path, media_type=media_type, headers={"Accept-Ranges": "bytes"})
    match = RANGE_PATTERN.match(header.strip())
    if not match or (match.group(1) == "" and match.group(2) == ""):
        return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
    if match.group(1) == "":
        suffix_len = int(match.group(2))
        start = max(0, size - suffix_len)
        end = size - 1
    else:
        start = int(match.group(1))
        end = int(match.group(2)) if match.group(2) else size - 1
        end = min(end, size - 1)
    if start >= size or start > end:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
    length = end - start + 1

    def iterate() -> Iterator[bytes]:
        with open(path, "rb") as handle:
            handle.seek(start)
            remaining = length
            while remaining > 0:
                chunk = handle.read(min(CHUNK, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    headers = {
        "Content-Range": f"bytes {start}-{end}/{size}",
        "Accept-Ranges": "bytes",
        "Content-Length": str(length),
    }
    return StreamingResponse(iterate(), status_code=206, media_type=media_type, headers=headers)
