"""End-to-end local analysis: raw inference, derived identities and evidence exports.

Stages (the analytics stage name is the progress label shown in the studio):
  probe -> background (median frame and automatic court) -> analyse (raw shuttle and person detections)
  -> refine (InpaintNet on the shuttle path) -> analytics (derive and render in one decoding pass)

Raw outputs (raw/ and shuttle_trajectory.json) are written before derivation and are never edited. The court
calibration, identities, statistics and annotated video are derived from them. ``AnalysisRunner.recompute``
rebuilds those derived files after a correction without running the models again.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import resource
import sys
import time
from collections import Counter
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Callable, Iterator, Optional

import cv2
import numpy as np

from app.ai import precision as precision_files
from app.ai.court_detection.court import CourtEstimate, estimate_court
from app.physics.self_calibration import self_calibrate
from app.ai.player_detection.yolox import YoloXPersonDetector
from app.ai.shuttle_tracking.inpaint import InpaintNetModel, refine_trajectory
from app.ai.shuttle_tracking.tracknet import (
    NonOverlappingShuttleTracker,
    TrackNetFrame,
    TrackNetV3Model,
    median_background,
    resize_to_model,
)
from app.ai.visualization.identity_overlay import draw_identity_frame
from app.analytics import observed2d as O
from app.pipeline.execution import build_model_execution
from app.pipeline.audio import AudioSource, attach_audio, has_audio_stream, sample_audio_source
from app.pipeline.derive import (
    COURT_MARGIN_END_M,
    COURT_MARGIN_SIDE_M,
    DERIVATION_VERSION,
    HIGH_SCORE,
    MIN_HEIGHT_RATIO,
    RALLY_GAP_S,
    RALLY_MIN_S,
    CourtInfo,
    DeriveConfig,
    DeriveOutput,
    court_from_auto,
    court_from_manual,
    derive,
    movement_payload,
    resolve_mode,
)
from app.pipeline.media import (
    H264Writer,
    MediaError,
    VideoInfo,
    iter_frames,
    iter_frames_with_timestamps,
    probe_video,
    sample_background_frames,
    uint8_median,
)
from app.services import corrections as corrections_service

PIPELINE_VERSION = "0.2.0"
RESULT_SCHEMA = "smashlab.local-ai.results/v1"
RAW_SCHEMA = "smashlab.raw/v1"
COORD_SPACE = "source image pixels, origin top-left, x to the right, y downwards"
DETECTION_LABEL = "Detections in image coordinates. Not racket-contact or shuttle-flight measurement."
logger = logging.getLogger(__name__)

ANNOTATED_NAME = "annotated.mp4"
EVALUATION_NOTE = "not evaluated (no ground truth)"
ProgressFn = Callable[[str, float], None]


@dataclass
class PipelineOptions:
    models_dir: str
    threads: int = 4
    detector_conf: float = 0.35
    background_samples: int = 120
    # Batch 1 is the measured default. Batch 4 reached about 3.1 GB peak RSS against the 3 GiB container limit
    # without a time gain (docs/LOCAL_AI_TEST_REPORT.md).
    tracknet_batch: int = 1
    crf: int = 23
    preset: str = "veryfast"
    deadline: Optional[float] = None
    # The time limit behind the deadline, in seconds (Settings.job_timeout_for: grows with the clip length).
    timeout_s: Optional[float] = None
    # "fp32" (default) or "int8": quantized TrackNet and YOLOX made by tools/quantize_int8.py (app/ai/precision.py).
    precision: str = "fp32"
    # Dataset folder (data/). Built-in samples take the audio of their raw source from its manifest.
    input_dir: Optional[str] = None


def _cpu_seconds() -> float:
    own = resource.getrusage(resource.RUSAGE_SELF)
    children = resource.getrusage(resource.RUSAGE_CHILDREN)
    return own.ru_utime + own.ru_stime + children.ru_utime + children.ru_stime


def _peak_rss_mb() -> float:
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return round(peak / (1024 * 1024) if sys.platform == "darwin" else peak / 1024, 1)


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _write_json(path: str, payload: dict) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False)
        handle.write("\n")


def _read_json(path: str) -> dict:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def _seconds(frame: int, fps: float) -> Optional[float]:
    return round(frame / fps, 3) if fps else None


def load_raw_detections(raw_dir: str) -> dict[int, np.ndarray]:
    """Unfiltered person boxes per frame, as (N, 5) arrays of x1, y1, x2, y2, score."""
    detections: dict[int, np.ndarray] = {}
    with open(os.path.join(raw_dir, "detections.jsonl"), encoding="utf-8") as handle:
        for line in handle:
            row = json.loads(line)
            detections[int(row["frame"])] = np.asarray(row["boxes"], dtype=np.float64).reshape(-1, 5)
    return detections


def load_refined_shuttle(output_dir: str) -> list[TrackNetFrame]:
    payload = _read_json(os.path.join(output_dir, "shuttle_trajectory.json"))
    frames = []
    for item in payload["frames"]:
        visible = bool(item["visible"])
        frames.append(TrackNetFrame(
            frame=int(item["frame"]),
            x=item["x"] if visible else 0,
            y=item["y"] if visible else 0,
            visible=visible,
            confidence=float(item["confidence"]),
            refined=bool(item["refined"]),
        ))
    return frames


def _valid_presentation_timestamps(values: list[float]) -> bool:
    if len(values) < 2 or not all(np.isfinite(value) and value >= 0 for value in values):
        return False
    deltas = np.diff(values)
    return bool(np.all(deltas > 0) and np.median(deltas) > 0)


def _write_shuttle_trajectory(
    output_dir: str,
    job_id: str,
    info: VideoInfo,
    refined: list[TrackNetFrame],
    presentation_timestamps_s: Optional[list[float]] = None,
) -> None:
    timestamps = presentation_timestamps_s or []
    actual_timestamps = _valid_presentation_timestamps(timestamps) and len(timestamps) >= len(refined)
    payload = {
        "schema": RESULT_SCHEMA,
        "job_id": job_id,
        "coordinate_space": COORD_SPACE,
        "label": DETECTION_LABEL,
        "source_width": info.width,
        "source_height": info.height,
        "fps": info.fps,
        "timestamp_source": "presentation_timestamp" if actual_timestamps else "frame_rate_derived",
        "frames": [
            {
                "frame": f.frame,
                "time_s": round(timestamps[f.frame], 6) if actual_timestamps else round(f.frame / info.fps, 6),
                "x": f.x if f.visible else None,
                "y": f.y if f.visible else None,
                "visible": f.visible,
                "confidence": round(f.confidence, 4),
                "refined": f.refined,
            }
            for f in refined
        ],
    }
    _write_json(os.path.join(output_dir, "shuttle_trajectory.json"), payload)


class AnalysisRunner:
    def __init__(self, options: PipelineOptions, progress: Optional[ProgressFn] = None) -> None:
        self.options = options
        self._progress = progress or (lambda stage, fraction: None)
        self.timings: dict[str, float] = {}

    def _check_deadline(self) -> None:
        if self.options.deadline is not None and time.monotonic() > self.options.deadline:
            limit = f" of {self.options.timeout_s:.0f} s" if self.options.timeout_s else ""
            raise MediaError("timeout", f"The analysis exceeded its time limit{limit} for this clip length.")

    @contextmanager
    def _stage(self, name: str, start: float, end: float) -> Iterator[None]:
        self._progress(name, start)
        began = time.perf_counter()
        yield
        self.timings[name] = round(time.perf_counter() - began, 3)
        self._progress(name, end)

    # ------------------------------------------------------------------ full run
    def run(self, input_path: str, output_dir: str, job_id: str, source: dict) -> dict:
        opts = self.options
        raw_dir = os.path.join(output_dir, "raw")
        os.makedirs(raw_dir, exist_ok=True)
        wall_start = time.perf_counter()
        cpu_start = _cpu_seconds()

        with self._stage("probe", 0.00, 0.02):
            info = probe_video(input_path)
        models = self._load_models()

        with self._stage("background", 0.02, 0.06):
            total_frames, samples, calibration_frames = sample_background_frames(
                input_path, info.frame_count, opts.background_samples
            )
            median_rgb = median_background(samples)
            court_auto = self._calibrate_court(calibration_frames)
            calibration_frames = []
        court_auto_payload = court_auto.to_dict()
        _write_json(os.path.join(raw_dir, "court_auto.json"), court_auto_payload)

        shuttle_tracker = NonOverlappingShuttleTracker(
            infer=models["tracknet"],
            median_rgb=median_rgb,
            src_w=info.width,
            src_h=info.height,
            seq_len=models["tracknet"].seq_len,
            bg_mode=models["tracknet"].bg_mode,
            batch_size=opts.tracknet_batch,
        )
        detector: YoloXPersonDetector = models["detector"]
        shuttle_frames: list[TrackNetFrame] = []
        detector_calls = 0
        detector_seconds = 0.0
        analysed = 0
        presentation_timestamps_s: list[float] = []

        with self._stage("analyse", 0.06, 0.66):
            with open(os.path.join(raw_dir, "detections.jsonl"), "w", encoding="utf-8") as handle:
                for index, frame, presentation_time_s in iter_frames_with_timestamps(input_path):
                    self._check_deadline()
                    presentation_timestamps_s.append(presentation_time_s)
                    shuttle_frames.extend(shuttle_tracker.push(index, resize_to_model(frame)))
                    began = time.perf_counter()
                    detections = detector.detect(frame)
                    detector_seconds += time.perf_counter() - began
                    detector_calls += 1
                    rows = [[float(d.x1), float(d.y1), float(d.x2), float(d.y2), float(d.score)] for d in detections]
                    handle.write(json.dumps({"frame": index, "boxes": rows}) + "\n")
                    analysed = index + 1
                    if index % 15 == 0 and total_frames:
                        self._progress("analyse", 0.06 + 0.60 * min(1.0, (index + 1) / total_frames))
                shuttle_frames.extend(shuttle_tracker.finish())
        shuttle_frames.sort(key=lambda f: f.frame)
        tracknet_windows = shuttle_tracker.windows_run
        _write_json(os.path.join(raw_dir, "tracknet_points.json"), {
            "schema": RAW_SCHEMA,
            "job_id": job_id,
            "frames": [
                {"frame": f.frame, "x": f.x, "y": f.y, "visible": f.visible, "confidence": round(f.confidence, 4)}
                for f in shuttle_frames
            ],
        })

        inpaint = models.get("inpaint")
        seq_len = inpaint_seq_len(models)
        inpaint_applied = inpaint is not None and len(shuttle_frames) >= seq_len
        with self._stage("refine", 0.66, 0.68):
            refined = shuttle_frames
            if inpaint_applied:
                refined = refine_trajectory(shuttle_frames, info.width, info.height, infer=inpaint, seq_len=seq_len)
        self._check_deadline()
        _write_shuttle_trajectory(output_dir, job_id, info, refined, presentation_timestamps_s)

        model_info = {
            "precision": self.options.precision,
            "tracknet_file": models["tracknet"].file_name,
            "tracknet_onnx_sha256": (models["tracknet"].int8_record or {}).get("int8_sha256") or models["tracknet"].onnx_sha256,
            "tracknet_checkpoint_sha256": models["tracknet"].checkpoint_sha256,
            "yolox_file": models["yolox_file"],
            "yolox_sha256": models["yolox_sha256"],
            "inpaint_available": inpaint is not None,
            "inpaint_applied": inpaint_applied,
        }
        _write_json(os.path.join(raw_dir, "inference_meta.json"), {
            "schema": RAW_SCHEMA,
            "job_id": job_id,
            "fps": info.fps,
            "width": info.width,
            "height": info.height,
            "frame_count": info.frame_count,
            "analysed_frames": analysed,
            "timestamp_source": "presentation_timestamp" if _valid_presentation_timestamps(presentation_timestamps_s) else "frame_rate_derived",
            "background_samples": len(samples),
            "detector_conf_threshold": opts.detector_conf,
            "tracknet_batch": opts.tracknet_batch,
            "pipeline_version": PIPELINE_VERSION,
            **model_info,
        })

        with self._stage("analytics", 0.68, 0.96):
            began = time.perf_counter()
            output = self._derive_and_render(
                input_path, output_dir, info, load_raw_detections(raw_dir), refined, court_auto_payload, analysed
            )
            audio_status = self._attach_audio(input_path, output_dir, source, info, analysed)
            derive_seconds = round(time.perf_counter() - began, 3)
        _write_derived(output_dir, job_id, source, info, output, court_auto_payload, analysed, derive_seconds, model_info)
        _write_inference_report(output_dir, job_id, opts, model_info, len(samples), self.timings)

        total_wall = time.perf_counter() - wall_start
        cpu_seconds = _cpu_seconds() - cpu_start
        metrics = {
            "schema": RESULT_SCHEMA,
            "job_id": job_id,
            "frames_analysed": analysed,
            "duration_s": round(info.duration_s, 3),
            "wall_seconds": round(total_wall, 3),
            "frames_per_second": round(analysed / total_wall, 3) if total_wall > 0 else None,
            "cpu_seconds": round(cpu_seconds, 3),
            "cpu_utilisation_mean": round(cpu_seconds / total_wall, 3) if total_wall > 0 else None,
            "peak_rss_mb": _peak_rss_mb(),
            "detector_seconds_total": round(detector_seconds, 3),
            "detector_ms_per_frame": round(1000 * detector_seconds / detector_calls, 2) if detector_calls else None,
            "tracknet_windows": tracknet_windows,
            "derive_seconds": derive_seconds,
            "stage_seconds": self.timings,
            "output_bytes": {
                name: os.path.getsize(os.path.join(output_dir, name))
                for name in sorted(os.listdir(output_dir))
                if os.path.isfile(os.path.join(output_dir, name))
            },
            "threads": opts.threads,
            "device": "cpu",
            "annotated_audio": audio_status,
        }
        _write_json(os.path.join(output_dir, "metrics.json"), metrics)
        model_record = build_model_execution(
            job_id=job_id,
            device="cpu",
            threads=opts.threads,
            runtime=_runtime_versions(),
            models={
                **models,
                "detector_conf": opts.detector_conf,
                "detector_nms": models["detector"].nms_threshold,
                "inpaint_available": "inpaint" in models,
            },
            counters={
                "detector_calls": detector_calls,
                "detector_seconds": detector_seconds,
                "derived_frames": output.frames_processed,
                "analysed_frames": analysed,
                "inpaint_applied": inpaint_applied,
                "tracknet_windows": tracknet_windows,
                "tracknet_batch": opts.tracknet_batch,
                "tracks_total": output.tracks_total,
                "tracks_confirmed": output.tracks_confirmed,
                "logical_identities": output.players,
                "identity_gate": output.identity_gate,
                "identity_events": len(output.identity_events),
                "court_status": output.court.status,
                "court_score": court_auto_payload.get("score"),
                "court_coverage": court_auto_payload.get("coverage"),
                "court_source": output.court.source,
                "derive_seconds": derive_seconds,
            },
            timings=self.timings,
            metrics=metrics,
        )
        _write_json(os.path.join(output_dir, "model_execution.json"), model_record)
        self._progress("done", 1.0)
        return _read_json(os.path.join(output_dir, "results.json"))

    # -------------------------------------------------------- recompute only
    def recompute(self, output_dir: str, input_path: str) -> dict:
        """Rebuild the derived files and the annotated video from the raw outputs and corrections. No model runs."""
        raw_dir = os.path.join(output_dir, "raw")
        meta_path = os.path.join(raw_dir, "inference_meta.json")
        if not os.path.isfile(meta_path):
            raise MediaError("raw_missing", "This analysis was made before raw outputs were kept, so it cannot be recomputed.")
        meta = _read_json(meta_path)
        info = VideoInfo(
            width=int(meta["width"]),
            height=int(meta["height"]),
            fps=float(meta["fps"]),
            frame_count=int(meta["frame_count"]),
        )
        court_auto_payload = _read_json(os.path.join(raw_dir, "court_auto.json"))
        analysed = int(meta["analysed_frames"])
        refined = load_refined_shuttle(output_dir)
        began = time.perf_counter()
        output = self._derive_and_render(
            input_path, output_dir, info, load_raw_detections(raw_dir), refined, court_auto_payload, analysed
        )
        previous = _read_json(os.path.join(output_dir, "results.json"))
        self._attach_audio(input_path, output_dir, previous.get("source", {}), info, analysed)
        derive_seconds = round(time.perf_counter() - began, 3)
        _write_derived(output_dir, meta["job_id"], previous.get("source", {}), info, output,
                       court_auto_payload, analysed, derive_seconds, meta)
        return _read_json(os.path.join(output_dir, "results.json"))

    # ------------------------------------------------------------- internals
    def _attach_audio(self, input_path: str, output_dir: str, source: dict, info: VideoInfo, analysed: int) -> str:
        """Mux an AAC track into the silent annotated video. Returns 'attached', 'none' or 'failed'; never raises.

        An upload with its own audio keeps it. A built-in sample takes the audio of its raw source (see pipeline/audio.py).
        """
        annotated = os.path.join(output_dir, ANNOTATED_NAME)
        audio: Optional[AudioSource] = None
        if source.get("kind") == "sample" and source.get("detail") and self.options.input_dir:
            audio = sample_audio_source(self.options.input_dir, source["detail"])
        elif has_audio_stream(input_path):
            audio = AudioSource(path=input_path, start_s=0.0)
        if audio is None:
            return "none"
        total = analysed or info.frame_count
        duration_s = total / info.fps if info.fps else 0.0
        try:
            attach_audio(annotated, audio, duration_s)
        except MediaError as exc:
            logger.warning("annotated video kept without audio: %s", exc.message)
            return "failed"
        return "attached"

    def _derive_and_render(self, input_path, output_dir, info: VideoInfo, detections, refined,
                           court_auto_payload: dict, analysed: int) -> DeriveOutput:
        loaded = corrections_service.load(output_dir)
        entries = loaded.get("entries", [])
        manual = corrections_service.latest(entries, "court_calibration")
        court = court_from_manual(manual["corners_px"]) if manual else court_from_auto(court_auto_payload)
        mode = resolve_mode(entries, "auto", detections, court, info.width, info.height)
        total = analysed or info.frame_count
        identity_range = "P1 to P4" if mode == "doubles" else "P1 to P2"
        writer = H264Writer(
            os.path.join(output_dir, ANNOTATED_NAME), info.width, info.height, info.fps, self.options.crf, self.options.preset
        )
        # The same shared observed-2d/v1 track the match document uses (the raw file is written before and only read):
        # the drawn trail and the rally candidates skip the points it rejected.
        observed = O.sanitize(
            _read_json(os.path.join(output_dir, "shuttle_trajectory.json")), width=info.width, height=info.height, fps=info.fps
        )

        def render(index, image, players, shuttle, trail, outline):
            self._check_deadline()
            if index % 15 == 0 and total:
                self._progress("analytics", 0.68 + 0.28 * min(1.0, (index + 1) / total))
            seconds = index / info.fps if info.fps else 0.0
            header = f"frame {index + 1}/{total}   {seconds:.2f} s   {mode}   identities {identity_range}"
            return draw_identity_frame(image, players, shuttle, trail, outline, header)

        try:
            return derive(
                fps=info.fps,
                width=info.width,
                height=info.height,
                total_frames=total,
                detections=detections,
                shuttle=refined,
                court=court,
                corrections_doc=loaded,
                config=DeriveConfig(mode=mode, render=True),
                frames=iter_frames(input_path),
                render=render,
                writer=writer,
                observed=observed,
            )
        finally:
            writer.close()

    def _load_models(self) -> dict:
        opts = self.options
        tracknet_dir = os.path.join(opts.models_dir, "tracknetv3")
        yolox_path = os.path.join(opts.models_dir, "yolox", "object_detection_yolox_2022nov.onnx")
        if not os.path.isfile(yolox_path):
            raise MediaError("model_missing", f"Player detector not found: {yolox_path}")
        tracknet_sidecar = os.path.join(tracknet_dir, "tracknetv3_export.json")
        if not os.path.isfile(tracknet_sidecar):
            raise MediaError("model_missing", f"TrackNetV3 export metadata not found: {tracknet_sidecar}")
        try:
            tracknet = TrackNetV3Model(tracknet_dir, threads=opts.threads, precision=opts.precision)
            detector_path, _record = precision_files.resolve(yolox_path, opts.precision)
        except (FileNotFoundError, ValueError) as exc:
            raise MediaError("model_missing", f"{opts.precision.upper()} models are not ready: {exc}") from exc
        models: dict = {
            "tracknet": tracknet,
            "detector": YoloXPersonDetector(detector_path, conf_threshold=opts.detector_conf, threads=opts.threads),
            "yolox_sha256": _sha256(detector_path),
            "yolox_file": os.path.basename(detector_path),
        }
        inpaint_path = os.path.join(tracknet_dir, "tracknetv3_inpaintnet.onnx")
        with open(tracknet_sidecar, encoding="utf-8") as handle:
            inpaint_meta = json.load(handle)["models"].get("inpaintnet")
        if os.path.isfile(inpaint_path) and inpaint_meta is not None:
            models["inpaint"] = InpaintNetModel(inpaint_path, seq_len=int(inpaint_meta["seq_len"]), threads=opts.threads)
            models["inpaint_file"] = os.path.basename(inpaint_path)
            models["inpaint_sha256"] = _sha256(inpaint_path)
        return models

    def _calibrate_court(self, calibration_frames) -> CourtEstimate:
        """Automatic court calibration on the per-pixel median of the full-resolution sample frames."""
        if not calibration_frames:
            return CourtEstimate("failed", "no full-resolution frames were available for calibration")
        background = uint8_median(calibration_frames)
        estimate = estimate_court(background)
        if estimate.calibrated and estimate.homography_image_from_court is not None:
            # Camera from the court lines, checked against the net tape (court-self-calibration/v1). Only a camera that
            # passes is used, and only for "Estimated 3D — monocular experimental" with all of its own gates.
            height, width = background.shape[:2]
            try:
                estimate.extra["camera_3d"] = self_calibrate(estimate.homography_image_from_court, background, width, height)
            except Exception as exc:  # a diagnostic must never fail the analysis
                logger.warning("camera self-calibration failed: %s", exc)
                estimate.extra["camera_3d"] = {"status": "failed", "source": "court_lines_and_net_tape", "independent_3d": False,
                                               "reason": f"self-calibration error: {exc}"}
        return estimate


def _court_block(court: CourtInfo, court_auto: dict) -> dict:
    automatic = court.source == "auto"
    return {
        "status": court.status,
        "source": court.source,
        "reason": court.reason,
        "template": court.template,
        "score": court_auto.get("score") if automatic else None,
        "coverage": court_auto.get("coverage") if automatic else None,
        "quad_image_px": court.quad_image,
        "homography_image_from_court": (
            None if court.homography_image_from_court is None else np.asarray(court.homography_image_from_court).tolist()
        ),
        "coordinate_space": court_auto.get("coordinate_space"),
        "approximation": court_auto.get("approximation"),
        # The automatic camera and its checks; absent for a person's four corners (no background image at recompute).
        "camera_3d": court_auto.get("camera_3d") if automatic else None,
    }


def _model_list(model_info: dict) -> list[dict]:
    return [
        {
            "name": "TrackNetV3 TrackNet",
            "onnx_sha256": model_info["tracknet_onnx_sha256"],
            "checkpoint_sha256": model_info["tracknet_checkpoint_sha256"],
            "licence": "MIT (qaz812345/TrackNetV3)",
        },
        {"name": "TrackNetV3 InpaintNet", "applied": bool(model_info["inpaint_applied"]), "licence": "MIT (qaz812345/TrackNetV3)"},
        {"name": "YOLOX-s", "onnx_sha256": model_info["yolox_sha256"], "licence": "Apache-2.0 (opencv_zoo)"},
    ]


def _identity_summary(output: DeriveOutput, events: list[dict], total: int) -> dict:
    """Compact identity evidence for results.json (the AI Coach and the session list read this)."""
    coverage = {}
    for identity, segments in output.identity_segments.items():
        covered = sum(
            segment["end_frame"] - segment["start_frame"] + 1
            for segment in segments
            if segment["status"] in ("matched", "recovered", "manual")
        )
        coverage[identity] = round(covered / total, 4) if total else None
    return {
        "mode": output.mode,
        "logical_identities": output.players,
        "event_counts": dict(Counter(event["kind"] for event in events)),
        "events_total": len(events),
        "events": [
            {"frame": e["frame"], "time_s": e["time_s"], "kind": e["kind"], "identity": e["identity"], "track_id": e["track_id"]}
            for e in events[:40]
        ],
        "coverage": coverage,
        "corrections_applied_frames": output.corrections_applied,
    }


def _write_derived(output_dir, job_id, source, info: VideoInfo, output: DeriveOutput, court_auto: dict,
                   analysed: int, derive_seconds: float, model_info: dict) -> None:
    fps = info.fps
    court = output.court
    total = analysed or info.frame_count
    h_court_from_image = np.linalg.inv(court.homography_image_from_court) if court.calibrated else None

    state_by_track_frame = {}
    for frame, states in output.identity_states:
        for state in states:
            if state.track_id is not None:
                state_by_track_frame[(frame, state.track_id)] = state

    tracks = []
    for record in output.track_records:
        observations = []
        for obs in record["observations"]:
            item = dict(obs)
            state = state_by_track_frame.get((obs["frame"], record["track_id"]))
            item["identity"] = state.identity if state is not None else None
            item["identity_status"] = state.status if state is not None else None
            item["identity_confidence"] = (
                round(float(state.confidence), 4) if state is not None and state.confidence is not None else None
            )
            if h_court_from_image is not None:
                foot = np.array([(obs["x1"] + obs["x2"]) / 2.0, obs["y2"], 1.0])
                mapped = h_court_from_image @ foot
                item["court_x_m"] = round(float(mapped[0] / mapped[2]), 3)
                item["court_y_m"] = round(float(mapped[1] / mapped[2]), 3)
            observations.append(item)
        tracks.append({"track_id": record["track_id"], "confirmed": record["confirmed"], "observations": observations})

    _write_json(os.path.join(output_dir, "player_tracks.json"), {
        "schema": RESULT_SCHEMA,
        "job_id": job_id,
        "coordinate_space": COORD_SPACE,
        "label": DETECTION_LABEL,
        "identity_note": "track_id is a temporary tracker ID. identity (P1 to P4) is the logical player, "
                         "with its status and confidence.",
        "source_width": info.width,
        "source_height": info.height,
        "fps": fps,
        "mode": output.mode,
        "logical_identities": output.players,
        "tracks": tracks,
    })

    events = [event.as_dict(fps) for event in output.identity_events]
    _write_json(os.path.join(output_dir, "identity_events.json"), {
        "schema": RESULT_SCHEMA,
        "job_id": job_id,
        "fps": fps,
        "mode": output.mode,
        "logical_identities": output.players,
        "event_counts": dict(Counter(event["kind"] for event in events)),
        "events": events,
        "segments": {
            identity: [
                {**segment, "start_s": _seconds(segment["start_frame"], fps), "end_s": _seconds(segment["end_frame"], fps)}
                for segment in segments
            ]
            for identity, segments in output.identity_segments.items()
        },
    })

    _write_json(os.path.join(output_dir, "rallies.json"), {
        "schema": RESULT_SCHEMA,
        "job_id": job_id,
        "fps": fps,
        "status": "heuristic_candidates",
        "validated": False,
        "method": f"heuristic: runs of TrackNet detections kept by the {O.VERSION} check separated by short gaps; "
                  f"gap at most {RALLY_GAP_S} s, minimum {RALLY_MIN_S} s",
        "evaluation": EVALUATION_NOTE,
        "count": len(output.rallies),
        "rallies": output.rallies,
    })

    _write_json(os.path.join(output_dir, "shots.json"), {
        "schema": RESULT_SCHEMA,
        "job_id": job_id,
        "status": "unsupported",
        "reason": "No validated shot classifier or racket-contact detector is implemented in this build. "
                  "Shot counts and contact times are not reported.",
        "evaluation": EVALUATION_NOTE,
        "shots": [],
    })

    movement = movement_payload(output, fps, info.width, info.height, total, court)
    confirmed_scores = [
        obs["score"] for record in output.track_records for obs in record["observations"] if obs["confirmed"]
    ]
    player_stats = {
        "tracks_total": output.tracks_total,
        "tracks_confirmed": output.tracks_confirmed,
        "tracks_in_movement_statistics": len(movement["per_player"]),
        "max_concurrent_confirmed": output.max_concurrent_identities,
        "mean_detection_score": round(float(np.mean(confirmed_scores)), 4) if confirmed_scores else 0.0,
        "confirmed_observations": len(confirmed_scores),
        "mode": output.mode,
        "logical_identities": output.players,
        "identity_events": len(events),
        "corrections_applied": output.corrections_applied,
    }
    court_block = _court_block(court, court_auto)
    identity_summary = _identity_summary(output, events, total)
    shuttle_stats = output.shuttle_stats
    confidence = {
        "player_detection_mean_score": player_stats["mean_detection_score"],
        "player_tracks_confirmed": player_stats["tracks_confirmed"],
        "shuttle_visible_ratio": shuttle_stats["visible_ratio"],
        "shuttle_mean_confidence": shuttle_stats["mean_confidence_detected"],
        "calibration": court.status,
        "identity_note": "confidence values are association scores, not measured accuracy",
    }
    results = {
        "schema": RESULT_SCHEMA,
        "job_id": job_id,
        "status": "completed",
        "source": source,
        "video": {
            "width": info.width,
            "height": info.height,
            "fps": round(fps, 3),
            "frames_analysed": analysed,
            "duration_s": round(analysed / fps, 3) if fps else None,
        },
        "players": {**player_stats, "detector": "YOLOX-s person detector (COCO class person)"},
        "movement": movement,
        "shuttle": {**shuttle_stats, "model": "TrackNetV3 TrackNet (+ InpaintNet refinement)"},
        "court": court_block,
        "rally_segmentation": {
            "status": "heuristic_candidates",
            "validated": False,
            "count": len(output.rallies),
            "reason": "Candidate rallies from gaps in shuttle detections. Not validated against ground truth.",
            "evaluation": EVALUATION_NOTE,
            "candidates": [
                {"index": r["index"], "start_s": r["start_s"], "end_s": r["end_s"], "duration_s": r["duration_s"]}
                for r in output.rallies[:20]
            ],
        },
        "shot_classification": {
            "status": "unsupported",
            "reason": "No validated shot classifier is implemented; shot counts are not reported.",
            "evaluation": EVALUATION_NOTE,
        },
        "identity": identity_summary,
        "confidence": confidence,
        "artifacts": {
            "annotated_video": ANNOTATED_NAME,
            "player_tracks": "player_tracks.json",
            "identity_events": "identity_events.json",
            "rallies": "rallies.json",
            "shots": "shots.json",
            "shuttle_trajectory": "shuttle_trajectory.json",
            "analysis": "analysis.json",
            "analysis_report": "analysis_report.json",
            "metrics": "metrics.json",
            "inference_report": "inference_report.json",
            "model_execution": "model_execution.json",
            "court_coordinates": "court_coordinates.json" if court.calibrated else None,
        },
        "limitations": [
            "Player and shuttle outputs are detections in image coordinates.",
            "Movement values are normalised image units; court metres appear only with a calibrated court and are approximate.",
            "Identities P1 to P4 are logical labels. They can be uncertain; corrections are stored separately.",
            "Rally candidates are a heuristic and are not validated. Shot counts and shuttle speed in physical units are not reported.",
        ],
    }
    _write_json(os.path.join(output_dir, "results.json"), results)

    court_path = os.path.join(output_dir, "court_coordinates.json")
    if court.calibrated:
        _write_json(court_path, court_block)
    elif os.path.isfile(court_path):
        os.remove(court_path)

    analysis = {
        "schema": RESULT_SCHEMA,
        "analysis_id": job_id,
        "job_id": job_id,
        "pipeline_version": PIPELINE_VERSION,
        "derivation_version": DERIVATION_VERSION,
        "source": source,
        "video": results["video"],
        "mode": output.mode,
        "logical_identities": output.players,
        "court": {"status": court.status, "source": court.source, "reason": court.reason},
        "counts": {
            "tracks_total": output.tracks_total,
            "tracks_confirmed": output.tracks_confirmed,
            "identity_events": len(events),
            "rally_candidates": len(output.rallies),
            "shots_reported": 0,
            "corrections_applied": output.corrections_applied,
        },
        "evaluation": {"ground_truth": None, "status": EVALUATION_NOTE},
        "limitations": results["limitations"],
    }
    _write_json(os.path.join(output_dir, "analysis.json"), analysis)

    _write_json(os.path.join(output_dir, "analysis_report.json"), {
        "schema": RESULT_SCHEMA,
        "job_id": job_id,
        "pipeline_version": PIPELINE_VERSION,
        "derivation_version": DERIVATION_VERSION,
        "derive_seconds": derive_seconds,
        "models": _model_list(model_info),
        "tracking": {
            "method": "ByteTrack-style two-stage association with constant-velocity Kalman prediction (own implementation)",
            "identity_matching": "Hungarian matching on court distance (or frame-relative image distance without calibration), "
                                 "plus an upper-body colour histogram",
        },
        "identities": {
            "gate": "1.5 m with calibration, 0.15 of the frame diagonal without",
            "uncertain_when": "two candidates score within the ambiguity margin, or two identities claim one track",
            "never": "identities are not reassigned silently; suspected exchanges are logged as identity_switch_suspected",
        },
        "court_filter": {
            "margins_m": {"sides": COURT_MARGIN_SIDE_M, "ends": COURT_MARGIN_END_M},
            "without_calibration": f"boxes at least {MIN_HEIGHT_RATIO:.0%} of frame height; "
                                   f"mode choice uses detections scoring at least {HIGH_SCORE}",
        },
        "rally_candidates": {"gap_s": RALLY_GAP_S, "min_s": RALLY_MIN_S, "validated": False},
        "shots": "unsupported",
        "corrections_applied": output.corrections_applied,
        "evaluation": {"ground_truth": None, "status": EVALUATION_NOTE},
    })


def _write_inference_report(output_dir, job_id, options: PipelineOptions, model_info: dict,
                            background_samples: int, timings: dict) -> None:
    _write_json(os.path.join(output_dir, "inference_report.json"), {
        "schema": RESULT_SCHEMA,
        "job_id": job_id,
        "pipeline_version": PIPELINE_VERSION,
        "device": "cpu",
        "threads": options.threads,
        "job_timeout_s": options.timeout_s,
        "precision": model_info.get("precision", "fp32"),
        "models": [
            {
                "name": "TrackNetV3 TrackNet",
                "file": model_info.get("tracknet_file", "tracknetv3_tracknet.onnx"),
                "onnx_sha256": model_info["tracknet_onnx_sha256"],
                "checkpoint_sha256": model_info["tracknet_checkpoint_sha256"],
                "licence": "MIT (qaz812345/TrackNetV3, code and checkpoints)",
                "task": "shuttlecock heatmap (image coordinates)",
            },
            {
                "name": "TrackNetV3 InpaintNet",
                "file": "tracknetv3_inpaintnet.onnx" if model_info["inpaint_available"] else None,
                "licence": "MIT (qaz812345/TrackNetV3, code and checkpoints)",
                "task": "trajectory refinement (image coordinates)",
                "applied": bool(model_info["inpaint_applied"]),
            },
            {
                "name": "YOLOX-s",
                "file": model_info.get("yolox_file", "object_detection_yolox_2022nov.onnx"),
                "onnx_sha256": model_info["yolox_sha256"],
                "licence": "Apache-2.0 (opencv/opencv_zoo model folder; YOLOX by Megvii)",
                "task": "person detection (COCO class 0), raw boxes stored in raw/detections.jsonl",
            },
        ],
        "runtime": {"onnxruntime": _ort_version(), "opencv": cv2.__version__, "numpy": np.__version__},
        "parameters": {
            "tracknet_windows": "non-overlapping, seq_len from checkpoint (8)",
            "tracknet_batch": options.tracknet_batch,
            "background_median_samples": background_samples,
            "detector_conf_threshold": options.detector_conf,
            "player_identities": "see analysis_report.json",
        },
        "deviations_from_reference": [
            "Non-overlapping TrackNet windows instead of the overlapping temporal ensemble (CPU time).",
            "Background median from up to 120 sampled frames resized to 512x288.",
            "Player tracking is a ByteTrack-style tracker with logical identities, not a re-identification model.",
        ],
        "stages_seconds": timings,
    })


def inpaint_seq_len(models: dict) -> int:
    inpaint = models.get("inpaint")
    return int(inpaint.seq_len) if inpaint is not None else 16


def _runtime_versions() -> dict:
    """Versions of the libraries that executed the models (for the model execution record)."""
    return {
        "onnxruntime": _ort_version(),
        "opencv": cv2.__version__,
        "numpy": np.__version__,
        "python": sys.version.split()[0],
    }


def _ort_version() -> str:
    import onnxruntime

    return onnxruntime.__version__
