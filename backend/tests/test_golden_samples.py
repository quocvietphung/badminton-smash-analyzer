"""Golden regression for the stored sample analyses A to D (golden-analysis/v1).

Each baseline in tests/golden/ was recomputed from one stored job's files with tools/update_golden.py. The test
recomputes the same snapshot and requires it to be identical. A sample whose stored job is not on this machine (for
example in CI) is skipped. Manual corrections are left out of the snapshot, so a session's transferred reviews (which
the worker's own dataset includes) never change it. A difference means a derived number moved; it is not an accuracy
measurement, because the clips have no ground truth.

After an intended change, read the differences and refresh the baselines:
  .venv-dev/bin/python tools/update_golden.py check
  .venv-dev/bin/python tools/update_golden.py write
"""

import json
import os
from pathlib import Path

import pytest

from app.services import golden
from tests.test_dashboard_parity import results, shuttle_doc, tracks

GOLDEN_DIR = Path(__file__).resolve().parent / "golden"
MANIFEST = json.loads((GOLDEN_DIR / "samples.json").read_text(encoding="utf-8"))
OUTPUTS = Path(os.environ.get("SMASHLAB_GOLDEN_OUTPUTS") or Path(__file__).resolve().parents[2] / "outputs")


@pytest.mark.parametrize("sample", sorted(MANIFEST["samples"]))
def test_the_stored_sample_still_gives_its_golden_snapshot(sample):
    entry = MANIFEST["samples"][sample]
    folder = OUTPUTS / entry["job_id"]
    if not (folder / "results.json").is_file():
        pytest.skip(f"stored job of sample {sample} is not on this machine ({folder})")
    expected = json.loads((GOLDEN_DIR / f"sample_{sample.lower()}.json").read_text(encoding="utf-8"))
    found = list(golden.differences(expected, golden.snapshot(str(folder), entry["job_id"])))
    assert not found, f"sample {sample} changed:\n" + "\n".join(found[:40]) + \
        "\nRead the differences, then run tools/update_golden.py write if the change is intended."


def _write_job(folder: Path) -> None:
    folder.mkdir(parents=True)
    files = {"results.json": results(), "player_tracks.json": {"tracks": tracks()}, "shuttle_trajectory.json": shuttle_doc(),
             "corrections.json": {"schema": "smashlab.corrections/v1", "job_id": "g",
                                  "entries": [{"id": "c", "type": "contact_review", "frame": 40, "decision": "confirmed"}]}}
    for name, content in files.items():
        (folder / name).write_text(json.dumps(content), encoding="utf-8")


def test_a_snapshot_reads_only_and_leaves_corrections_out(tmp_path):
    folder = tmp_path / "job-g"
    _write_job(folder)
    before = {path.name: path.stat().st_mtime_ns for path in folder.rglob("*")}
    first = golden.snapshot(str(folder), "job-g")
    assert {path.name: path.stat().st_mtime_ns for path in folder.rglob("*")} == before  # nothing written
    assert first == golden.snapshot(str(folder), "job-g")  # deterministic
    assert all(row[2] == "candidate" for row in first["contacts"])  # the person's confirmation is not in the snapshot
    assert first["observed_2d"]["rejected"]["tracker_jump"] == 1
    assert first["estimated_3d"]["available"] == 0


def test_differences_name_each_changed_path():
    expected = {"contacts": [[10, "P1", "candidate", "clear", 500.0]], "court": {"status": "failed"}}
    actual = {"contacts": [[10, "P1", "candidate", "smash", 500.0], [20, "P2", "candidate", "lift", 300.0]],
              "court": {"status": "failed", "score": 0.0}}
    found = list(golden.differences(expected, actual))
    assert "contacts: 1 items expected, 2 now" in found
    assert "contacts[0][3]: expected 'clear', now 'smash'" in found
    assert "court.score: new value 0.0" in found
    assert list(golden.differences(expected, json.loads(json.dumps(expected)))) == []


def test_identity_continuity_counts_tracks_and_switches_per_identity():
    def obs(frame, identity):
        return {"frame": frame, "identity": identity}

    doc = {"tracks": [
        {"track_id": 1, "observations": [obs(0, "P1"), obs(1, "P1"), obs(5, "P1")]},
        {"track_id": 2, "observations": [obs(2, "P1"), obs(3, "P1"), obs(0, "P2")]},
        {"track_id": 3, "observations": [obs(1, "P2"), obs(2, None)]},
    ]}
    continuity = golden.identity_continuity(doc)
    assert continuity["tracks_total"] == 3
    assert continuity["tracks_per_identity"] == {"P1": 2, "P2": 2}
    assert continuity["track_switches"] == {"P1": 2, "P2": 1}  # P1: track 1 -> 2 -> 1; P2: track 2 -> 3
