import json
import os
import time
import uuid

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.pipeline.media import MediaError
from app.services.store import SqliteStore
from app.services.worker import AnalysisWorker


def make_settings(tmp_path, **overrides) -> Settings:
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


def write_video(path, frames=12, size=(160, 120), fps=10.0):
    path.parent.mkdir(parents=True, exist_ok=True)
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), fps, size)
    for i in range(frames):
        writer.write(np.full((size[1], size[0], 3), (i * 17) % 255, dtype=np.uint8))
    writer.release()
    return str(path)


def new_store(tmp_path):
    return SqliteStore(str(tmp_path / "queue" / "jobs.sqlite"))


def test_queue_receive_hides_message_for_lease_and_counts_attempts(tmp_path):
    store = new_store(tmp_path)
    job_id = uuid.uuid4().hex
    store.create_job(job_id, "sample", "s", "s", "/x.mp4", str(tmp_path))
    store.enqueue(job_id)
    first = store.receive(60)
    assert first is not None and first.job_id == job_id and first.dequeue_count == 1
    assert store.receive(60) is None  # still leased
    store.close()


def test_queue_redelivers_after_lease_expires(tmp_path):
    store = new_store(tmp_path)
    job_id = uuid.uuid4().hex
    store.create_job(job_id, "sample", "s", "s", "/x.mp4", str(tmp_path))
    store.enqueue(job_id)
    assert store.receive(0).dequeue_count == 1
    assert store.receive(0).dequeue_count == 2
    store.delete(job_id)
    assert store.receive(0) is None
    store.close()


def test_job_state_transitions_are_recorded(tmp_path):
    store = new_store(tmp_path)
    job_id = uuid.uuid4().hex
    store.create_job(job_id, "upload", "clip.mp4", "10 bytes", "/x.mp4", str(tmp_path))
    store.mark_running(job_id, attempts=1)
    store.update_progress(job_id, "analyse", 0.4)
    job = store.get_job(job_id)
    assert job.status == "running" and job.stage == "analyse" and job.progress == pytest.approx(0.4)
    store.mark_completed(job_id)
    assert store.get_job(job_id).status == "completed"
    store.close()


class _FakeRunner:
    def __init__(self, behaviour):
        self.behaviour = behaviour

    def run(self, input_path, output_dir, job_id, source):
        if isinstance(self.behaviour, Exception):
            raise self.behaviour
        with open(os.path.join(output_dir, "results.json"), "w", encoding="utf-8") as handle:
            json.dump({"job_id": job_id, "source": source}, handle)
        return {}


def _worker(store, settings, behaviour):
    return AnalysisWorker(
        store,
        store,
        settings,
        runner_factory=lambda options, progress: _FakeRunner(behaviour),
    )


def test_worker_completes_a_job_and_acknowledges_the_message(tmp_path):
    settings = make_settings(tmp_path)
    store = new_store(tmp_path)
    job_id = uuid.uuid4().hex
    out = tmp_path / "out" / job_id
    out.mkdir(parents=True)
    store.create_job(job_id, "sample", "Sample A", "sample-a", "/x.mp4", str(out))
    store.enqueue(job_id)
    message = store.receive(60)
    _worker(store, settings, behaviour=None).process_message(message.job_id, message.dequeue_count)
    job = store.get_job(job_id)
    assert job.status == "completed"
    assert (out / "results.json").exists()
    assert store.queue_depth() == 0
    store.close()


def test_worker_records_media_errors_as_failed_jobs(tmp_path):
    settings = make_settings(tmp_path)
    store = new_store(tmp_path)
    job_id = uuid.uuid4().hex
    store.create_job(job_id, "upload", "clip.mp4", "1 bytes", "/x.mp4", str(tmp_path))
    store.enqueue(job_id)
    message = store.receive(60)
    _worker(store, settings, behaviour=MediaError("timeout", "too slow")).process_message(job_id, message.dequeue_count)
    job = store.get_job(job_id)
    assert job.status == "failed" and job.error_code == "timeout"
    store.close()


def test_worker_gives_up_after_max_attempts(tmp_path):
    settings = make_settings(tmp_path, max_attempts=2)
    store = new_store(tmp_path)
    job_id = uuid.uuid4().hex
    store.create_job(job_id, "upload", "clip.mp4", "1 bytes", "/x.mp4", str(tmp_path))
    store.enqueue(job_id)
    _worker(store, settings, behaviour=None).process_message(job_id, 3)
    job = store.get_job(job_id)
    assert job.status == "failed" and job.error_code == "retry_exhausted"
    store.close()


def test_api_health_reports_degraded_without_models(tmp_path):
    app = create_app(make_settings(tmp_path), start_worker=False)
    with TestClient(app) as client:
        body = client.get("/health").json()
    assert body["status"] == "degraded"
    assert body["models"] == {"tracknetv3": False, "inpaintnet": False, "yolox": False}
    assert body["ffmpeg"] in (True, False)


def test_api_rejects_non_video_uploads_and_bad_requests(tmp_path):
    app = create_app(make_settings(tmp_path), start_worker=False)
    with TestClient(app) as client:
        text = client.post("/api/v1/analyses", files={"file": ("clip.mp4", b"not a video at all", "video/mp4")})
        assert text.status_code == 415 and text.json()["error"]["code"] == "unsupported_format"
        wrong_suffix = client.post("/api/v1/analyses", files={"file": ("clip.avi", b"x" * 40, "video/x-msvideo")})
        assert wrong_suffix.status_code == 415
        neither = client.post("/api/v1/analyses")
        assert neither.status_code == 400 and neither.json()["error"]["code"] == "invalid_request"


def test_api_accepts_a_real_mp4_and_reports_queued_then_not_ready(tmp_path):
    settings = make_settings(tmp_path)
    video = write_video(tmp_path / "clip.mp4")
    app = create_app(settings, start_worker=False)
    with TestClient(app) as client:
        with open(video, "rb") as handle:
            accepted = client.post("/api/v1/analyses", files={"file": ("clip.mp4", handle, "video/mp4")})
        assert accepted.status_code == 202
        job_id = accepted.json()["job_id"]
        status = client.get(f"/api/v1/analyses/{job_id}").json()
        assert status["status"] == "queued" and status["source"]["kind"] == "upload"
        not_ready = client.get(f"/api/v1/analyses/{job_id}/results")
        assert not_ready.status_code == 409 and not_ready.json()["error"]["code"] == "not_ready"
        assert client.get("/api/v1/analyses/" + "0" * 32).status_code == 404
        assert client.get("/api/v1/analyses/not-a-job").json()["error"]["code"] == "unknown_job"


def test_api_rejects_videos_longer_than_the_limit(tmp_path):
    settings = make_settings(tmp_path, max_duration_s=1.0)
    video = write_video(tmp_path / "long.mp4", frames=60, fps=10.0)
    app = create_app(settings, start_worker=False)
    with TestClient(app) as client, open(video, "rb") as handle:
        response = client.post("/api/v1/analyses", files={"file": ("long.mp4", handle, "video/mp4")})
    assert response.status_code == 422 and response.json()["error"]["code"] == "video_too_long"


def test_api_sample_flow_uses_manifest_and_reports_missing_files(tmp_path):
    settings = make_settings(tmp_path)
    input_dir = tmp_path / "input"
    write_video(input_dir / "samples" / "present.mp4")
    manifest = {
        "schema": "smashlab.local-ai.manifest/v1",
        "samples": [
            {"id": "present", "title": "Present", "file": "samples/present.mp4", "licence": "test"},
            {"id": "absent", "title": "Absent", "file": "samples/absent.mp4", "licence": "test"},
        ],
    }
    (input_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    app = create_app(settings, start_worker=False)
    with TestClient(app) as client:
        listing = client.get("/api/v1/samples").json()["samples"]
        availability = {s["id"]: s["available"] for s in listing}
        assert availability == {"present": True, "absent": False}
        ok = client.post("/api/v1/analyses", data={"sample_id": "present"})
        assert ok.status_code == 202 and ok.json()["source"]["name"] == "Present"
        missing = client.post("/api/v1/analyses", data={"sample_id": "absent"})
        assert missing.status_code == 409 and missing.json()["error"]["code"] == "sample_missing"
        unknown = client.post("/api/v1/analyses", data={"sample_id": "nope"})
        assert unknown.status_code == 404 and unknown.json()["error"]["code"] == "unknown_sample"


def test_api_serves_artifacts_with_byte_ranges_after_completion(tmp_path):
    settings = make_settings(tmp_path)
    store_path = settings.db_path
    os.makedirs(os.path.dirname(store_path), exist_ok=True)
    store = SqliteStore(store_path)
    job_id = uuid.uuid4().hex
    output_dir = os.path.join(settings.outputs_dir, job_id)
    os.makedirs(output_dir, exist_ok=True)
    with open(os.path.join(output_dir, "annotated.mp4"), "wb") as handle:
        handle.write(bytes(range(256)) * 4)
    with open(os.path.join(output_dir, "results.json"), "w", encoding="utf-8") as handle:
        json.dump({"ok": True}, handle)
    store.create_job(job_id, "sample", "S", "s", "/x.mp4", output_dir)
    store.mark_completed(job_id)
    store.close()
    app = create_app(settings, start_worker=False)
    with TestClient(app) as client:
        full = client.get(f"/api/v1/analyses/{job_id}/artifacts/annotated.mp4")
        assert full.status_code == 200 and len(full.content) == 1024
        partial = client.get(f"/api/v1/analyses/{job_id}/artifacts/annotated.mp4", headers={"Range": "bytes=10-19"})
        assert partial.status_code == 206 and partial.content == (bytes(range(256)) * 4)[10:20]
        assert partial.headers["content-range"] == "bytes 10-19/1024"
        bad = client.get(f"/api/v1/analyses/{job_id}/artifacts/annotated.mp4", headers={"Range": "bytes=5000-"})
        assert bad.status_code == 416
        assert client.get(f"/api/v1/analyses/{job_id}/artifacts/secret.txt").status_code == 404
        assert client.get(f"/api/v1/analyses/{job_id}/results").json() == {"ok": True}


def test_api_cors_allows_the_next_dev_origin(tmp_path):
    app = create_app(make_settings(tmp_path), start_worker=False)
    with TestClient(app) as client:
        response = client.options(
            "/api/v1/analyses",
            headers={"Origin": "http://localhost:3000", "Access-Control-Request-Method": "POST"},
        )
    assert response.headers.get("access-control-allow-origin") == "http://localhost:3000"


def test_api_cors_refuses_other_origins(tmp_path):
    app = create_app(make_settings(tmp_path), start_worker=False)
    with TestClient(app) as client:
        response = client.options(
            "/api/v1/analyses",
            headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"},
        )
    assert "access-control-allow-origin" not in response.headers


def test_api_lists_saved_analyses_newest_first_with_summaries(tmp_path):
    settings = make_settings(tmp_path)
    os.makedirs(os.path.dirname(settings.db_path), exist_ok=True)
    store = SqliteStore(settings.db_path)
    done_id = uuid.uuid4().hex
    done_dir = os.path.join(settings.outputs_dir, done_id)
    os.makedirs(done_dir, exist_ok=True)
    with open(os.path.join(done_dir, "results.json"), "w", encoding="utf-8") as handle:
        json.dump({
            "video": {"frames_analysed": 450, "fps": 30.0},
            "court": {"status": "calibrated", "score": 0.89},
            "players": {"tracks_confirmed": 3, "max_concurrent_confirmed": 2},
            "shuttle": {"frames_detected": 386, "frames_interpolated": 9, "visible_ratio": 0.88},
            "rally_segmentation": {"status": "unsupported"},
            "shot_classification": {"status": "unsupported"},
        }, handle)
    store.create_job(done_id, "sample", "Sample A", "sample-a", "/x.mp4", done_dir)
    store.mark_completed(done_id)
    time.sleep(0.01)
    failed_id = uuid.uuid4().hex
    store.create_job(failed_id, "upload", "clip.mp4", "10 bytes", "/y.mp4", os.path.join(settings.outputs_dir, failed_id))
    store.mark_failed(failed_id, "corrupt_video", "no frames")
    store.close()
    app = create_app(settings, start_worker=False)
    with TestClient(app) as client:
        listing = client.get("/api/v1/analyses").json()["analyses"]
        limited = client.get("/api/v1/analyses?limit=1").json()["analyses"]
    assert [item["job_id"] for item in listing] == [failed_id, done_id]
    assert listing[0]["error"]["code"] == "corrupt_video" and listing[0]["summary"] is None
    summary = listing[1]["summary"]
    assert summary["court_status"] == "calibrated" and summary["shuttle_detected"] == 386
    assert summary["rally_status"] == "unsupported" and summary["shots_status"] == "unsupported"
    assert [item["job_id"] for item in limited] == [failed_id]


def test_api_rejects_an_empty_upload_with_400(tmp_path):
    settings = make_settings(tmp_path)
    app = create_app(settings, start_worker=False)
    with TestClient(app) as client:
        response = client.post("/api/v1/analyses", files={"file": ("empty.mp4", b"", "video/mp4")})
    assert response.status_code == 400 and response.json()["error"]["code"] == "empty_file"
    assert [p for p in os.listdir(settings.outputs_dir) if p != "db"] == []


def test_api_rejects_uploads_over_the_size_limit_with_413(tmp_path):
    settings = make_settings(tmp_path, max_upload_bytes=1024)
    payload = b"\x00\x00\x00\x18ftyp" + b"0" * 4096
    app = create_app(settings, start_worker=False)
    with TestClient(app) as client:
        response = client.post("/api/v1/analyses", files={"file": ("big.mp4", payload, "video/mp4")})
    assert response.status_code == 413 and response.json()["error"]["code"] == "file_too_large"
    assert [p for p in os.listdir(settings.outputs_dir) if p != "db"] == []
