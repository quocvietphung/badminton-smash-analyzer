"""YOLOX-s person detection on ONNX Runtime (CPU).

Model: object_detection_yolox_2022nov.onnx from opencv/opencv_zoo (Apache-2.0) with YOLOX
weights (Megvii, Apache-2.0). Decoding follows the opencv_zoo reference (Apache-2.0):
grid offsets, exp-scaled sizes, objectness x class score, batched NMS. Only the COCO
"person" class (index 0) is kept. No face or identity features are computed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

import cv2
import numpy as np

INPUT_SIZE = 640
STRIDES = (8, 16, 32)
PERSON_CLASS = 0
PAD_VALUE = 114


@dataclass(frozen=True)
class Detection:
    x1: float
    y1: float
    x2: float
    y2: float
    score: float

    @property
    def width(self) -> float:
        return self.x2 - self.x1

    @property
    def height(self) -> float:
        return self.y2 - self.y1


def build_grids(input_size: int = INPUT_SIZE, strides: Sequence[int] = STRIDES) -> tuple[np.ndarray, np.ndarray]:
    """Anchor grid (N, 2) and per-anchor stride (N, 1) in row-major order over y then x."""
    grids = []
    expanded = []
    for stride in strides:
        size = input_size // stride
        xv, yv = np.meshgrid(np.arange(size), np.arange(size))
        grid = np.stack((xv, yv), axis=2).reshape(-1, 2).astype(np.float32)
        grids.append(grid)
        expanded.append(np.full((grid.shape[0], 1), stride, dtype=np.float32))
    return np.concatenate(grids, axis=0), np.concatenate(expanded, axis=0)


def letterbox(frame_bgr: np.ndarray, size: int = INPUT_SIZE) -> tuple[np.ndarray, float]:
    """Resize keeping aspect ratio and pad bottom/right with 114, as in the YOLOX demo."""
    height, width = frame_bgr.shape[:2]
    ratio = min(size / height, size / width)
    new_h = int(height * ratio)
    new_w = int(width * ratio)
    resized = cv2.resize(frame_bgr, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
    padded = np.full((size, size, 3), PAD_VALUE, dtype=np.uint8)
    padded[:new_h, :new_w] = resized
    return padded, ratio


def decode_predictions(
    output: np.ndarray,
    grids: np.ndarray,
    strides: np.ndarray,
    ratio: float,
    frame_w: int,
    frame_h: int,
    conf_threshold: float = 0.35,
    nms_threshold: float = 0.45,
) -> list[Detection]:
    """Decode raw YOLOX output (N, 85) into person detections in source-frame pixels."""
    dets = np.asarray(output, dtype=np.float32).copy()
    dets[:, :2] = (dets[:, :2] + grids) * strides
    dets[:, 2:4] = np.exp(dets[:, 2:4]) * strides
    centre_x, centre_y, box_w, box_h = dets[:, 0], dets[:, 1], dets[:, 2], dets[:, 3]
    scores = dets[:, 4] * dets[:, 5 + PERSON_CLASS]
    keep = np.where(scores >= conf_threshold)[0]
    if keep.size == 0:
        return []
    x1 = centre_x[keep] - box_w[keep] / 2.0
    y1 = centre_y[keep] - box_h[keep] / 2.0
    boxes_xywh = np.stack([x1, y1, box_w[keep], box_h[keep]], axis=1)
    kept_scores = scores[keep]
    indices = cv2.dnn.NMSBoxes(boxes_xywh.tolist(), kept_scores.tolist(), conf_threshold, nms_threshold)
    selected = np.asarray(indices).reshape(-1) if len(indices) else np.array([], dtype=np.int64)
    detections: list[Detection] = []
    for idx in selected:
        i = keep[int(idx)]
        ax1 = float(np.clip(x1[int(idx)] / ratio, 0, frame_w))
        ay1 = float(np.clip(y1[int(idx)] / ratio, 0, frame_h))
        ax2 = float(np.clip((centre_x[i] + box_w[i] / 2.0) / ratio, 0, frame_w))
        ay2 = float(np.clip((centre_y[i] + box_h[i] / 2.0) / ratio, 0, frame_h))
        if ax2 > ax1 and ay2 > ay1:
            detections.append(Detection(ax1, ay1, ax2, ay2, float(kept_scores[int(idx)])))
    detections.sort(key=lambda d: d.score, reverse=True)
    return detections


class YoloXPersonDetector:
    """ONNX Runtime wrapper for YOLOX-s; returns person boxes for one BGR frame."""

    def __init__(self, model_path: str, conf_threshold: float = 0.35, nms_threshold: float = 0.45, threads: int = 4) -> None:
        import onnxruntime as ort  # noqa: F401

        from app.ai.runtime import session_options

        self._session = ort.InferenceSession(model_path, sess_options=session_options(threads), providers=["CPUExecutionProvider"])
        self._input_name = self._session.get_inputs()[0].name
        self._grids, self._strides = build_grids()
        self.conf_threshold = conf_threshold
        self.nms_threshold = nms_threshold

    @property
    def providers(self) -> list[str]:
        """Execution providers the ONNX Runtime session actually uses."""
        return list(self._session.get_providers())

    def detect(self, frame_bgr: np.ndarray) -> list[Detection]:
        height, width = frame_bgr.shape[:2]
        padded, ratio = letterbox(frame_bgr)
        blob = padded.transpose(2, 0, 1)[np.newaxis].astype(np.float32)
        output = self._session.run(None, {self._input_name: blob})[0][0]
        return decode_predictions(
            output, self._grids, self._strides, ratio, width, height, self.conf_threshold, self.nms_threshold
        )
