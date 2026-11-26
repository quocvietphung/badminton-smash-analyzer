"""The trajectory records of a real analysis agree with its own shuttle file (read only; skipped when the folder is absent).

The checks cover identity and frame, timestamps, frame size, the contact candidate, every before and after point, the
provenance of interpolated points (refined by InpaintNet, not measured), gaps, and why an after window is short.
"""

import json
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
JOB_ID = "ccb6646d94bd4b109d7a821f1e3f09fd"
JOB = REPO_ROOT / "outputs" / JOB_ID
pytestmark = pytest.mark.skipif(not (JOB / "derived" / "shot_trajectory_dataset.jsonl").is_file(), reason="the real analysis folder is not present")


@pytest.fixture(scope="module")
def data():
    shuttle = json.loads((JOB / "shuttle_trajectory.json").read_text(encoding="utf-8"))
    records = [json.loads(line) for line in (JOB / "derived" / "shot_trajectory_dataset.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    return shuttle, {frame["frame"]: frame for frame in shuttle["frames"]}, records


def test_every_record_belongs_to_this_analysis_and_its_frame(data):
    shuttle, _raw, records = data
    assert len(records) == 14
    for record in records:
        assert record["job_id"] == JOB_ID
        assert record["shot_id"] == f"{JOB_ID}-frame-{record['frame']}"
        assert record["timestamp_s"] == pytest.approx(record["frame"] / shuttle["fps"], abs=0.01)
        assert record["frame_size"] == [shuttle["source_width"], shuttle["source_height"]]


def test_contact_and_points_are_the_shuttle_file_values_and_nothing_is_invented(data):
    _shuttle, raw, records = data
    for record in records:
        contact = record["contact_image"]
        observed = raw.get(record["frame"])
        if observed and observed["visible"]:
            assert (contact["x_px"], contact["y_px"]) == (observed["x"], observed["y"]), record["frame"]
        for side in ("trajectory_before", "trajectory_after"):
            for point in record[side]:
                file_point = raw.get(point["frame"])
                assert file_point is not None, f"frame {point['frame']} exists in the file"
                if point["interpolated"]:
                    assert not file_point["visible"] or file_point["refined"], "an interpolated point has no visible detection"
                else:
                    assert (point["x_px"], point["y_px"]) == (file_point["x"], file_point["y"]), point["frame"]
        before = [point["frame"] for point in record["trajectory_before"]]
        after = [point["frame"] for point in record["trajectory_after"]]
        assert all(frame < record["frame"] for frame in before), "before points come before the contact"
        assert all(frame > record["frame"] for frame in after), "after points come after the contact"


def test_interpolated_points_are_the_refined_frames_not_measurements(data):
    _shuttle, raw, records = data
    for record in records:
        for point in record["trajectory_before"] + record["trajectory_after"]:
            if point["interpolated"]:
                assert raw[point["frame"]]["refined"], f"frame {point['frame']} of shot {record['frame']} is an InpaintNet output"


def test_gaps_are_missing_frames_and_short_windows_name_their_cause(data):
    shuttle, raw, records = data
    last_frame = max(raw)
    for record in records:
        after = [point["frame"] for point in record["trajectory_after"]]
        window_end = record["frame"] + 45
        for frame in range(record["frame"] + 1, min(window_end, last_frame) + 1):
            if frame not in after:
                assert not raw[frame]["visible"], f"a visible shuttle frame {frame} was dropped from shot {record['frame']}"
        if len(after) < 45:
            if record["frame"] + 45 > last_frame:
                assert record["frame"] + 45 > last_frame, "the window ran past the end of the video"
            else:
                assert any(not raw[frame]["visible"] for frame in range(record["frame"] + 1, record["frame"] + 46)), "a short window has a missing shuttle frame"
