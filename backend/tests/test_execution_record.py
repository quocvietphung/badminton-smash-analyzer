"""Model execution record: every executed flag must follow the counters the pipeline increments."""

from types import SimpleNamespace

from app.pipeline.execution import SCHEMA, build_model_execution, tracker_parameters


def fake_models(inpaint=True):
    models = {
        "tracknet": SimpleNamespace(
            file_name="tracknetv3_tracknet.onnx",
            onnx_sha256="a" * 64,
            checkpoint_sha256="b" * 64,
            seq_len=8,
            providers=["CPUExecutionProvider"],
        ),
        "detector": SimpleNamespace(providers=["CPUExecutionProvider"], nms_threshold=0.45),
        "yolox_file": "object_detection_yolox_2022nov.onnx",
        "yolox_sha256": "c" * 64,
        "detector_conf": 0.35,
        "detector_nms": 0.45,
        "inpaint_available": inpaint,
    }
    if inpaint:
        models["inpaint"] = SimpleNamespace(providers=["CPUExecutionProvider"])
        models["inpaint_file"] = "tracknetv3_inpaintnet.onnx"
        models["inpaint_sha256"] = "d" * 64
    return models


def counters(**overrides):
    values = dict(
        detector_calls=450,
        detector_seconds=170.0,
        derived_frames=450,
        analysed_frames=450,
        inpaint_applied=True,
        tracknet_windows=57,
        tracknet_batch=1,
        tracks_total=3,
        tracks_confirmed=3,
        logical_identities=2,
        identity_gate=2.0,
        identity_events=4,
        court_status="calibrated",
        court_score=0.8958,
        court_coverage=1.0,
        court_source="auto",
        derive_seconds=17.6,
    )
    values.update(overrides)
    return values


def record(models=None, **overrides):
    return build_model_execution(
        job_id="a" * 32,
        device="cpu",
        threads=4,
        runtime={"onnxruntime": "1.32.0"},
        models=models or fake_models(),
        counters=counters(**overrides),
        timings={"background": 6.0, "analyse": 300.0, "refine": 0.2, "analytics": 17.6},
        metrics={"wall_seconds": 330.0, "frames_per_second": 1.36, "peak_rss_mb": 1100.0, "cpu_utilisation_mean": 3.0},
    )


def test_models_that_ran_are_flagged_from_their_counters():
    doc = record()
    assert doc["schema"] == SCHEMA
    assert doc["models"]["player_detector"]["executed"] is True
    assert doc["models"]["player_detector"]["frames_processed"] == 450
    assert doc["models"]["shuttle_detector"]["executed"] is True
    assert doc["models"]["shuttle_detector"]["windows_processed"] == 57
    assert doc["models"]["player_tracker"]["executed"] is True
    assert doc["models"]["identity_matcher"]["executed"] is True


def test_a_model_without_calls_is_not_reported_as_run():
    doc = record(detector_calls=0, detector_seconds=0.0, derived_frames=0, tracknet_windows=0)
    assert doc["models"]["player_detector"]["executed"] is False
    assert doc["models"]["player_tracker"]["executed"] is False
    assert doc["models"]["shuttle_detector"]["executed"] is False


def test_refiner_reports_why_it_did_not_run():
    skipped = record(inpaint_applied=False, models=fake_models(inpaint=False))
    assert skipped["models"]["shuttle_refiner"]["executed"] is False
    assert skipped["models"]["shuttle_refiner"]["not_applied_reason"] == "InpaintNet was not loaded"
    short = record(inpaint_applied=False)
    assert short["models"]["shuttle_refiner"]["not_applied_reason"] == "fewer shuttle frames than the InpaintNet window"


def test_shot_classification_is_never_reported_as_run():
    doc = record()
    assert doc["models"]["shot_classifier"] == {"executed": False, "status": "not implemented"}
    assert any("shot classification" in item for item in doc["not_implemented"])


def test_processing_fps_is_frames_over_analyse_seconds_and_checkpoints_are_recorded():
    doc = record()
    assert doc["timing"]["processing_fps"] == 1.5
    assert doc["models"]["shuttle_detector"]["checkpoint_sha256"] == "b" * 64
    assert doc["models"]["player_detector"]["providers"] == ["CPUExecutionProvider"]
    assert doc["models"]["player_detector"]["licence"] == "Apache-2.0"


def test_tracker_parameters_come_from_the_constructor_signature():
    parameters = tracker_parameters()
    assert {"high_threshold", "low_threshold", "max_age", "min_hits"}.issubset(parameters)
    assert parameters["min_hits"] == 3
