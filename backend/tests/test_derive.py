"""Derivation on synthetic scenes: mode choice, court filter, rally candidates, identities and corrections."""

import numpy as np
import pytest

from app.ai.shuttle_tracking.tracknet import TrackNetFrame
from app.pipeline import derive as D

FPS = 30.0
WIDTH, HEIGHT = 1600, 2000


def calibrated_court():
    # Manual corners in the order near-left, near-right, far-right, far-left.
    # The resulting mapping is image = (600 + 100 * x_m, 1700 - 100 * y_m).
    return D.court_from_manual([[600, 1700], [1210, 1700], [1210, 360], [600, 360]])


def uncalibrated_court():
    return D.CourtInfo(False, "failed", "auto", "no calibration in this test")


def player_box(court_x, court_y, height_px=200.0, score=0.9):
    foot_x = 600 + 100 * court_x
    foot_y = 1700 - 100 * court_y
    return [foot_x - 20, foot_y - height_px, foot_x + 20, foot_y, score]


def scene(frames, people):
    """The same people in every frame; the list order is the detection order."""
    return {
        index: np.asarray([player_box(x, y) for x, y in people], dtype=np.float64).reshape(-1, 5)
        for index in range(frames)
    }


def run_derive(detections, court, corrections=None, mode="auto", frames=40):
    return D.derive(
        fps=FPS,
        width=WIDTH,
        height=HEIGHT,
        total_frames=frames,
        detections=detections,
        shuttle=[],
        court=court,
        corrections_doc={"entries": corrections or []},
        config=D.DeriveConfig(mode=mode, render=False),
    )


def shuttle_run(start, length, refined=False):
    return [
        TrackNetFrame(frame=f, x=100, y=100, visible=True, confidence=0.9, refined=refined)
        for f in range(start, start + length)
    ]


def test_four_people_on_court_give_doubles():
    four = scene(30, [(1.5, 2.0), (4.6, 2.0), (1.5, 11.0), (4.6, 11.0)])
    assert D.choose_mode(four, calibrated_court(), WIDTH, HEIGHT) == "doubles"


def test_spectators_outside_the_court_do_not_count_towards_doubles():
    two_and_spectators = scene(30, [(3.0, 3.0), (3.0, 10.0), (-4.0, 6.0), (3.0, 17.0)])
    assert D.choose_mode(two_and_spectators, calibrated_court(), WIDTH, HEIGHT) == "singles"


def test_a_mode_correction_overrides_the_detected_mode():
    two = scene(30, [(3.0, 3.0), (3.0, 10.0)])
    entries = [{"type": "mode", "mode": "doubles", "id": "m1", "created_at": 0.0}]
    assert D.resolve_mode(entries, "auto", two, calibrated_court(), WIDTH, HEIGHT) == "doubles"


def test_rally_candidates_split_on_long_gaps_and_skip_short_or_interpolated_runs():
    frames = shuttle_run(0, 60) + shuttle_run(100, 60) + shuttle_run(300, 10) + shuttle_run(200, 30, refined=True)
    rallies = D.rally_candidates(sorted(frames, key=lambda f: f.frame), FPS)
    assert [(r["start_frame"], r["end_frame"]) for r in rallies] == [(0, 59), (100, 159)]
    assert all(r["validated"] is False and r["ground_truth"] is None for r in rallies)
    assert all(r["evaluation"] == "not evaluated (no ground truth)" for r in rallies)


def test_manual_corners_map_the_template_corner_to_the_clicked_pixel():
    court = calibrated_court()
    assert court.calibrated and court.source == "manual"
    corner = court.homography_image_from_court @ np.array([0.0, 0.0, 1.0])
    assert np.allclose(corner[:2] / corner[2], [600.0, 1700.0], atol=1e-3)
    outline = D._court_outline_px(court)
    assert len(outline) == 6 and outline[0] == (600, 1700)


def test_failed_automatic_calibration_is_not_calibrated():
    court = D.court_from_auto({"status": "failed", "reason": "no lines found"})
    assert not court.calibrated and court.homography_image_from_court is None
    assert D._court_outline_px(court) is None


def test_two_players_are_tracked_as_p1_near_and_p2_far_and_spectators_are_excluded():
    people = [(3.0, 3.0), (3.0, 10.0), (-4.0, 6.0), (3.0, 17.0)]
    output = run_derive(scene(40, people), calibrated_court())
    assert output.players == 2 and output.mode == "singles"
    assert len(output.track_records) == 2
    final = {state.identity: state for state in output.identity_states[-1][1]}
    assert final["P1"].box is not None and final["P2"].box is not None
    assert final["P1"].box[3] == pytest.approx(1400.0)  # the near player stands at court y = 3 m
    assert final["P2"].box[3] == pytest.approx(700.0)  # the far player stands at court y = 10 m
    assert not any(e.kind == "identity_switch_suspected" for e in output.identity_events)


def test_identity_correction_forces_the_identity_only_during_its_interval():
    court = calibrated_court()
    detections = scene(40, [(3.0, 3.0), (3.0, 10.0)])
    base = run_derive(detections, court)
    near_track = next(rec["track_id"] for rec in base.track_records if rec["observations"][0]["y2"] == 1400.0)
    corrections = [{
        "type": "identity", "track_id": near_track, "identity": "P2",
        "start_frame": 10, "end_frame": 19, "id": "c1", "created_at": 0.0,
    }]
    output = run_derive(detections, court, corrections)
    states_at = {frame: states for frame, states in output.identity_states}
    forced = next(s for s in states_at[15] if s.track_id == near_track)
    assert forced.identity == "P2" and forced.status == "manual" and forced.confidence == 1.0
    assert output.corrections_applied == 10
    # After the interval both identities predict the same spot, so they must stay uncertain or lost
    # rather than silently take the track back.
    after = states_at[30]
    assert not any(s.status == "manual" for s in after)
    assert not any(
        s.identity == "P2" and s.track_id == near_track and s.status in ("matched", "recovered") for s in after
    )


def test_a_doubles_mode_correction_creates_four_identities():
    corrections = [{"type": "mode", "mode": "doubles", "id": "m1", "created_at": 0.0}]
    output = run_derive(scene(40, [(3.0, 3.0), (3.0, 10.0)]), calibrated_court(), corrections)
    assert output.mode == "doubles" and output.players == 4


def test_court_plane_is_reported_only_when_the_court_is_calibrated():
    people = [(3.0, 3.0), (3.0, 10.0)]
    calibrated = run_derive(scene(40, people), calibrated_court())
    assert "court_plane" in D.movement_payload(calibrated, FPS, WIDTH, HEIGHT, 40, calibrated_court())
    plain = run_derive(scene(40, people), uncalibrated_court())
    assert "court_plane" not in D.movement_payload(plain, FPS, WIDTH, HEIGHT, 40, uncalibrated_court())
