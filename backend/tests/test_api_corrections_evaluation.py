"""Corrections, evaluation summary, sample thumbnails and creation modes through the HTTP API."""

import json
import os
import shutil
import uuid

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.services import corrections as corrections_service

NEEDS_FFMPEG = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg renders the annotated video")
SAMPLE_MANIFEST = {
    "schema": "smashlab.local-ai.manifest/v1",
    "samples": [
        {
            "id": "sample-x", "title": "X", "file": "samples/clip.mp4", "licence": "CC0",
            "fps": 10.0, "width": 160, "height": 120, "frames": 12, "duration_s": 1.2, "ground_truth": [],
        },
        {"id": "sample-missing", "title": "Missing", "file": "samples/none.mp4", "licence": "CC0", "ground_truth": []},
    ],
}


def settings_for(tmp_path, **overrides) -> Settings:
    input_dir = tmp_path / "input"
    outputs = tmp_path / "outputs"
    values = dict(
        input_dir=str(input_dir),
        samples_dir=str(input_dir / "samples"),
        samples_manifest=str(input_dir / "manifest.json"),
        models_dir=str(tmp_path / "models"),
        outputs_dir=str(outputs),
        db_path=str(outputs / "db" / "jobs.sqlite"),
        max_upload_bytes=5 * 1024 * 1024,
        max_duration_s=30.0,
        job_timeout_s=60.0,
        lease_seconds=60.0,
        max_attempts=2,
        onnx_threads=1,
        cors_origins=["http://localhost:3000"],
    )
    values.update(overrides)
    return Settings(**values)


def write_clip(path, frames=12, size=(160, 120), fps=10.0):
    path.parent.mkdir(parents=True, exist_ok=True)
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), fps, size)
    for i in range(frames):
        writer.write(np.full((size[1], size[0], 3), (i * 17) % 255, dtype=np.uint8))
    writer.release()
    return str(path)


def write_manifest(input_dir):
    with open(input_dir / "manifest.json", "w", encoding="utf-8") as handle:
        json.dump(SAMPLE_MANIFEST, handle)


def dump(path, payload):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)


def make_completed_job(store, outputs_dir, input_video, frames=12, fps=10.0, size=(160, 120)):
    """A completed analysis with the raw files that the pipeline keeps, built without running the models."""
    job_id = uuid.uuid4().hex
    output_dir = os.path.join(outputs_dir, job_id)
    raw = os.path.join(output_dir, "raw")
    os.makedirs(raw, exist_ok=True)
    with open(os.path.join(raw, "detections.jsonl"), "w", encoding="utf-8") as handle:
        for index in range(frames):
            handle.write(json.dumps({"frame": index, "boxes": [[30.0, 20.0, 60.0, 110.0, 0.9]]}) + "\n")
    dump(os.path.join(raw, "court_auto.json"), {
        "status": "failed", "reason": "test fixture", "score": 0.0, "coverage": 0.0, "template": "",
        "homography_image_from_court": None, "quad_image_px": None,
        "coordinate_space": "test", "approximation": "test",
    })
    dump(os.path.join(raw, "inference_meta.json"), {
        "job_id": job_id, "fps": fps, "width": size[0], "height": size[1], "frame_count": frames,
        "analysed_frames": frames, "inpaint_available": False, "inpaint_applied": False,
        "tracknet_onnx_sha256": "test", "tracknet_checkpoint_sha256": "test", "yolox_sha256": "test",
    })
    dump(os.path.join(output_dir, "shuttle_trajectory.json"), {
        "frames": [
            {"frame": i, "x": None, "y": None, "visible": False, "confidence": 0.0, "refined": False}
            for i in range(frames)
        ],
    })
    dump(os.path.join(output_dir, "results.json"), {
        "source": {"kind": "upload", "name": "clip.mp4"},
        "video": {"width": size[0], "height": size[1], "fps": fps, "frames_analysed": frames, "duration_s": frames / fps},
        "players": {"logical_identities": 2},
    })
    store.create_job(job_id, "upload", "clip.mp4", "", input_video, output_dir)
    store.mark_completed(job_id)
    return job_id, output_dir


def read_results(output_dir):
    with open(os.path.join(output_dir, "results.json"), encoding="utf-8") as handle:
        return json.load(handle)


@NEEDS_FFMPEG
def test_corrections_are_validated_stored_and_recomputed(tmp_path):
    settings = settings_for(tmp_path)
    app = create_app(settings, start_worker=False)
    with TestClient(app) as client:
        store = client.app.state.store
        clip = write_clip(tmp_path / "input" / "clip.mp4")
        job_id, output_dir = make_completed_job(store, settings.outputs_dir, clip)
        url = f"/api/v1/analyses/{job_id}/corrections"
        assert client.get(url).json()["entries"] == []

        rejected = client.post(url, json={"type": "identity", "track_id": 1, "identity": "P3",
                                          "start_frame": 0, "end_frame": 5})
        assert rejected.status_code == 422 and rejected.json()["error"]["code"] == "invalid_correction"
        assert client.get(url).json()["entries"] == []

        accepted = client.post(url, json={"type": "identity", "track_id": 1, "identity": "P1",
                                          "start_frame": 0, "end_frame": 5, "note": "first frames"})
        assert accepted.status_code == 201
        entry = accepted.json()["correction"]
        assert entry["type"] == "identity" and len(entry["id"]) == 32
        assert accepted.json()["summary"]["frames"] == 12
        assert [e["id"] for e in client.get(url).json()["entries"]] == [entry["id"]]
        assert os.path.getsize(os.path.join(output_dir, "annotated.mp4")) > 0
        assert read_results(output_dir)["players"]["corrections_applied"] == 6


@NEEDS_FFMPEG
def test_the_server_owns_the_correction_id_and_time_and_drops_unknown_fields(tmp_path):
    settings = settings_for(tmp_path)
    app = create_app(settings, start_worker=False)
    with TestClient(app) as client:
        store = client.app.state.store
        clip = write_clip(tmp_path / "input" / "clip.mp4")
        job_id, _ = make_completed_job(store, settings.outputs_dir, clip)
        response = client.post(f"/api/v1/analyses/{job_id}/corrections",
                               json={"type": "mode", "mode": "singles", "id": "forged", "created_at": 1, "extra": "x"})
        assert response.status_code == 201
        entry = response.json()["correction"]
        assert entry["id"] != "forged" and entry["created_at"] != 1 and "extra" not in entry


@NEEDS_FFMPEG
def test_a_doubles_correction_allows_identities_p3_and_p4_afterwards(tmp_path):
    settings = settings_for(tmp_path)
    app = create_app(settings, start_worker=False)
    with TestClient(app) as client:
        store = client.app.state.store
        clip = write_clip(tmp_path / "input" / "clip.mp4")
        job_id, output_dir = make_completed_job(store, settings.outputs_dir, clip)
        url = f"/api/v1/analyses/{job_id}/corrections"
        assert client.post(url, json={"type": "identity", "track_id": 1, "identity": "P3",
                                      "start_frame": 0, "end_frame": 2}).status_code == 422
        assert client.post(url, json={"type": "mode", "mode": "doubles"}).status_code == 201
        assert read_results(output_dir)["players"]["logical_identities"] == 4
        assert client.post(url, json={"type": "identity", "track_id": 1, "identity": "P3",
                                      "start_frame": 0, "end_frame": 2}).status_code == 201


def test_corrections_need_a_completed_analysis(tmp_path):
    settings = settings_for(tmp_path)
    app = create_app(settings, start_worker=False)
    with TestClient(app) as client:
        store = client.app.state.store
        job_id = uuid.uuid4().hex
        store.create_job(job_id, "upload", "clip.mp4", "", "/not-there.mp4", str(tmp_path / "outputs" / job_id))
        response = client.post(f"/api/v1/analyses/{job_id}/corrections", json={"type": "mode", "mode": "singles"})
        assert response.status_code == 409


def test_evaluation_reports_only_what_was_measured_and_marks_ground_truth_not_evaluated(tmp_path):
    settings = settings_for(tmp_path)
    app = create_app(settings, start_worker=False)
    with TestClient(app) as client:
        store = client.app.state.store
        clip = write_clip(tmp_path / "input" / "clip.mp4")
        _sample_job(store, settings.outputs_dir, clip, "sample-x", "completed")  # only built-in samples are counted
        response = client.get("/api/v1/evaluation")
        body = response.json()
        assert response.status_code == 200 and body["schema"] == "smashlab.evaluation/v1"
        assert body["analyses"]["completed"] == 1 and body["analyses"]["frames_analysed"] == 12
        assert body["ground_truth"]["status"] == "not evaluated (no ground truth)"
        assert body["ground_truth"]["labelled_samples"] == 0
        assert body["shots"]["status"] == "unsupported"
        assert body["processing"]["wall_seconds_mean"] is None  # this fixture has no metrics.json


def test_sample_list_reports_status_and_serves_thumbnails(tmp_path):
    settings = settings_for(tmp_path)
    input_dir = tmp_path / "input"
    write_clip(input_dir / "samples" / "clip.mp4")
    write_manifest(input_dir)
    app = create_app(settings, start_worker=False)
    with TestClient(app) as client:
        samples = {s["id"]: s for s in client.get("/api/v1/samples").json()["samples"]}
        assert samples["sample-x"]["status"] == "available"
        assert samples["sample-x"]["thumbnail_url"] == "/api/v1/samples/sample-x/thumbnail"
        assert samples["sample-missing"]["status"] == "missing"
        thumbnail = client.get("/api/v1/samples/sample-x/thumbnail")
        assert thumbnail.status_code == 200 and thumbnail.headers["content-type"] == "image/jpeg"
        assert thumbnail.content[:2] == b"\xff\xd8"
        assert client.get("/api/v1/samples/sample-missing/thumbnail").status_code == 409
        assert client.get("/api/v1/samples/unknown/thumbnail").status_code == 404


def test_creating_from_a_sample_can_fix_singles_or_doubles(tmp_path):
    settings = settings_for(tmp_path)
    input_dir = tmp_path / "input"
    write_clip(input_dir / "samples" / "clip.mp4")
    write_manifest(input_dir)
    app = create_app(settings, start_worker=False)
    with TestClient(app) as client:
        assert client.post("/api/v1/analyses", data={"sample_id": "sample-x", "mode": "triples"}).status_code == 400
        created = client.post("/api/v1/analyses", data={"sample_id": "sample-x", "mode": "doubles"})
        assert created.status_code == 202
        job = client.app.state.store.get_job(created.json()["job_id"])
        entries = corrections_service.load(job.output_dir)["entries"]
        assert [(e["type"], e["mode"]) for e in entries] == [("mode", "doubles")]
        # A run of this sample is still queued: a second one is refused, not duplicated.
        duplicate = client.post("/api/v1/analyses", data={"sample_id": "sample-x"})
        assert duplicate.status_code == 409 and duplicate.json()["error"]["code"] == "analysis_running"
        client.app.state.store.mark_completed(job.id)
        automatic = client.post("/api/v1/analyses", data={"sample_id": "sample-x"})
        assert automatic.status_code == 202
        auto_job = client.app.state.store.get_job(automatic.json()["job_id"])
        assert corrections_service.load(auto_job.output_dir)["entries"] == []


def _sample_job(store, outputs_dir, input_video, sample_id, status):
    job_id = uuid.uuid4().hex
    output_dir = os.path.join(outputs_dir, job_id)
    os.makedirs(output_dir, exist_ok=True)
    dump(os.path.join(output_dir, "results.json"), {
        "source": {"kind": "sample", "name": "X"},
        "video": {"width": 160, "height": 120, "fps": 10.0, "frames_analysed": 12, "duration_s": 1.2},
        "players": {"logical_identities": 2},
    })
    store.create_job(job_id, "sample", "X", sample_id, input_video, output_dir)
    if status == "completed":
        store.mark_completed(job_id)
    elif status == "failed":
        store.mark_failed(job_id, "test", "test failure")
    return job_id


def test_the_sessions_list_has_one_entry_per_sample_and_a_failed_rerun_keeps_the_active_result(tmp_path):
    settings = settings_for(tmp_path)
    input_dir = tmp_path / "input"
    video = write_clip(input_dir / "samples" / "clip.mp4")
    write_manifest(input_dir)
    app = create_app(settings, start_worker=False)
    with TestClient(app) as client:
        store = client.app.state.store
        outputs = settings.outputs_dir
        first = _sample_job(store, outputs, video, "sample-x", "completed")
        second = _sample_job(store, outputs, video, "sample-x", "completed")
        _sample_job(store, outputs, video, "sample-x", "failed")
        sessions = client.get("/api/v1/sessions").json()["sessions"]
        assert len(sessions) == 1
        assert sessions[0]["session_id"] == "sample:sample-x"
        assert sessions[0]["active"]["job_id"] == second and sessions[0]["active"]["job_id"] != first
        assert sessions[0]["failed_since_success"] == 1 and sessions[0]["analyses_total"] == 3
        assert sessions[0]["running"] is None
