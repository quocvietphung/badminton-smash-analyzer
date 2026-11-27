"""Inputs for INT8 calibration and for the FP32/INT8 agreement check, built exactly as the pipeline builds them.

TrackNet windows: seq_len consecutive frames resized to the model grid, with the clip's median background in front
(build_window_input). YOLOX blobs: one letterboxed frame. Windows are numbered per clip; calibration takes the even
windows and the agreement check the odd ones, so the check never sees a frame the quantizer calibrated on.
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterator

import numpy as np

from app.ai.player_detection.yolox import letterbox
from app.ai.shuttle_tracking.tracknet import build_window_input, median_background, resize_to_model
from app.pipeline.media import iter_frames, probe_video, sample_background_frames

SAMPLES_DIR = Path(__file__).resolve().parents[2] / "data" / "samples"
SAMPLE_VIDEOS = ("sample-a-singles-rally.mp4", "sample-b-fast-shuttle.mp4", "sample-c-difficult-multicourt.mp4",
                 "sample-d-demonstration.mp4")


def sample_paths(samples_dir: Path = SAMPLES_DIR) -> list[Path]:
    paths = [samples_dir / name for name in SAMPLE_VIDEOS]
    missing = [path.name for path in paths if not path.is_file()]
    if missing:
        raise FileNotFoundError(f"local samples missing: {', '.join(missing)} (scripts/download-test-data.sh --verify-only)")
    return paths


def tracknet_windows(video: Path, seq_len: int, bg_mode: str, parity: int, limit: int) -> Iterator[tuple[list[int], np.ndarray]]:
    """(frame indices, (C, H, W) input) for every second window of the clip (parity 0 or 1), at most ``limit``."""
    info = probe_video(str(video))
    _count, samples, _full = sample_background_frames(str(video), info.frame_count, 120)
    median = median_background(samples)
    window: list[tuple[int, np.ndarray]] = []
    number, produced = 0, 0
    for index, frame in iter_frames(str(video)):
        window.append((index, resize_to_model(frame)))
        if len(window) < seq_len:
            continue
        if number % 2 == parity:
            yield [i for i, _ in window], build_window_input(np.stack([f for _, f in window]), median, bg_mode)
            produced += 1
            if produced >= limit:
                return
        number += 1
        window = []


def yolox_frames(video: Path, parity: int, every: int, limit: int) -> Iterator[tuple[int, np.ndarray, np.ndarray]]:
    """(frame index, BGR frame, letterboxed blob) for every ``every``-th frame of the given parity, at most ``limit``."""
    produced = 0
    for index, frame in iter_frames(str(video)):
        if index % every or (index // every) % 2 != parity:
            continue
        padded, _ratio = letterbox(frame)
        yield index, frame, padded.transpose(2, 0, 1)[np.newaxis].astype(np.float32)
        produced += 1
        if produced >= limit:
            return
