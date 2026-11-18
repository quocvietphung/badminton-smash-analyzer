"""TrackNetV3 shuttlecock heatmap tracking on ONNX Runtime (CPU).

Re-implements the inference path of TrackNetV3 for the released TrackNet checkpoint
(MIT License, Copyright (c) 2024 qaz812345, https://github.com/qaz812345/TrackNetV3).
The exported checkpoint uses bg_mode="concat": 27 input channels = background median
frame + 8 RGB frames, each resized to 512x288 with PIL bicubic and scaled to [0, 1].

Output is a detection in image coordinates. It is not racket-contact or shuttle-flight
measurement, and the module never reports shuttle speed in physical units.

Deviations from the reference implementation (also listed in the inference report):
- Non-overlapping windows (TrackNetV3 eval_mode "nonoverlap") to keep CPU time practical.
- The background median is computed from up to 120 sampled frames already resized to
  512x288, not from every full-resolution frame.
"""

from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass
from typing import Callable, Optional, Sequence

import cv2
import numpy as np
from PIL import Image

MODEL_HEIGHT = 288
MODEL_WIDTH = 512
HEATMAP_THRESHOLD = 0.5
# TrackNetV3 utils/general.py: DELTA_T = 1 / sqrt(H^2 + W^2); COOR_TH = DELTA_T * 50
COOR_TH = (1.0 / math.sqrt(MODEL_HEIGHT**2 + MODEL_WIDTH**2)) * 50

BatchFn = Callable[[np.ndarray], np.ndarray]


@dataclass(frozen=True)
class TrackNetFrame:
    """Per-frame shuttle detection in source-image pixel coordinates."""

    frame: int
    x: int
    y: int
    visible: bool
    confidence: float
    refined: bool = False


def position_weights(seq_len: int) -> np.ndarray:
    """Symmetric position weights of TrackNetV3 temporal ensembling, normalised to sum 1."""
    weight = np.ones(seq_len, dtype=np.float64)
    for i in range(math.ceil(seq_len / 2)):
        weight[i] = i + 1
        weight[seq_len - i - 1] = i + 1
    return weight / weight.sum()


def resize_to_model(frame_bgr: np.ndarray) -> np.ndarray:
    """Resize one BGR frame to the model grid (PIL bicubic, RGB, uint8)."""
    rgb = np.ascontiguousarray(frame_bgr[..., ::-1])
    resized = Image.fromarray(rgb).resize((MODEL_WIDTH, MODEL_HEIGHT), Image.BICUBIC)
    return np.asarray(resized, dtype=np.uint8)


def median_background(samples: Sequence[np.ndarray]) -> np.ndarray:
    """Median of model-sized RGB frames, truncated to uint8 as in TrackNetV3 dataset.py."""
    if len(samples) == 0:
        raise ValueError("at least one sampled frame is required for the background median")
    stacked = np.stack([np.asarray(s, dtype=np.uint8) for s in samples], axis=0)
    return np.median(stacked, axis=0).astype(np.uint8)


def build_window_input(frames_rgb: np.ndarray, median_rgb: Optional[np.ndarray], bg_mode: str = "concat") -> np.ndarray:
    """Build one TrackNet input of shape (C, H, W) float32 in [0, 1]."""
    if bg_mode not in ("concat", ""):
        raise ValueError(f"unsupported bg_mode for this export: {bg_mode!r}")
    blocks = []
    if bg_mode == "concat":
        if median_rgb is None:
            raise ValueError("bg_mode 'concat' needs a background median frame")
        blocks.append(np.moveaxis(np.asarray(median_rgb, dtype=np.uint8), -1, 0))
    for frame in frames_rgb:
        blocks.append(np.moveaxis(np.asarray(frame, dtype=np.uint8), -1, 0))
    return np.concatenate(blocks, axis=0).astype(np.float32) / 255.0


def heatmap_to_point(heatmap: np.ndarray) -> tuple[int, int, float]:
    """Centre of the largest thresholded region in a (H, W) heatmap, in model pixels.

    Returns (0, 0, 0.0) when nothing exceeds HEATMAP_THRESHOLD, matching TrackNetV3 predict().
    """
    binary = (heatmap > HEATMAP_THRESHOLD).astype(np.uint8) * 255
    if int(binary.max()) == 0:
        return 0, 0, 0.0
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    rects = [cv2.boundingRect(contour) for contour in contours]
    if not rects:
        return 0, 0, 0.0
    best = rects[0]
    best_area = best[2] * best[3]
    for rect in rects[1:]:
        area = rect[2] * rect[3]
        if area > best_area:
            best, best_area = rect, area
    x, y, w, h = best
    if w <= 0 or h <= 0:
        return 0, 0, 0.0
    confidence = float(heatmap[y : y + h, x : x + w].max())
    return int(x + w / 2), int(y + h / 2), confidence


def model_point_to_source(cx: int, cy: int, src_w: int, src_h: int) -> tuple[int, int]:
    """Scale a model-grid point to source pixels exactly as TrackNetV3 predict() does."""
    return int(cx * (src_w / MODEL_WIDTH)), int(cy * (src_h / MODEL_HEIGHT))


def heatmaps_to_frames(
    heatmaps: np.ndarray, frame_indices: Sequence[int], src_w: int, src_h: int
) -> list[TrackNetFrame]:
    """Convert (N, H, W) heatmaps for the given frame indices into per-frame detections."""
    results: list[TrackNetFrame] = []
    for heat, frame_index in zip(heatmaps, frame_indices):
        cx, cy, conf = heatmap_to_point(heat)
        x, y = model_point_to_source(cx, cy, src_w, src_h)
        visible = not (x == 0 and y == 0)
        results.append(TrackNetFrame(frame=int(frame_index), x=x, y=y, visible=visible, confidence=conf if visible else 0.0))
    return results


class NonOverlappingShuttleTracker:
    """Streaming TrackNet inference over non-overlapping windows of ``seq_len`` frames.

    ``infer`` maps a batch (B, C, H, W) float32 to heatmaps (B, L, H, W) float32. Pass the
    ONNX session wrapper in production and a fake callable in unit tests.
    """

    def __init__(
        self,
        infer: BatchFn,
        median_rgb: Optional[np.ndarray],
        src_w: int,
        src_h: int,
        seq_len: int = 8,
        bg_mode: str = "concat",
        batch_size: int = 4,
    ) -> None:
        if seq_len < 1:
            raise ValueError("seq_len must be positive")
        self._infer = infer
        self._median = median_rgb
        self._src_w = int(src_w)
        self._src_h = int(src_h)
        self._seq_len = int(seq_len)
        self._bg_mode = bg_mode
        self._batch_size = max(1, int(batch_size))
        self._window_frames: list[tuple[int, np.ndarray]] = []
        self._queue: list[tuple[list[int], np.ndarray]] = []
        self.windows_run = 0

    def push(self, frame_index: int, small_rgb: np.ndarray) -> list[TrackNetFrame]:
        self._window_frames.append((int(frame_index), small_rgb))
        if len(self._window_frames) == self._seq_len:
            self._close_window()
        return self._drain(final=False)

    def finish(self) -> list[TrackNetFrame]:
        if self._window_frames:
            self._close_window()
        return self._drain(final=True)

    def _close_window(self) -> None:
        real = list(self._window_frames)
        indices = [index for index, _ in real]
        frames = [frame for _, frame in real]
        while len(frames) < self._seq_len:
            frames.append(frames[-1])  # pad the last window like TrackNetV3 padding=True
        stacked = np.stack(frames, axis=0)
        self._queue.append((indices, build_window_input(stacked, self._median, self._bg_mode)))
        self._window_frames = []

    def _drain(self, final: bool) -> list[TrackNetFrame]:
        results: list[TrackNetFrame] = []
        while self._queue and (final or len(self._queue) >= self._batch_size):
            batch = self._queue[: self._batch_size]
            self._queue = self._queue[self._batch_size :]
            tensor = np.stack([tensor for _, tensor in batch], axis=0)
            heatmaps = self._infer(tensor)
            self.windows_run += len(batch)
            for (indices, _), window_heat in zip(batch, heatmaps):
                results.extend(heatmaps_to_frames(window_heat[: len(indices)], indices, self._src_w, self._src_h))
        return results


class TrackNetV3Model:
    """ONNX Runtime wrapper for the exported TrackNet model."""

    def __init__(self, model_dir: str, threads: int = 4) -> None:
        from app.ai.runtime import session_options

        sidecar_path = os.path.join(model_dir, "tracknetv3_export.json")
        with open(sidecar_path, encoding="utf-8") as handle:
            sidecar = json.load(handle)["models"]["tracknet"]
        self.seq_len = int(sidecar["seq_len"])
        self.bg_mode = str(sidecar["bg_mode"])
        self.input_channels = int(sidecar["input_channels"])
        self.onnx_sha256 = str(sidecar["onnx_sha256"])
        self.checkpoint_sha256 = str(sidecar["checkpoint_sha256"])
        self.file_name = str(sidecar["file"])
        import onnxruntime as ort

        self._session = ort.InferenceSession(
            os.path.join(model_dir, sidecar["file"]), sess_options=session_options(threads), providers=["CPUExecutionProvider"]
        )
        self._input_name = sidecar["input_name"]

    @property
    def providers(self) -> list[str]:
        """Execution providers the ONNX Runtime session actually uses."""
        return list(self._session.get_providers())

    def __call__(self, batch: np.ndarray) -> np.ndarray:
        if batch.shape[1] != self.input_channels:
            raise ValueError(f"TrackNet expects {self.input_channels} channels, got {batch.shape[1]}")
        return self._session.run(None, {self._input_name: batch.astype(np.float32, copy=False)})[0]


def export_sidecar_path(model_dir: str) -> str:
    return os.path.join(model_dir, "tracknetv3_export.json")
