"""A manual shot label, end to end, on a COPY of a real analysis.

The real job folder is read, never written: it is copied into a temporary outputs folder and every request goes through
the HTTP API of that copy. The test checks that the correction is saved and survives a reload, that the AI prediction,
its rule scores and the measured trajectory stay as they were, and that the reviewed label is what the API reports.
"""

import hashlib
import json
import os
import shutil
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def settings_for(tmp_path) -> Settings:
    input_dir = tmp_path / "input"
    outputs = tmp_path / "outputs"
    return Settings(
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

REPO_ROOT = Path(__file__).resolve().parents[2]
REAL_JOB = REPO_ROOT / "outputs" / "ccb6646d94bd4b109d7a821f1e3f09fd"
FRAME = 399

pytestmark = pytest.mark.skipif(not (REAL_JOB / "shuttle_trajectory.json").is_file(), reason="the real analysis folder is not present")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def record_at(client: TestClient, job_id: str, frame: int) -> dict:
    body = client.get(f"/api/v1/analyses/{job_id}/shot-trajectory/records").json()
    matches = [record for record in body["records"] if record["frame"] == frame]
    assert len(matches) == 1, f"one record at frame {frame}"
    return matches[0]


def test_a_manual_clear_label_is_saved_and_reloaded_without_touching_the_ai_output(tmp_path):
    real_before = {name: sha256(REAL_JOB / name) for name in ("shuttle_trajectory.json", "results.json", "shots.json")}
    settings = settings_for(tmp_path)
    app = create_app(settings, start_worker=False)
    with TestClient(app) as client:
        store = client.app.state.store
        job_id = uuid.uuid4().hex
        output_dir = Path(settings.outputs_dir) / job_id
        shutil.copytree(REAL_JOB, output_dir, ignore=shutil.ignore_patterns("annotated.mp4"))
        store.create_job(job_id, "sample", "A · Singles rally", "sample-a-singles-rally", str(tmp_path / "input" / "missing.mp4"), str(output_dir))
        store.mark_completed(job_id)

        built = client.post(f"/api/v1/analyses/{job_id}/shot-trajectory/build")
        assert built.status_code == 200, built.text
        before = record_at(client, job_id, FRAME)
        assert before["best_guess_label"] == "smash"
        assert before["manual_label"] is None
        assert before["job_id"] == job_id, "the record belongs to this copy"

        url = f"/api/v1/analyses/{job_id}/corrections"
        accepted = client.post(url, json={"type": "shot_label", "frame": FRAME, "player": "P1", "shot_type": "clear"})
        assert accepted.status_code == 201, accepted.text
        assert [entry["frame"] for entry in client.get(url).json()["entries"]] == [FRAME]

        # Reload: the reviewed label is what the trajectory dataset now reports.
        after = record_at(client, job_id, FRAME)
        assert after["manual_label"] == "clear"
        assert after["best_guess_label"] == before["best_guess_label"] == "smash", "the AI prediction is kept"
        assert after["scores"] == before["scores"], "rule scores are unchanged"
        assert after["top3"] == before["top3"]
        assert after["trajectory_before"] == before["trajectory_before"], "the measured points are unchanged"
        assert after["trajectory_after"] == before["trajectory_after"]
        assert after["contact_image"] == before["contact_image"]
        assert after["frame_size"] == before["frame_size"]

        match = client.get(f"/api/v1/analyses/{job_id}/match").json()
        shot = [item for item in match["shots"]["items"] if item["frame"] == FRAME][0]
        assert shot["type"] == "clear" and shot["type_source"] == "manual"

    # The real folder is unchanged, and the copy's raw inputs are the same files.
    assert {name: sha256(REAL_JOB / name) for name in real_before} == real_before
    assert not (REAL_JOB / "corrections.json").exists()
    assert sha256(output_dir / "shuttle_trajectory.json") == real_before["shuttle_trajectory.json"]
