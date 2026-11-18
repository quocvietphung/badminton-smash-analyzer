"""trajectory-rules/v1: six classes from synthetic fixtures, tiers, gates, integrity, dataset alignment and isolation.

The fixtures test the algorithm. They are not evidence for real footage and are never mixed into a video result.
"""

import hashlib
import json
import math

import pytest

from app.analytics import trajectory_rules as R
from app.services import shot_dataset as D
from tests.fixtures import trajectory_fixtures as F


def _classify(shuttle, *, frame=F.CONTACT, foot=None, cal=False, status="confirmed"):
    track = R.build_track(shuttle, conf_threshold=0.5)
    return R.classify_contact(track, frame, fps=F.FPS, width=F.WIDTH, height=F.HEIGHT, speed_ref=F.SPEED_REF,
                              player_foot=foot, court_calibrated=cal, contact_status=status)


@pytest.mark.parametrize("label", R.CLASSES)
def test_each_stroke_fixture_gets_its_expected_six_class_label(label):
    result = _classify(F.stroke_shuttle(label), foot=F.player_context(label), cal=True)
    assert result["best_guess_label"] == label
    assert result["evidence_tier"] == "full_trajectory"
    assert set(result["scores"]) == set(R.CLASSES)
    assert len(result["top3"]) == 3 and result["top3"][0][0] == label
    assert result["review_reasons"] or result["review_status"] == "accepted_by_gate"


@pytest.mark.parametrize("label", R.CLASSES)
def test_the_same_input_always_gives_the_same_output(label):
    first = _classify(F.stroke_shuttle(label), foot=F.player_context(label), cal=True)
    second = _classify(F.stroke_shuttle(label), foot=F.player_context(label), cal=True)
    assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)


def test_no_unknown_serve_push_or_defensive_block_is_ever_produced():
    for label in R.CLASSES:
        result = _classify(F.stroke_shuttle(label), foot=F.player_context(label), cal=True)
        assert result["best_guess_label"] in R.CLASSES
        assert result["best_guess_label"] not in ("unknown", "serve", "push", "defensive_block")
    partial = _classify(F.partial_shuttle(), foot=(3.0, 9.5), cal=True)
    fallback = _classify(F.fallback_shuttle())
    assert partial["best_guess_label"] in R.CLASSES and fallback["best_guess_label"] in R.CLASSES


def test_partial_and_fallback_tiers_still_score_all_six_classes():
    partial = _classify(F.partial_shuttle(), foot=(3.0, 9.5), cal=True)
    assert partial["evidence_tier"] == "partial_trajectory" and partial["evidence_quality"] in ("low", "medium")
    assert set(partial["scores"]) == set(R.CLASSES)
    fallback = _classify(F.fallback_shuttle())
    assert fallback["evidence_tier"] == "contact_fallback" and fallback["evidence_quality"] == "low"
    assert set(fallback["scores"]) == set(R.CLASSES)
    assert fallback["review_status"] == "needs_review"
    assert "contact_net_m" in fallback["missing_features"]  # no court calibration in the fallback fixture


def test_no_usable_data_is_a_pipeline_integrity_error_not_a_default_label():
    with pytest.raises(R.PipelineIntegrityError) as caught:
        _classify(F.empty_shuttle())
    assert caught.value.code == "shot_trajectory_insufficient_data"


def test_an_unconfirmed_contact_is_never_accepted():
    result = _classify(F.stroke_shuttle("clear"), foot=F.player_context("clear"), cal=True, status="candidate")
    assert result["review_status"] == "needs_review"
    assert "contact is not confirmed by a person" in result["review_reasons"]


def test_a_label_that_changes_when_the_contact_moves_by_two_frames_needs_review(monkeypatch):
    original = R._classify_features

    def shifted(track, frame, tier, kwargs, config):
        return "lift" if frame != F.CONTACT - 2 else original(track, frame, tier, kwargs, config)

    monkeypatch.setattr(R, "_classify_features", lambda track, frame, tier, kwargs, config:
                        "lift" if frame == F.CONTACT + 2 else original(track, frame, tier, kwargs, config))
    result = _classify(F.stroke_shuttle("clear"), foot=F.player_context("clear"), cal=True)
    assert result["review_status"] == "needs_review"
    assert any("shifted by two frames" in reason for reason in result["review_reasons"])


def test_speeds_are_image_pixels_per_second_and_never_converted_to_kmh():
    shuttle = F.stroke_shuttle("drive")
    result = _classify(shuttle, foot=F.player_context("drive"), cal=True)
    speed = result["features"]["speed_after_median_px_s"]
    assert speed == pytest.approx(math.hypot(1100.0, 20.0), rel=0.02)
    assert "kmh" not in json.dumps(result).lower() and "km/h" not in json.dumps(result).lower()


def test_feature_contract_contains_the_required_fields():
    features = _classify(F.stroke_shuttle("smash"), foot=F.player_context("smash"), cal=True)["features"]
    required = {"valid_points_before", "valid_points_after", "valid_ratio_before", "valid_ratio_after", "missing_runs_after",
                "interpolated_points", "speed_before_median_px_s", "speed_before_max_px_s", "speed_after_median_px_s",
                "speed_after_max_px_s", "speed_change_ratio", "initial_direction", "horizontal_component_px_s",
                "vertical_component_px_s", "apex_time_s", "rise_norm", "descent_norm", "flight_s", "curvature_rad",
                "length_norm", "straightness", "player_side", "contact_net_m", "vertical_travel_norm"}
    assert required <= set(features)


# ---- dataset: alignment with the timeline, isolation between jobs, raw outputs untouched -------------------------

def _doc(job_id, shots, foot_by_player, calibrated=True):
    positions = {player: [[frame, foot[0], foot[1], "matched"] for frame in range(0, F.CONTACT + 80)]
                 for player, foot in foot_by_player.items()}
    return {"job_id": job_id, "fps": F.FPS, "court": {"status": "calibrated" if calibrated else "failed"},
            "positions": {"series": positions},
            "shots": {"items": shots}}


def _shot(frame, player="P1", type_="unknown", type_source="none", validation="unclassified"):
    return {"id": f"s{frame}", "contact_id": f"c{frame}", "frame": frame, "time_s": round(frame / F.FPS, 3), "player": player,
            "type": type_, "type_source": type_source, "validation": validation, "contact_status": "candidate"}


def test_dataset_has_one_record_per_timeline_row_with_matching_frame_and_time():
    shuttle = F.stroke_shuttle("clear")
    doc = _doc("job-a", [_shot(F.CONTACT), _shot(F.CONTACT + 15)], {"P1": (3.0, 12.0)})
    records, meta = D.build_records(doc, shuttle, job_id="job-a", run_id="test-run")
    assert len(records) == len(doc["shots"]["items"])
    for record, shot in zip(records, doc["shots"]["items"]):
        assert record["frame"] == shot["frame"]
        assert record["timestamp_s"] == pytest.approx(shot["time_s"], abs=1e-3)
        assert record["best_guess_label"] in R.CLASSES
        assert record["schema"] == D.SCHEMA and record["rule_version"] == R.RULE_VERSION
        assert record["shot_id"].startswith("job-a-frame-") and record["job_id"] == "job-a"
        assert record["label_kind"] == "trajectory_estimate_unverified"


def test_a_person_label_is_kept_beside_the_estimate_and_never_used_as_it():
    shuttle = F.stroke_shuttle("lift")
    doc = _doc("job-m", [_shot(F.CONTACT, type_="smash", type_source="manual", validation="manual")], {"P1": (3.0, 7.5)})
    records, _ = D.build_records(doc, shuttle, job_id="job-m", run_id="t")
    assert records[0]["manual_label"] == "smash"
    assert records[0]["best_guess_label"] == "lift"


def test_jobs_are_isolated_each_record_comes_from_its_own_shuttle_file():
    doc_a = _doc("job-a", [_shot(F.CONTACT)], {"P1": (3.0, 12.0)})
    doc_b = _doc("job-b", [_shot(F.CONTACT)], {"P1": (3.0, 12.0)})
    rec_a, _ = D.build_records(doc_a, F.stroke_shuttle("smash"), job_id="job-a", run_id="t")
    rec_b, _ = D.build_records(doc_b, F.stroke_shuttle("drive"), job_id="job-b", run_id="t")
    assert rec_a[0]["best_guess_label"] == "smash" and rec_b[0]["best_guess_label"] == "drive"
    assert rec_a[0]["job_id"] == "job-a" and rec_b[0]["job_id"] == "job-b"


def test_writing_the_dataset_touches_only_derived_and_keeps_raw_files_identical(tmp_path):
    raw = {"shuttle_trajectory.json": F.stroke_shuttle("smash"), "analysis.json": {"x": 1}, "shots.json": {"items": []},
           "model_execution.json": {"m": 1}, "corrections.json": {"entries": []}}
    for name, value in raw.items():
        (tmp_path / name).write_text(json.dumps(value), encoding="utf-8")
    before = {name: hashlib.sha256((tmp_path / name).read_bytes()).hexdigest() for name in raw}
    doc = _doc("job-w", [_shot(F.CONTACT, player="P1"), _shot(F.CONTACT + 15, player="P2")], {"P1": (3.0, 12.0), "P2": (3.0, 12.0)})
    summary = D.write_dataset(str(tmp_path), job_id="job-w", doc=doc, shuttle_doc=raw["shuttle_trajectory.json"], court_doc=None,
                              video={"width": F.WIDTH, "height": F.HEIGHT, "fps": F.FPS})
    after = {name: hashlib.sha256((tmp_path / name).read_bytes()).hexdigest() for name in raw}
    assert before == after
    lines = (tmp_path / "derived" / D.DATASET_FILE).read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 2 and summary["records"] == 2
    assert all(json.loads(line)["job_id"] == "job-w" for line in lines)
    assert set(summary["label_distribution"]) == set(R.CLASSES)


def test_a_timeline_row_without_any_shuttle_data_stops_the_dataset_build(tmp_path):
    doc = _doc("job-x", [_shot(F.CONTACT + 60)], {"P1": (3.0, 12.0)})
    with pytest.raises(R.PipelineIntegrityError):
        D.build_records(doc, F.stroke_shuttle("clear"), job_id="job-x", run_id="t")
