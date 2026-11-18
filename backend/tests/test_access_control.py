"""Access control: API token, upload tickets, the forwarded-request guard, minimal health, and sample video ranges."""

import json

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.services.access import AccessDenied, UploadTicketStore, authorize, issue_upload_ticket

TOKEN = "api-test-token-123"


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


def test_upload_tickets_are_single_use_and_expire():
    store = UploadTicketStore(TOKEN)
    ticket, _ = issue_upload_ticket(TOKEN, 60, now=1000.0)
    assert store.redeem(ticket, now=1010.0) is True
    assert store.redeem(ticket, now=1011.0) is False  # reuse is refused
    late, _ = issue_upload_ticket(TOKEN, 60, now=1000.0)
    assert store.redeem(late, now=1061.0) is False  # expired


def test_forged_foreign_and_malformed_tickets_are_refused():
    store = UploadTicketStore(TOKEN)
    ticket, _ = issue_upload_ticket(TOKEN, 60, now=1000.0)
    assert UploadTicketStore("another-token").redeem(ticket, now=1001.0) is False
    head, body, signature = ticket.split(".")
    tampered_body = body[:-2] + ("AA" if body[-2:] != "AA" else "BB")
    assert store.redeem(".".join([head, tampered_body, signature]), now=1001.0) is False
    assert store.redeem("not-a-ticket", now=1001.0) is False


def test_authorize_without_a_token_refuses_only_forwarded_requests():
    authorize({"host": "localhost:8000"}, None, None)
    with pytest.raises(AccessDenied):
        authorize({"cf-connecting-ip": "203.0.113.5"}, None, None)


def test_authorize_with_a_token_needs_the_bearer_or_an_upload_ticket():
    store = UploadTicketStore(TOKEN)
    with pytest.raises(AccessDenied):
        authorize({}, TOKEN, store)
    with pytest.raises(AccessDenied):
        authorize({"authorization": "Bearer wrong"}, TOKEN, store)
    authorize({"authorization": f"Bearer {TOKEN}"}, TOKEN, store)
    ticket, _ = issue_upload_ticket(TOKEN, 60)
    with pytest.raises(AccessDenied):
        authorize({"x-smashlab-upload-ticket": ticket}, TOKEN, store, allow_upload_ticket=False)
    authorize({"x-smashlab-upload-ticket": ticket}, TOKEN, store, allow_upload_ticket=True)


def test_the_api_requires_the_token_and_shows_only_the_status_without_it(tmp_path):
    app = create_app(settings_for(tmp_path, api_token=TOKEN), start_worker=False)
    with TestClient(app) as client:
        denied = client.get("/api/v1/analyses")
        assert denied.status_code == 401 and denied.json()["error"]["code"] == "auth_required"
        allowed = client.get("/api/v1/analyses", headers={"Authorization": f"Bearer {TOKEN}"})
        assert allowed.status_code == 200
        assert set(client.get("/health").json()) == {"status"}
        full = client.get("/health", headers={"Authorization": f"Bearer {TOKEN}"}).json()
        assert "models" in full and "jobs" in full


def test_a_forwarded_request_is_refused_when_no_token_is_configured(tmp_path):
    app = create_app(settings_for(tmp_path), start_worker=False)
    with TestClient(app) as client:
        assert client.get("/api/v1/analyses", headers={"CF-Connecting-IP": "203.0.113.5"}).status_code == 401
        assert client.get("/api/v1/analyses").status_code == 200  # local use keeps working


def test_an_upload_ticket_allows_exactly_one_upload_and_no_reads(tmp_path):
    app = create_app(settings_for(tmp_path, api_token=TOKEN), start_worker=False)
    clip = write_clip(tmp_path / "clip.mp4")
    with TestClient(app) as client:
        issued = client.post("/api/v1/upload-tickets", headers={"Authorization": f"Bearer {TOKEN}"}).json()
        assert issued["mode"] == "token" and issued["ticket"]
        with open(clip, "rb") as handle:
            first = client.post(
                "/api/v1/analyses",
                files={"file": ("clip.mp4", handle, "video/mp4")},
                headers={"X-SmashLab-Upload-Ticket": issued["ticket"]},
            )
        assert first.status_code == 202
        with open(clip, "rb") as handle:
            second = client.post(
                "/api/v1/analyses",
                files={"file": ("clip.mp4", handle, "video/mp4")},
                headers={"X-SmashLab-Upload-Ticket": issued["ticket"]},
            )
        assert second.status_code == 401
        assert client.get("/api/v1/analyses", headers={"X-SmashLab-Upload-Ticket": issued["ticket"]}).status_code == 401


def test_the_sample_video_is_served_with_byte_ranges(tmp_path):
    settings = settings_for(tmp_path)
    input_dir = tmp_path / "input"
    write_clip(input_dir / "samples" / "clip.mp4")
    manifest = {
        "schema": "smashlab.local-ai.manifest/v1",
        "samples": [{"id": "sample-x", "title": "X", "file": "samples/clip.mp4", "licence": "CC0", "ground_truth": []}],
    }
    (input_dir / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    app = create_app(settings, start_worker=False)
    with TestClient(app) as client:
        full = client.get("/api/v1/samples/sample-x/video")
        assert full.status_code == 200 and full.headers["content-type"].startswith("video/mp4")
        partial = client.get("/api/v1/samples/sample-x/video", headers={"Range": "bytes=0-99"})
        assert partial.status_code == 206 and len(partial.content) == 100
        assert partial.headers["content-range"].startswith("bytes 0-99/")
        assert client.get("/api/v1/samples/unknown/video").status_code == 404
