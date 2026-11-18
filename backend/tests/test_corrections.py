"""Manual corrections: validation, append-only history, persistence and the frame-level identity rule."""

import os

import pytest

from app.services import corrections as C

SIZE = dict(frames_total=100, width=640, height=360, players=2)


def test_a_missing_file_loads_as_an_empty_history(tmp_path):
    assert C.load(str(tmp_path)) == {"schema": C.SCHEMA, "entries": []}


def test_identity_corrections_must_name_a_valid_identity_track_and_interval():
    base = {"type": "identity", "track_id": 1, "identity": "P1", "start_frame": 0, "end_frame": 10}
    C.validate(base, **SIZE)
    with pytest.raises(C.CorrectionError):
        C.validate({**base, "identity": "P3"}, **SIZE)  # singles has P1 and P2 only
    with pytest.raises(C.CorrectionError):
        C.validate({**base, "track_id": -1}, **SIZE)
    with pytest.raises(C.CorrectionError):
        C.validate({**base, "track_id": True}, **SIZE)  # booleans are not track ids
    with pytest.raises(C.CorrectionError):
        C.validate({**base, "start_frame": 20, "end_frame": 10}, **SIZE)
    with pytest.raises(C.CorrectionError):
        C.validate({**base, "end_frame": 100}, **SIZE)  # outside the video


def test_court_corners_must_be_inside_the_frame_and_form_a_convex_quadrilateral():
    C.validate({"type": "court_calibration", "corners_px": [[10, 300], [600, 300], [620, 40], [0, 40]]}, **SIZE)
    with pytest.raises(C.CorrectionError):  # the last two corners are swapped: a bow tie
        C.validate({"type": "court_calibration", "corners_px": [[10, 300], [600, 40], [620, 300], [0, 40]]}, **SIZE)
    with pytest.raises(C.CorrectionError):  # outside the frame
        C.validate({"type": "court_calibration", "corners_px": [[10, 300], [700, 300], [620, 40], [0, 40]]}, **SIZE)


def test_mode_and_note_rules():
    with pytest.raises(C.CorrectionError):
        C.validate({"type": "mode", "mode": "auto"}, **SIZE)
    with pytest.raises(C.CorrectionError):
        C.validate({"type": "mode", "mode": "doubles", "note": "x" * 281}, **SIZE)


def test_append_keeps_history_with_unique_ids_and_leaves_no_temporary_file(tmp_path):
    job = str(tmp_path)
    first = C.append(job, "job1", {"type": "mode", "mode": "doubles"}, **SIZE)
    second = C.append(job, "job1", {"type": "mode", "mode": "singles", "note": "re-checked"}, **SIZE)
    document = C.load(job)
    assert [e["id"] for e in document["entries"]] == [first["id"], second["id"]]
    assert first["id"] != second["id"]
    assert document["job_id"] == "job1"
    assert C.latest(document["entries"], "mode")["mode"] == "singles"
    assert not os.path.exists(C.corrections_path(job) + ".tmp")


def test_a_later_identity_correction_wins_for_the_same_frame_and_track():
    entries = [
        {"type": "identity", "track_id": 3, "identity": "P1", "start_frame": 0, "end_frame": 5},
        {"type": "identity", "track_id": 3, "identity": "P2", "start_frame": 4, "end_frame": 8},
    ]
    forced = C.forced_identities(entries)
    assert forced[3] == {3: "P1"}
    assert forced[4] == {3: "P2"}
    assert forced[8] == {3: "P2"}
    assert 9 not in forced


def test_hit_frame_needs_a_contact_frame_and_a_hit_frame_inside_the_video():
    C.validate({"type": "hit_frame", "frame": 40, "hit_frame": 38}, **SIZE)
    with pytest.raises(C.CorrectionError):
        C.validate({"type": "hit_frame", "frame": 40, "hit_frame": 100}, **SIZE)
    with pytest.raises(C.CorrectionError):
        C.validate({"type": "hit_frame", "frame": -1, "hit_frame": 3}, **SIZE)
    with pytest.raises(C.CorrectionError):
        C.validate({"type": "hit_frame", "frame": 40}, **SIZE)
