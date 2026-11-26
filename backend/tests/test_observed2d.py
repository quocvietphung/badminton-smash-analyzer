"""observed-2d/v1: the shared sanitizer behind every 2D number (contacts, rules, dataset, speed monitor, dashboard, charts).

Synthetic tracks test the rules. They are not evidence for real footage.
"""

import copy
import json

import pytest

from app.analytics import observed2d as O

FPS = 30.0


def frame(index, x, y, *, confidence=0.9, refined=False, visible=True, fps=FPS):
    return {"frame": index, "time_s": round(index / fps, 6), "x": x, "y": y, "visible": visible, "confidence": confidence,
            "refined": refined}


def doc(frames, width=1920, height=1080, fps=FPS, timestamps=False):
    value = {"source_width": width, "source_height": height, "fps": fps, "frames": frames}
    if timestamps:
        value["timestamp_source"] = "presentation_timestamp"
    return value


def straight(n, start=(400.0, 500.0), step=(12.0, 3.0), fps=FPS, scale=1.0, **kwargs):
    return [frame(i, (start[0] + step[0] * i) * scale, (start[1] + step[1] * i) * scale, fps=fps, **kwargs) for i in range(n)]


def test_an_out_and_back_excursion_is_a_tracker_jump_and_is_rejected_with_its_reason():
    frames = straight(20)
    # Frames 10 and 11 jump about 430 px to another object, then the track returns (as in sample A, frames 102-103).
    frames[10] = {**frames[10], "x": frames[10]["x"] - 218.0, "y": frames[10]["y"] + 371.0}
    frames[11] = {**frames[11], "x": frames[11]["x"] - 240.0, "y": frames[11]["y"] + 382.0}
    track = O.sanitize(doc(frames))
    rejected = [item for item in track.rejected if item.reason == "tracker_jump"]
    assert [item.frame for item in rejected] == [10, 11]
    assert rejected[0].detail["from_frame"] == 9 and rejected[0].detail["return_frame"] == 12
    assert rejected[0].detail["entry_step_px"] > 400
    assert 10 not in track.points and 11 not in track.points
    assert track.points[9].segment == track.points[12].segment  # the run continues across the removed excursion
    assert track.invalid_steps == []


def test_a_fast_step_that_never_returns_is_kept_but_ends_the_run_and_is_never_a_speed():
    frames = straight(10) + [frame(i, 1500.0 + 10.0 * (i - 10), 200.0) for i in range(10, 20)]
    track = O.sanitize(doc(frames))
    assert [(step.from_frame, step.to_frame) for step in track.invalid_steps] == [(9, 10)]
    assert track.points[9].segment != track.points[10].segment
    assert all(not (step.from_frame == 9 and step.to_frame == 10) for step in O.steps(track, list(track.points.values())))
    assert not track.rejected


def test_detected_and_interpolated_points_stay_apart_and_only_detections_give_speeds():
    frames = straight(12)
    for index in (4, 5, 6):
        frames[index] = {**frames[index], "refined": True, "confidence": 0.0}
    track = O.sanitize(doc(frames))
    assert {track.points[i].source for i in (4, 5, 6)} == {"interpolated"}
    assert track.points[3].source == "detected"
    frames_in_steps = {f for step in O.steps(track, list(track.points.values())) for f in (step.from_frame, step.to_frame)}
    assert not frames_in_steps & {4, 5, 6}
    counts = track.counts()
    assert counts["detected"] == 9 and counts["interpolated"] == 3


def test_low_confidence_and_out_of_frame_points_are_rejected_with_reasons():
    frames = straight(8)
    frames[2] = {**frames[2], "confidence": 0.2}
    frames[5] = {**frames[5], "x": 2500.0}
    frames[6] = {**frames[6], "x": None, "y": None}
    track = O.sanitize(doc(frames))
    reasons = {item.frame: item.reason for item in track.rejected}
    assert reasons == {2: "low_confidence", 5: "outside_frame", 6: "missing_coordinates"}


def test_smoothing_stays_inside_a_run_and_keeps_the_raw_positions_and_timestamps():
    frames = straight(6) + [frame(i, 900.0 + 5.0 * i, 300.0) for i in range(12, 18)]  # a 6-frame gap: two runs
    frames[2] = {**frames[2], "x": frames[2]["x"] + 6.0}  # jitter inside the first run
    original = copy.deepcopy(frames)
    track = O.sanitize(doc(frames, timestamps=True))
    assert frames == original  # the raw output is never changed
    assert track.points[2].x == original[2]["x"] and track.points[2].xs != track.points[2].x
    assert track.points[5].segment != track.points[12].segment
    assert track.points[5].xs == track.points[5].x  # a run end is not averaged with the next run
    assert track.points[12].time_s == original[6]["time_s"] and track.timestamp_source == "presentation_timestamp"


def test_the_jump_rule_is_the_same_at_every_resolution_and_frame_rate():
    def scenario(width, height, fps, scale):
        frames = straight(int(round(40 * fps / 30.0)), fps=fps, scale=scale, step=(12.0 * 30.0 / fps, 3.0 * 30.0 / fps))
        jump = int(round(20 * fps / 30.0))
        frames[jump] = {**frames[jump], "x": frames[jump]["x"] + 600.0 * scale, "y": frames[jump]["y"] - 250.0 * scale}
        track = O.sanitize(doc(frames, width=width, height=height, fps=fps))
        return [item.frame for item in track.rejected], track.max_speed_px_s, track.invalid_steps

    full = scenario(1920, 1080, 30.0, 1.0)
    half = scenario(960, 540, 30.0, 0.5)
    fast = scenario(1920, 1080, 60.0, 1.0)
    assert full[0] == [20] and half[0] == [20] and fast[0] == [40]
    assert half[1] == pytest.approx(full[1] / 2, rel=1e-6)
    assert full[2] == half[2] == fast[2] == []
    # A real fast shuttle at 3000 px/s on 1080p stays: below 2.25 frame diagonals per second.
    quick = O.sanitize(doc(straight(20, step=(100.0, 0.0), start=(10.0, 500.0))))
    assert not quick.rejected and not quick.invalid_steps


def test_image_speed_never_uses_a_rejected_frame():
    frames = straight(20, step=(30.0, 0.0), start=(200.0, 400.0))
    frames[10] = {**frames[10], "x": frames[10]["x"] - 300.0, "y": frames[10]["y"] + 380.0}
    track = O.sanitize(doc(frames))
    speed = O.image_speed_around(track, 10)
    assert 10 not in speed["frames"] and speed["unit"] == "px/s" and speed["kmh"] is None
    assert speed["px_per_s"] == pytest.approx(900.0, rel=0.02)


def test_tracking_checks_name_trackNet_and_inpaintnet_points_apart():
    frames = [frame(i, 1237.0, 100.0 + 15.0 * i) for i in range(12)]  # x fixed while y moves
    frames[5] = {**frames[5], "y": frames[4]["y"]}  # a repeated detection
    frames[8] = {**frames[8], "refined": True, "confidence": 0.0}
    frames[9] = {**frames[9], "refined": True, "confidence": 0.0, "y": frames[8]["y"]}  # a repeated interpolation
    track = O.sanitize(doc(frames))
    checks = O.tracking_checks(track, 0, 11)
    kinds = {check["kind"]: check for check in checks}
    assert kinds["constant_x"]["detected"] == 10 and kinds["constant_x"]["interpolated"] == 2
    assert kinds["repeated_detection"]["from"] == 4 and kinds["repeated_detection"]["detected"] == 2
    assert kinds["repeated_interpolation"]["from"] == 8 and kinds["repeated_interpolation"]["interpolated"] == 2


def test_rejected_jumps_appear_as_tracking_checks():
    frames = straight(20)
    frames[10] = {**frames[10], "x": frames[10]["x"] + 500.0}
    checks = O.tracking_checks(O.sanitize(doc(frames)), 0, 19)
    removed = [check for check in checks if check["kind"] == "tracker_jump_removed"]
    assert removed and removed[0]["from"] == 10 and removed[0]["detected"] == 1


def test_speed_reference_and_summary_are_pixels_only():
    track = O.sanitize(doc(straight(30, step=(30.0, 0.0), start=(100.0, 500.0))))
    assert O.speed_reference(track) == pytest.approx(900.0, rel=0.01)
    summary = json.dumps(track.summary())
    assert "km/h" not in summary and "m/s" not in summary
    assert track.summary()["version"] == O.VERSION


# Real artifact (read only; skipped when the folder is absent): sample A of job ccb6646d94bd4b109d7a821f1e3f09fd.
from pathlib import Path  # noqa: E402

REAL_SHUTTLE = Path(__file__).resolve().parents[2] / "outputs" / "ccb6646d94bd4b109d7a821f1e3f09fd" / "shuttle_trajectory.json"


@pytest.mark.skipif(not REAL_SHUTTLE.is_file(), reason="the real analysis folder is not present")
def test_sample_a_tracker_jumps_are_removed_and_frame_399_checks_name_their_sources():
    raw = REAL_SHUTTLE.read_bytes()
    track = O.sanitize(json.loads(raw))
    jumps = sorted(item.frame for item in track.rejected if item.reason == "tracker_jump")
    assert jumps == [102, 103, 359, 360]
    assert O.image_speed_around(track, 102)["px_per_s"] < 500, "the 4649 px/s value came from the removed excursion"
    checks = O.tracking_checks(track, 387, 444)
    constant = [check for check in checks if check["kind"] == "constant_x" and check["from"] == 385]
    assert constant and constant[0]["to"] == 400 and constant[0]["detected"] == 16 and constant[0]["interpolated"] == 0
    assert any(check["kind"] == "repeated_detection" and check["from"] == 393 for check in checks)
    assert REAL_SHUTTLE.read_bytes() == raw  # read only
