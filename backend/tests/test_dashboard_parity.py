"""Dashboard, timeline and dataset parity: one source of numbers, computed once on the backend.

Synthetic analysis: three contacts in two rallies, one confirmed by a person, one tracker jump in the shuttle file and
one person's "unknown" note. The tests check that every timeline row matches exactly one dataset record and that the
dashboard block reports the same values the timeline and the records carry.
"""

import json
import uuid

import pytest
from fastapi.testclient import TestClient

from app.analytics import observed2d as O
from app.analytics.match import SIX_CLASSES, build_match_document
from app.main import create_app
from app.services import shot_dataset as D
from app.services.match_document import parity_problems
from tests.test_match_analytics import player, settings_for, zigzag

FPS = 30.0


def results():
    return {
        "video": {"fps": FPS, "frames_analysed": 200, "width": 1920, "height": 1080, "duration_s": 200 / FPS},
        "players": {"mode": "singles", "logical_identities": 2},
        "court": {"status": "failed", "reason": "test"},
        "shuttle": {"frames_total": 200, "frames_detected": 200},
        "identity": {"coverage": {"P1": 0.9, "P2": 0.8}},
    }


def shuttle_doc():
    frames = [
        {"frame": f, "time_s": round(f / FPS, 6), "x": x, "y": y, "visible": True, "confidence": 0.8, "refined": False}
        for f, (x, y) in enumerate(zigzag({10, 40, 150}, 200))
    ]
    frames[100] = {**frames[100], "x": frames[100]["x"] + 600.0, "y": frames[100]["y"] + 300.0}  # a one-frame tracker jump
    return {"source_width": 1920, "source_height": 1080, "fps": FPS, "timestamp_source": "presentation_timestamp", "frames": frames}


def tracks():
    return [
        player(1, "P1", range(0, 25), (480, 90, 530, 250)),
        player(2, "P2", range(30, 55), (180, 90, 230, 250)),
        player(3, "P1", range(140, 165), (1280, 90, 1330, 250)),
    ]


CORRECTIONS = [
    {"id": "c", "type": "contact_review", "frame": 40, "decision": "confirmed"},
    {"id": "n", "type": "shot_label", "frame": 150, "shot_type": "unknown"},
]


def documents():
    shuttle = shuttle_doc()
    track = O.sanitize(shuttle)
    kwargs = dict(job_id="job-p", results=results(), tracks_doc={"tracks": tracks()}, shuttle_doc=shuttle, rallies_doc=None,
                  corrections=CORRECTIONS, track=track)
    base = build_match_document(**kwargs, compute_estimated_3d=False)
    records, _meta = D.build_records(base, shuttle, job_id="job-p", run_id="t", video=results()["video"], track=track)
    full = build_match_document(**kwargs, trajectory=D.by_frame(records))
    return full, records, track


def test_every_timeline_row_matches_exactly_one_record_with_the_same_values():
    doc, records, track = documents()
    assert len(doc["shots"]["items"]) == len(records) == 3
    assert parity_problems(doc, records, track) == []
    for shot, record in zip(doc["shots"]["items"], records):
        assert (record["shot_id"], record["timeline_id"], record["frame"]) == (shot["shot_id"], shot["id"], shot["frame"])
        assert record["image_speed"]["px_per_s"] == shot["speed"]["px_per_s"]
        assert record["label"] == shot["type"] and shot["type"] in SIX_CLASSES


def test_the_tracker_jump_is_never_a_contact_or_part_of_a_speed():
    doc, records, track = documents()
    assert 100 in {item.frame for item in track.rejected}
    assert all(abs(shot["frame"] - 100) > 3 for shot in doc["shots"]["items"])
    assert all(100 not in record["image_speed"]["frames"] for record in records)
    assert 100 in {row[0] for row in doc["observed_2d"]["rejected_points"]}
    assert doc["observed_2d"]["rejected"]["tracker_jump"] == 1


def test_official_speed_uses_confirmed_contacts_only_and_candidates_are_reported_apart():
    doc, _records, _track = documents()
    confirmed = [shot for shot in doc["shots"]["items"] if shot["contact_status"] == "confirmed"]
    assert len(confirmed) == 1
    speed = doc["summary"]["speed"]
    assert speed["official"]["count"] == 1 and speed["official"]["max_px_per_s"] == confirmed[0]["speed"]["px_per_s"]
    assert speed["candidates"]["count"] == 2 and speed["max_px_per_s"] == confirmed[0]["speed"]["px_per_s"]
    panel = doc["dashboard"]["speed_panel"]
    assert panel["official_count"] == 1 and panel["candidate_count"] == 2
    assert panel["official_max_px_per_s"] == confirmed[0]["speed"]["px_per_s"]
    p1, p2 = doc["dashboard"]["players"]["P1"], doc["dashboard"]["players"]["P2"]
    assert p1["official_max_px_per_s"] is None and p1["contacts"] == 2  # P1's contacts are candidates only
    assert p2["official_max_px_per_s"] == confirmed[0]["speed"]["px_per_s"] and p2["confirmed_contacts"] == 1
    assert speed["max_kmh"] is None and doc["speed"]["label"] == "Physical trajectory unavailable"


def test_most_frequent_shot_is_labelled_as_an_unverified_estimate():
    doc, records, _track = documents()
    estimate = doc["dashboard"]["players"]["P1"]["most_frequent_estimate"]
    assert estimate["label_kind"] == "trajectory_estimate_unverified" and estimate["badge"] == "Trajectory estimate · unverified"
    assert estimate["label"] in SIX_CLASSES and estimate["of"] == 2
    assert doc["summary"]["shots"]["estimates_by_type"][records[0]["best_guess_label"]] >= 1


def test_a_person_unknown_note_never_becomes_a_timeline_type():
    doc, records, _track = documents()
    last_shot, last_record = doc["shots"]["items"][-1], records[-1]
    assert last_shot["person_label_note"] == "unknown" and last_shot["type"] in SIX_CLASSES
    assert last_record["person_label_note"] == "unknown" and last_record["manual_label"] is None
    assert doc["summary"]["shots"]["unknown"] == 1 and doc["summary"]["shots"]["labelled"] == 0


def test_shot_interval_leaves_out_the_gap_between_rallies():
    doc, _records, _track = documents()
    shots = doc["shots"]["items"]
    assert shots[0]["rally_id"] == shots[1]["rally_id"] != shots[2]["rally_id"]
    expected = shots[1]["time_s"] - shots[0]["time_s"]
    interval = doc["summary"]["shots"]["interval_within_rally"]
    assert interval["count"] == 1 and interval["mean_s"] == pytest.approx(expected, abs=1e-3)
    assert doc["dashboard"]["speed_panel"]["shot_interval_mean_s"] == interval["mean_s"]


def test_the_distance_chart_ends_at_the_summary_distance_and_contacts_use_image_positions_without_a_court():
    doc, _records, _track = documents()
    chart = doc["dashboard"]["distance_chart"]
    assert chart["unit"] == "px"
    for identity in ("P1", "P2"):
        distance = doc["dashboard"]["players"][identity]["distance"]
        assert distance["unit"] == "px" and chart["series"][identity][-1][1] == distance["value"]
    positions = doc["dashboard"]["contact_positions"]
    assert positions["space"] == "image_normalized" and "not court metres" in positions["label"]
    assert all(0.0 <= item["x"] <= 1.0 and 0.0 <= item["y"] <= 1.0 for item in positions["items"])


def test_the_api_serves_the_same_rows_in_the_match_document_and_the_written_dataset(tmp_path):
    app = create_app(settings_for(tmp_path), start_worker=False)
    with TestClient(app) as client:
        job_id = uuid.uuid4().hex
        out = tmp_path / "outputs" / job_id
        out.mkdir(parents=True)
        files = {"results.json": results(), "player_tracks.json": {"tracks": tracks()}, "shuttle_trajectory.json": shuttle_doc(),
                 "corrections.json": {"schema": "smashlab.corrections/v1", "job_id": job_id, "entries": CORRECTIONS}}
        for name, content in files.items():
            (out / name).write_text(json.dumps(content), encoding="utf-8")
        store = app.state.store
        store.create_job(job_id, "sample", "Synthetic", "synthetic-parity", "/x.mp4", str(out))
        store.mark_running(job_id, attempts=1)
        store.mark_completed(job_id)
        built = client.post(f"/api/v1/analyses/{job_id}/shot-trajectory/build")
        assert built.status_code == 200, built.text
        assert built.json()["quality_gates"]["passed"] is True
        match = client.get(f"/api/v1/analyses/{job_id}/match").json()
        records = client.get(f"/api/v1/analyses/{job_id}/shot-trajectory/records").json()["records"]
        assert [(r["shot_id"], r["frame"], r["label"], r["image_speed"]["px_per_s"]) for r in records] == [
            (s["shot_id"], s["frame"], s["type"], s["speed"]["px_per_s"]) for s in match["shots"]["items"]]
        assert (out / "derived" / "estimated_3d.json").is_file() and (out / "derived" / "measured_3d.json").is_file()
        measured = json.loads((out / "derived" / "measured_3d.json").read_text(encoding="utf-8"))
        assert measured["status"] == "not_run"
        assert "km/h" not in (out / "derived" / D.DATASET_FILE).read_text(encoding="utf-8")
