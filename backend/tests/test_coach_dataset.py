"""coach-dataset/v1: movement on the court (or image pixels), the shot timeline per player, and nothing invented."""

import json

from app.analytics import trajectory_rules as R
from app.services import coach_dataset as C


def _record(frame, player, label, speed, manual=None, status="needs_review"):
    return {
        "timestamp_s": round(frame / 30, 3), "frame": frame, "player": player, "contact_status": "candidate",
        "best_guess_label": label, "manual_label": manual, "review_status": status, "evidence_tier": "full_trajectory",
        "evidence_quality": "high", "top3": [[label, 0.3]], "review_reasons": ["contact is not confirmed by a person"],
        "features": {"speed_after_median_px_s": speed, "speed_after_max_px_s": speed * 2, "initial_direction": "up-right",
                     "apex_time_s": 0.4, "observed_flight_s": 1.0},
        "player_court_context": {"relative_to_net": "back_court"},
    }


def _tracks(p1_path, p2_path):
    observations = {"P1": [], "P2": []}
    for player, step in (("P1", p1_path), ("P2", p2_path)):
        for i in range(10):
            observations[player].append({"frame": i, "identity": player, "x1": 100 + i * step, "y1": 100,
                                         "x2": 120 + i * step, "y2": 200})
    return {"tracks": [{"observations": observations["P1"]}, {"observations": observations["P2"]}]}


def _match(calibrated, p1_m, p2_m):
    series = {"P1": [[i, 2.0, 12.0 - i * 0.1, "matched"] for i in range(10)],
              "P2": [[i, 3.0, 8.0 - i * 0.1, "matched"] for i in range(10)]}
    return {"court": {"status": "calibrated" if calibrated else "failed", "template": "doubles"},
            "summary": {"players": {"P1": {"distance_m": p1_m, "coverage": 0.9}, "P2": {"distance_m": p2_m, "coverage": 0.95}}},
            "positions": {"series": series}}


def test_movement_leader_uses_floor_metres_when_calibrated():
    doc = C.build(job_id="j", match_doc=_match(True, 20.0, 25.0), records=[], tracks_doc=_tracks(3, 3), results={}, fps=30.0)
    movement = doc["movement_comparison"]
    assert movement["metric"] == "court_distance_m" and movement["more_movement"] == "P2"
    assert movement["difference_percent"] == 25.0
    assert doc["players"]["P2"]["movement"]["court_zone_share"]["back_court"] == 0.0 or doc["players"]["P2"]["movement"]["court_zone_share"] is not None


def test_without_calibration_movement_is_image_pixels_and_no_metres_are_invented():
    doc = C.build(job_id="j", match_doc=_match(False, None, None), records=[], tracks_doc=_tracks(2, 6), results={}, fps=30.0)
    movement = doc["movement_comparison"]
    assert movement["metric"] == "image_path_px" and movement["more_movement"] == "P2"
    for player in ("P1", "P2"):
        assert doc["players"][player]["movement"]["court_distance_m"] is None
        assert doc["players"][player]["movement"]["court_zone_share"] is None


def test_shots_are_listed_per_player_with_estimates_kept_apart_from_person_labels():
    records = [_record(60, "P1", "smash", 1500.0), _record(120, "P2", "clear", 600.0),
               _record(180, "P2", "lift", 500.0, manual="drop", status="accepted_by_gate")]
    doc = C.build(job_id="j", match_doc=_match(True, 10.0, 12.0), records=records, tracks_doc=_tracks(1, 1), results={}, fps=30.0)
    assert [s["frame"] for s in doc["shots"]] == [60, 120, 180]
    assert doc["players"]["P2"]["contacts"] == 2 and doc["players"]["P2"]["shot_estimates"]["lift"] == 1
    assert doc["players"]["P2"]["manual_labels"] == {"drop": 1}
    assert doc["shots"][2]["label_kind"] == "trajectory_estimate_unverified" and doc["shots"][2]["manual_label"] == "drop"
    assert doc["shot_counts"] == {"rows": 3, "accepted_by_gate": 1, "needs_review": 2, "person_labelled": 1}


def test_every_label_is_a_product_stroke_and_no_speed_is_kmh():
    records = [_record(60, "P1", "net_shot", 300.0)]
    doc = C.build(job_id="j", match_doc=_match(True, 10.0, 12.0), records=records, tracks_doc=_tracks(1, 1), results={}, fps=30.0)
    assert all(s["estimate_label"] in R.CLASSES for s in doc["shots"])
    assert "kmh" not in json.dumps(doc).lower()  # the limitations text may say "never km/h"; no speed value is in km/h
    assert "unknown" not in json.dumps(doc["shots"])


def test_doubles_reports_all_four_identities_and_compares_the_most_and_least_movement():
    tracks = {"tracks": [
        {"observations": [{"frame": i, "identity": identity, "x1": 100 + i * step, "y1": 100, "x2": 120 + i * step, "y2": 200}
                          for i in range(10)]}
        for identity, step in (("P1", 4), ("P2", 6), ("P3", 12), ("P4", 2))
    ]}
    match = {**_match(False, None, None), "mode": "doubles"}
    records = [_record(10, "P3", "smash", 800.0), _record(40, "P4", "lift", 300.0)]
    data = C.build(job_id="job-d", match_doc=match, records=records, tracks_doc=tracks, results={}, fps=30.0)
    assert sorted(data["players"]) == ["P1", "P2", "P3", "P4"]
    assert data["players"]["P3"]["contacts"] == 1 and data["players"]["P3"]["shot_estimates"]["smash"] == 1
    movement = data["movement_comparison"]
    assert movement["metric"] == "image_path_px" and sorted(movement["values"]) == ["P1", "P2", "P3", "P4"]
    assert movement["compared"] == ["P3", "P4"] and movement["more_movement"] == "P3"
    assert movement["difference_percent"] == round((12 * 9 - 2 * 9) / (2 * 9) * 100, 1)


def test_singles_still_compares_p1_with_p2_only():
    data = C.build(job_id="job-s", match_doc=_match(True, 27.55, 29.17), records=[], tracks_doc=_tracks(4, 6), results={}, fps=30.0)
    assert sorted(data["players"]) == ["P1", "P2"]
    assert data["movement_comparison"]["compared"] == ["P2", "P1"]
