"""Match analytics: contact candidates, de-duplication, manual reviews, the speed gate, positions and the API."""

import json
import uuid

import pytest
from fastapi.testclient import TestClient

from app.analytics.match import (
    ContactParams,
    assess_speed,
    build_match_document,
    detected_image_points,
    shot_motion,
    contact_candidates,
    detect_contacts,
    identities_for,
    player_positions,
)
from app.config import Settings
from app.main import create_app
from app.services import corrections as corrections_service

FPS = 30.0


def zigzag(turns, frames, start=(400.0, 100.0), step=10.0):
    """Image positions that move along x and reverse direction right after each frame in ``turns``."""
    points, x, y, direction = [], start[0], start[1], 1
    for frame in range(frames):
        points.append((x, y))
        if frame in turns:
            direction = -direction
        x += direction * step
    return points


def shuttle(points, interpolated=()):
    return [
        {"frame": f, "time_s": round(f / FPS, 3), "x": x, "y": y, "visible": True, "confidence": 0.8, "refined": f in interpolated}
        for f, (x, y) in enumerate(points)
    ]


def player(track_id, identity, frames, box, court=None):
    return {
        "track_id": track_id,
        "confirmed": True,
        "observations": [
            {
                "frame": f, "time_s": round(f / FPS, 3), "x1": box[0], "y1": box[1], "x2": box[2], "y2": box[3],
                "score": 0.9, "confirmed": True, "identity": identity, "identity_status": "matched", "identity_confidence": 0.9,
                "court_x_m": None if court is None else court(f)[0], "court_y_m": None if court is None else court(f)[1],
            }
            for f in frames
        ],
    }


def results_for(frames=60, mode="singles", logical=2, court_status="failed"):
    return {
        "video": {"fps": FPS, "frames_analysed": frames, "width": 640, "height": 360, "duration_s": frames / FPS},
        "players": {"mode": mode, "logical_identities": logical},
        "court": {"status": court_status, "reason": "test"},
        "shuttle": {"frames_total": frames, "frames_detected": frames},
        "identity": {"coverage": {"P1": 0.9, "P2": 0.8}},
    }


def test_a_turn_next_to_a_player_is_one_candidate_after_deduplication():
    points = zigzag({10}, 25)
    tracks = [player(1, "P1", range(25), (480, 90, 530, 250))]
    contacts, without = contact_candidates(shuttle(points), tracks, FPS)
    assert len(contacts) == 1  # frames 9, 10 and 11 all look like turns; they are one contact
    assert abs(contacts[0]["frame"] - 10) <= 1
    assert contacts[0]["player"] == "P1" and contacts[0]["status"] == "candidate" and contacts[0]["validated"] is False
    assert contacts[0]["evidence"]["turn_deg"] >= 75
    assert without == 0


def test_jitter_is_not_a_turn():
    points = [(100.0 + (f % 2), 100.0) for f in range(30)]
    tracks = [player(1, "P1", range(30), (80, 80, 140, 240))]
    contacts, _ = contact_candidates(shuttle(points), tracks, FPS)
    assert contacts == []


def test_a_turn_far_from_every_player_is_not_counted():
    points = zigzag({10}, 25)
    tracks = [player(1, "P1", range(25), (0, 300, 40, 359))]
    contacts, without = contact_candidates(shuttle(points), tracks, FPS)
    assert contacts == []
    assert without >= 1


def test_turns_a_second_apart_are_two_candidates_for_the_right_players():
    points = zigzag({10, 40}, 60)
    tracks = [
        player(1, "P1", range(0, 25), (480, 90, 530, 250)),
        player(2, "P2", range(30, 55), (180, 90, 230, 250)),
    ]
    contacts, _ = contact_candidates(shuttle(points), tracks, FPS)
    assert [c["player"] for c in contacts] == ["P1", "P2"]
    assert contacts[1]["frame"] - contacts[0]["frame"] >= 28


def test_a_turn_made_of_interpolated_points_is_ignored():
    points = zigzag({10}, 25)
    tracks = [player(1, "P1", range(25), (480, 90, 530, 250))]
    contacts, _ = contact_candidates(shuttle(points, interpolated={9, 10, 11}), tracks, FPS)
    assert contacts == []


def test_reviews_labels_and_rally_edits_are_applied_without_touching_raw_candidates():
    points = zigzag({10, 40}, 60)
    tracks = [player(1, "P1", range(0, 25), (480, 90, 530, 250)), player(2, "P2", range(30, 55), (180, 90, 230, 250))]
    rallies = {"status": "heuristic_candidates", "rallies": [{"index": 1, "start_frame": 0, "end_frame": 59}]}
    first = contact_candidates(shuttle(points), tracks, FPS)[0][0]["frame"]
    corrections = [
        {"id": "a", "type": "contact_review", "frame": first, "decision": "confirmed"},
        {"id": "b", "type": "shot_label", "frame": first, "shot_type": "smash"},
        {"id": "c", "type": "contact_review", "frame": 41, "decision": "rejected"},
        {"id": "d", "type": "contact_review", "frame": 55, "decision": "added", "player": "P1"},
        {"id": "e", "type": "rally_boundary", "rally_index": 1, "start_frame": 2, "end_frame": 58},
    ]
    doc = build_match_document(
        job_id="j", results=results_for(), tracks_doc={"tracks": tracks}, shuttle_doc={"frames": shuttle(points)},
        rallies_doc=rallies, corrections=corrections,
    )
    statuses = [(c["status"], c["source"]) for c in doc["contacts"]["items"]]
    assert statuses == [("confirmed", "heuristic"), ("rejected", "heuristic"), ("confirmed", "manual")]
    shots = doc["shots"]["items"]
    assert [s["type"] for s in shots] == ["smash", "unknown"]  # the rejected contact has no shot
    assert shots[0]["validation"] == "manual" and shots[1]["validation"] == "unclassified"
    rally = doc["rallies"]["items"][0]
    assert (rally["start_frame"], rally["end_frame"], rally["source"]) == (2, 58, "manual")
    assert rally["hits_by_player"] == {"P1": 2, "P2": 0}
    assert rally["winner"] is None
    summary_contacts = dict(doc["summary"]["contacts"])
    # The detector's own rejections are counted before any manual review, so they must match the raw list.
    assert summary_contacts.pop("rejected_automatic") == len(doc["contacts"]["rejected"])
    assert summary_contacts == {
        "counted": 2, "candidates": 0, "confirmed": 2, "rejected": 1, "turns_without_player": 0, "same_player_twice": 1,
    }
    assert shots[0]["flags"] == [] and shots[1]["flags"] == ["same_player_twice"]  # P1 at the start and P1 again at 55
    # Statistics count person labels only; a contact with no estimate and no label is not counted as a stroke.
    assert doc["summary"]["shots"]["by_type"]["smash"] == 1 and doc["summary"]["shots"]["unknown"] == 0


def test_match_level_speed_policy():
    calibrated = assess_speed("calibrated")
    assert calibrated["status"] == "image_space" and calibrated["kmh"] is None
    assert any(c["id"] == "contact_confirmed" for c in calibrated["conditions"])
    uncalibrated = assess_speed("failed")
    assert uncalibrated["status"] == "image_space" and uncalibrated["kmh"] is None


def linear_shuttle(frames, step_px=30.0, refined=False):
    """Image points moving along x at a constant speed; with a 100 px/m homography that is step_px/100 m per frame."""
    return [
        {"frame": f, "time_s": round(f / FPS, 3), "x": 200.0 + step_px * f, "y": 300.0, "visible": True, "confidence": 0.9, "refined": refined}
        for f in range(frames)
    ]


H_100PX_PER_M = [[100.0, 0.0, 0.0], [0.0, 100.0, 0.0], [0.0, 0.0, 1.0]]


def test_shuttle_motion_is_image_space_only_and_refused_without_enough_points():
    image = detected_image_points(linear_shuttle(12))
    result = shot_motion(5, image, FPS)
    assert result["px_per_s"] == pytest.approx(900.0, abs=0.05)
    assert result["kmh"] is None and result["kind"] == "image_space" and result["points"] == 7
    assert result["physical_speed_available"] is False
    assert shot_motion(5, {}, FPS)["px_per_s"] is None
    assert "Only 0" in shot_motion(5, {}, FPS)["reason"]


def test_refined_points_alone_give_no_motion_measurement():
    image = detected_image_points(linear_shuttle(12, refined=True))
    assert image == {}
    assert shot_motion(5, image, FPS)["px_per_s"] is None


def test_headline_motion_is_measured_only_for_confirmed_contacts():
    shuttle = {"frames": linear_shuttle(20)}
    tracks = [player(1, "P1", range(20), (100, 100, 150, 250))]
    confirmed = build_match_document(
        job_id="j", results=results_for(frames=20, court_status="calibrated"), tracks_doc={"tracks": tracks},
        shuttle_doc=shuttle, rallies_doc=None,
        corrections=[{"id": "c1", "type": "contact_review", "frame": 10, "decision": "added", "player": "P1"}],
        court_doc={"homography_image_from_court": H_100PX_PER_M},
    )
    shot = confirmed["shots"]["items"][0]
    assert shot["contact_status"] == "confirmed" and shot["speed"]["px_per_s"] == pytest.approx(900.0, abs=0.05)
    assert shot["speed"]["kmh"] is None
    assert confirmed["summary"]["speed"]["max_px_per_s"] == pytest.approx(900.0, abs=0.05)
    assert confirmed["summary"]["speed"]["measured_shots"] == 1
    candidate = build_match_document(
        job_id="j", results=results_for(frames=60, court_status="calibrated"),
        tracks_doc={"tracks": [player(1, "P1", range(25), (480, 90, 530, 250))]},
        shuttle_doc={"frames": shuttle_points_for_candidate()}, rallies_doc=None, corrections=[],
        court_doc={"homography_image_from_court": H_100PX_PER_M},
    )
    assert candidate["summary"]["speed"]["max_px_per_s"] is None
    assert all(item["speed"] is None or item["speed"]["kmh"] is None for item in candidate["shots"]["items"])


def shuttle_points_for_candidate():
    return shuttle(zigzag({10}, 25))


def test_uncalibrated_court_still_gives_image_motion_but_never_kmh():
    doc = build_match_document(
        job_id="j", results=results_for(frames=20), tracks_doc={"tracks": []}, shuttle_doc={"frames": linear_shuttle(20)},
        rallies_doc=None,
        corrections=[{"id": "c1", "type": "contact_review", "frame": 10, "decision": "added", "player": "P1"}],
    )
    speed = doc["summary"]["speed"]
    assert speed["max_kmh"] is None and speed["max_px_per_s"] == pytest.approx(900.0, abs=0.05)
    assert speed["by_basis"] == {"confirmed_contact": 1, "automatic_candidate": 0}
    assert doc["shots"]["items"][0]["speed"]["kind"] == "image_space"


def test_positions_keep_tracking_status_but_no_metres_without_calibration():
    tracks = [player(1, "P1", range(30), (100, 100, 150, 250), court=lambda f: (1.0, 2.0))]
    result = player_positions(tracks, ("P1", "P2"), FPS, calibrated=False)
    assert result["series"]["P1"] and all(point[1] is None and point[2] is None for point in result["series"]["P1"])
    assert result["series"]["P1"][0][3] == "matched"
    assert result["players"]["P1"]["distance_m"] is None
    assert result["series"]["P2"] == []


def test_distance_uses_smoothed_feet_and_skips_impossible_jumps():
    def walk(f):  # 1.5 m walk, then a jump of about 9 m
        return (1.0 + 0.05 * f, 3.0) if f < 30 else (6.0, 12.0)

    tracks = [player(1, "P1", range(60), (100, 100, 150, 250), court=walk)]
    result = player_positions(tracks, ("P1", "P2"), FPS, calibrated=True)
    assert 1.0 <= result["players"]["P1"]["distance_m"] <= 2.0
    assert result["players"]["P1"]["jumps_skipped"] >= 1
    assert result["step_frames"] == 2


def test_doubles_reports_four_players_including_p4():
    assert identities_for("doubles", 4) == ("P1", "P2", "P3", "P4")
    assert identities_for("auto", 4) == ("P1", "P2", "P3", "P4")
    tracks = [player(i + 1, f"P{i + 1}", range(20), (50 * i, 100, 50 * i + 40, 250)) for i in range(4)]
    doc = build_match_document(
        job_id="j", results=results_for(frames=20, mode="doubles", logical=4), tracks_doc={"tracks": tracks},
        shuttle_doc={"frames": []}, rallies_doc=None, corrections=[],
    )
    assert doc["players"] == ["P1", "P2", "P3", "P4"]
    assert set(doc["summary"]["players"]) == {"P1", "P2", "P3", "P4"}
    assert doc["positions"]["series"]["P4"] and doc["positions"]["court_available"] is False
    assert doc["court"]["map_available"] is False and doc["speed"]["status"] == "image_space"


@pytest.mark.parametrize(
    "payload",
    [
        {"type": "contact_review", "frame": 5, "decision": "confirmed"},
        {"type": "contact_review", "frame": 5, "decision": "added", "player": "P2"},
        {"type": "shot_label", "frame": 5, "shot_type": "net_shot", "player": "P1"},
        {"type": "rally_boundary", "rally_index": 1, "start_frame": 0, "end_frame": 9},
        {"type": "rally_boundary", "start_frame": 3, "end_frame": 9},
    ],
)
def test_analytics_corrections_accept_valid_entries(payload):
    corrections_service.validate(payload, frames_total=10, width=640, height=360, players=2)


@pytest.mark.parametrize(
    "payload",
    [
        {"type": "contact_review", "frame": 10, "decision": "confirmed"},
        {"type": "contact_review", "frame": 5, "decision": "maybe"},
        {"type": "contact_review", "frame": 5, "decision": "added"},
        {"type": "shot_label", "frame": 5, "shot_type": "laser"},
        {"type": "shot_label", "frame": 5, "shot_type": "smash", "player": "P4"},
        {"type": "rally_boundary", "start_frame": 9, "end_frame": 9},
    ],
)
def test_analytics_corrections_reject_bad_entries(payload):
    with pytest.raises(corrections_service.CorrectionError):
        corrections_service.validate(payload, frames_total=10, width=640, height=360, players=2)


def settings_for(tmp_path) -> Settings:
    return Settings(
        input_dir=str(tmp_path / "input"),
        samples_dir=str(tmp_path / "input" / "samples"),
        samples_manifest=str(tmp_path / "input" / "manifest.json"),
        models_dir=str(tmp_path / "models"),
        outputs_dir=str(tmp_path / "outputs"),
        db_path=str(tmp_path / "outputs" / "db" / "jobs.sqlite"),
        max_upload_bytes=5 * 1024 * 1024,
        max_duration_s=30.0,
        job_timeout_s=60.0,
        lease_seconds=60.0,
        max_attempts=2,
        onnx_threads=1,
        cors_origins=["http://localhost:3000"],
    )


def test_match_endpoint_and_analytics_corrections_need_no_recompute(tmp_path):
    app = create_app(settings_for(tmp_path), start_worker=False)
    with TestClient(app) as client:
        job_id = uuid.uuid4().hex
        out = tmp_path / "outputs" / job_id
        out.mkdir(parents=True)
        points = zigzag({10}, 60)
        files = {
            "results.json": results_for(),
            "player_tracks.json": {"tracks": [player(1, "P1", range(25), (480, 90, 530, 250))]},
            "shuttle_trajectory.json": {"frames": shuttle(points)},
            "rallies.json": {"status": "heuristic_candidates", "rallies": [{"index": 1, "start_frame": 0, "end_frame": 59}]},
        }
        for name, content in files.items():
            (out / name).write_text(json.dumps(content), encoding="utf-8")
        store = app.state.store
        store.create_job(job_id, "sample", "Synthetic", "synthetic", "/x.mp4", str(out))
        store.mark_running(job_id, attempts=1)
        store.mark_completed(job_id)

        response = client.get(f"/api/v1/analyses/{job_id}/match")
        assert response.status_code == 200
        doc = response.json()
        assert doc["schema"] == "smashlab.match/v1" and doc["speed"]["kmh"] is None
        frame = doc["contacts"]["items"][0]["frame"]

        saved = client.post(f"/api/v1/analyses/{job_id}/corrections", json={"type": "shot_label", "frame": frame, "shot_type": "clear"})
        assert saved.status_code == 201 and saved.json()["recomputed"] is False
        relabelled = client.get(f"/api/v1/analyses/{job_id}/match").json()
        assert relabelled["shots"]["items"][0]["type"] == "clear"
        assert relabelled["shots"]["items"][0]["validation"] == "manual"

        bad = client.post(f"/api/v1/analyses/{job_id}/corrections", json={"type": "shot_label", "frame": frame, "shot_type": "laser"})
        assert bad.status_code == 422
        assert client.get(f"/api/v1/analyses/{uuid.uuid4().hex}/match").status_code == 404


def test_contact_params_are_documented_in_the_method_text():
    doc = build_match_document(
        job_id="j", results=results_for(), tracks_doc=None, shuttle_doc=None, rallies_doc=None, corrections=[],
        params=ContactParams(min_turn_deg=80.0),
    )
    assert "80 degrees" in doc["contacts"]["method"]
    assert doc["contacts"]["items"] == [] and doc["rallies"]["items"] == []


# --- automatic contacts, rejection reasons and the speed basis


def test_rejected_turns_carry_a_reason_and_merged_turns_name_their_survivor():
    points = zigzag({10, 40}, 60)
    far = [player(1, "P1", range(0, 60), (0, 300, 40, 359))]  # no player near the turns: all rejected
    contacts, rejected = detect_contacts(shuttle(points), far, FPS)
    assert contacts == []
    assert rejected and all(item["reason"] == "no tracked player within reach" for item in rejected)
    assert all(item["nearest_player_px"] is not None for item in rejected)
    near = [player(1, "P1", range(0, 25), (480, 90, 530, 250))]
    contacts, rejected = detect_contacts(shuttle(zigzag({10, 12}, 25)), near, FPS)
    assert len(contacts) == 1
    assert contacts[0]["score"] > 0 and contacts[0]["score_kind"].startswith("heuristic")
    merged = [item for item in rejected if item["reason"].startswith("merged into the stronger turn")]
    assert len(merged) == len(rejected) and all(f"frame {contacts[0]['frame']}" in item["reason"] for item in merged)


def test_automatic_candidates_get_unverified_image_motion_and_confirmed_ones_are_labelled_so():
    # The shuttle travels along the court length (image y), 0.3 m per frame toward the far side.
    shuttle_doc = {"frames": [
        {"frame": f, "time_s": round(f / FPS, 3), "x": 200.0, "y": 300.0 + 30.0 * f, "visible": True, "confidence": 0.9, "refined": False}
        for f in range(40)
    ]}
    tracks = [player(1, "P1", range(20), (100, 100, 150, 250))]
    homography = [[100.0, 0.0, 0.0], [0.0, 100.0, 0.0], [0.0, 0.0, 1.0]]
    doc = build_match_document(
        job_id="j", results=results_for(frames=20, court_status="calibrated"), tracks_doc={"tracks": tracks},
        shuttle_doc=shuttle_doc, rallies_doc=None, corrections=[],
        court_doc={"homography_image_from_court": homography},
    )
    assert doc["summary"]["speed"]["by_basis"] == {"confirmed_contact": 0, "automatic_candidate": 0}
    confirmed = build_match_document(
        job_id="j", results=results_for(frames=20, court_status="calibrated"), tracks_doc={"tracks": tracks},
        shuttle_doc=shuttle_doc, rallies_doc=None,
        corrections=[{"id": "c1", "type": "contact_review", "frame": 10, "decision": "added", "player": "P1"}],
        court_doc={"homography_image_from_court": homography},
    )
    shot = confirmed["shots"]["items"][0]
    assert shot["speed"]["basis"] == "confirmed_contact" and shot["speed"]["kmh"] is None
    assert confirmed["summary"]["speed"]["by_basis"]["confirmed_contact"] == 1


def test_a_manual_shot_label_is_never_replaced_by_a_suggestion():
    homography = [[100.0, 0.0, 0.0], [0.0, 100.0, 0.0], [0.0, 0.0, 1.0]]
    doc = build_match_document(
        job_id="j", results=results_for(frames=20, court_status="calibrated"),
        tracks_doc={"tracks": [player(1, "P1", range(20), (100, 100, 150, 250))]},
        shuttle_doc={"frames": linear_shuttle(20)}, rallies_doc=None,
        corrections=[
            {"id": "c1", "type": "contact_review", "frame": 10, "decision": "added", "player": "P1"},
            {"id": "c2", "type": "shot_label", "frame": 10, "shot_type": "drop"},
        ],
        court_doc={"homography_image_from_court": homography},
    )
    shot = doc["shots"]["items"][0]
    assert shot["type"] == "drop" and shot["type_source"] == "manual" and shot["validation"] == "manual"


def test_a_hit_frame_is_recorded_on_the_nearest_contact_and_nothing_else_changes():
    points = zigzag({10, 40}, 60)
    tracks = [player(1, "P1", range(0, 25), (480, 90, 530, 250)), player(2, "P2", range(30, 55), (180, 90, 230, 250))]
    rallies = {"status": "heuristic_candidates", "rallies": [{"index": 1, "start_frame": 0, "end_frame": 59}]}
    first = contact_candidates(shuttle(points), tracks, FPS)[0][0]["frame"]
    corrections = [{"id": "h", "type": "hit_frame", "frame": first, "hit_frame": first - 2}]
    doc = build_match_document(
        job_id="j", results=results_for(), tracks_doc={"tracks": tracks}, shuttle_doc={"frames": shuttle(points)},
        rallies_doc=rallies, corrections=corrections,
    )
    hits = [shot["hit_frame"] for shot in doc["shots"]["items"]]
    assert hits[0] == first - 2 and all(h is None for h in hits[1:])
    assert doc["shots"]["items"][0]["frame"] == first  # the candidate frame itself is never moved


def test_a_trajectory_estimate_never_replaces_a_person_label_and_is_marked_unverified():
    points = zigzag({10, 40}, 60)
    tracks = [player(1, "P1", range(0, 25), (480, 90, 530, 250)), player(2, "P2", range(30, 55), (180, 90, 230, 250))]
    rallies = {"status": "heuristic_candidates", "rallies": [{"index": 1, "start_frame": 0, "end_frame": 59}]}
    contacts = contact_candidates(shuttle(points), tracks, FPS)[0]
    first, second = contacts[0]["frame"], contacts[1]["frame"]

    def record(frame, label):
        return {"best_guess_label": label, "evidence_tier": "full_trajectory", "evidence_quality": "medium",
                "review_status": "needs_review", "top3": [[label, 0.4]], "shot_id": f"j-frame-{frame}", "rule_version": "trajectory-rules/v1"}

    trajectory = {first: record(first, "clear"), second: record(second, "smash")}
    corrections = [{"id": "m", "type": "shot_label", "frame": second, "shot_type": "drop"}]
    doc = build_match_document(
        job_id="j", results=results_for(), tracks_doc={"tracks": tracks}, shuttle_doc={"frames": shuttle(points)},
        rallies_doc=rallies, corrections=corrections, trajectory=trajectory,
    )
    first_shot, second_shot = doc["shots"]["items"][0], doc["shots"]["items"][1]
    assert first_shot["type"] == "clear" and first_shot["type_source"] == "trajectory_estimate"
    assert first_shot["validation"] == "trajectory_unverified" and first_shot["trajectory"]["review_status"] == "needs_review"
    assert second_shot["type"] == "drop" and second_shot["type_source"] == "manual"  # the person's label wins
    assert second_shot["trajectory"]["best_guess_label"] == "smash"  # kept beside the label, not applied
    assert doc["summary"]["shots"]["by_type"]["clear"] == 0  # statistics count person labels only