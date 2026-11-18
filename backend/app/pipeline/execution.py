"""Model execution record for one analysis (model_execution.json).

Every ``executed`` flag comes from a counter that the pipeline increments when it really calls a model or a stage.
Nothing is marked as run from configuration alone, so the studio can only say that a model ran when the backend's
own counters confirm it. Tracker parameters are read from the code's signatures, not written by hand here.
"""

from __future__ import annotations

import inspect
from typing import Optional

from app.ai.player_detection.bytetrack import ByteTracker

SCHEMA = "smashlab.model-execution/v1"
NOT_IMPLEMENTED = [
    "shot classification: no validated classifier exists in this build",
    "racket contact detection: not implemented",
    "shuttle speed in physical units: not measured",
    "face recognition: not used and not planned",
]


def tracker_parameters() -> dict:
    """Default parameters of the ByteTrack-style tracker, read from its constructor signature."""
    return {
        name: parameter.default
        for name, parameter in inspect.signature(ByteTracker).parameters.items()
        if parameter.default is not inspect.Parameter.empty
    }


def _rate(numerator: float, denominator: float) -> Optional[float]:
    return round(numerator / denominator, 3) if denominator > 0 else None


def build_model_execution(*, job_id: str, device: str, threads: int, runtime: dict, models: dict, counters: dict,
                          timings: dict, metrics: dict) -> dict:
    """Assemble the record.

    ``models``: file names, sha256 values and ONNX Runtime providers gathered when the models were loaded.
    ``counters``: the values the pipeline counted while it ran (see runner.py).
    ``timings``: stage seconds from AnalysisRunner. ``metrics``: wall time, memory and CPU from metrics.json.
    """
    detector_calls = int(counters["detector_calls"])
    derived_frames = int(counters["derived_frames"])
    analysed = int(counters["analysed_frames"])
    analyse_seconds = float(timings.get("analyse", 0.0))
    inpaint_applied = bool(counters["inpaint_applied"])
    refiner_reason = None
    if not inpaint_applied:
        refiner_reason = (
            "InpaintNet was not loaded" if not models.get("inpaint_available")
            else "fewer shuttle frames than the InpaintNet window"
        )
    tracknet = models["tracknet"]
    detector = models["detector"]
    return {
        "schema": SCHEMA,
        "job_id": job_id,
        "status": "completed",
        "device": device,
        "threads": threads,
        "runtime": runtime,
        "models": {
            "player_detector": {
                "executed": detector_calls > 0,
                "frames_processed": detector_calls,
                "name": "YOLOX-s (Megvii YOLOX, ONNX export from opencv_zoo)",
                "family": "YOLOX; not an Ultralytics YOLO package",
                "file": models["yolox_file"],
                "onnx_sha256": models["yolox_sha256"],
                "input_size": 640,
                "class_filter": "person (COCO class 0)",
                "conf_threshold": models["detector_conf"],
                "nms_threshold": models["detector_nms"],
                "providers": detector.providers,
                "licence": "Apache-2.0",
                "ms_per_frame": _rate(1000.0 * float(counters.get("detector_seconds", 0.0)), detector_calls),
            },
            "player_tracker": {
                "executed": derived_frames > 0,
                "frames_processed": derived_frames,
                "name": "ByteTrack-style two-stage association (own implementation of the published method)",
                "motion_model": "constant-velocity Kalman filter over box centre, width and height",
                "assignment": "Hungarian algorithm (own implementation)",
                "parameters": tracker_parameters(),
                "tracks_total": counters["tracks_total"],
                "tracks_confirmed": counters["tracks_confirmed"],
            },
            "identity_matcher": {
                "executed": derived_frames > 0,
                "name": "logical identity matcher (own implementation)",
                "logical_identities": counters["logical_identities"],
                "gate": counters["identity_gate"],
                "appearance": "upper-body hue-saturation histogram; not face recognition",
                "events": counters["identity_events"],
            },
            "shuttle_detector": {
                "executed": int(counters["tracknet_windows"]) > 0,
                "windows_processed": int(counters["tracknet_windows"]),
                "name": "TrackNetV3 TrackNet",
                "file": tracknet.file_name,
                "onnx_sha256": tracknet.onnx_sha256,
                "checkpoint": "TrackNet_best.pt",
                "checkpoint_sha256": tracknet.checkpoint_sha256,
                "seq_len": tracknet.seq_len,
                "batch_size": counters["tracknet_batch"],
                "providers": tracknet.providers,
                "licence": "MIT (qaz812345/TrackNetV3)",
            },
            "shuttle_refiner": {
                "executed": inpaint_applied,
                "name": "TrackNetV3 InpaintNet",
                "file": models.get("inpaint_file"),
                "onnx_sha256": models.get("inpaint_sha256"),
                "providers": models["inpaint"].providers if "inpaint" in models else [],
                "licence": "MIT (qaz812345/TrackNetV3)",
                "not_applied_reason": refiner_reason,
            },
            "court_calibration": {
                "executed": True,
                "name": "classical white-line detection with homography to the doubles template (own implementation)",
                "status": counters["court_status"],
                "score": counters["court_score"],
                "coverage": counters["court_coverage"],
                "source": counters["court_source"],
            },
            "shot_classifier": {"executed": False, "status": "not implemented"},
        },
        "timing": {
            "background_seconds": timings.get("background"),
            "analyse_seconds": round(analyse_seconds, 3),
            "refine_seconds": timings.get("refine"),
            "analytics_seconds": timings.get("analytics"),
            "derive_seconds": counters.get("derive_seconds"),
            "wall_seconds": metrics.get("wall_seconds"),
            "frames_processed": analysed,
            "processing_fps": _rate(analysed, analyse_seconds),
            "overall_fps": metrics.get("frames_per_second"),
            "peak_rss_mb": metrics.get("peak_rss_mb"),
            "cpu_utilisation_mean": metrics.get("cpu_utilisation_mean"),
        },
        "not_implemented": list(NOT_IMPLEMENTED),
    }
