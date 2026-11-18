"""InpaintNet trajectory refinement for TrackNetV3 (MIT License, qaz812345/TrackNetV3).

Fills short missing segments of the TrackNet trajectory with the InpaintNet 1-D model:
- inpaint mask = segments where the shuttle is hidden between visible detections and the
  surrounding detections are below the image-height threshold (TrackNetV3 generate_inpaint_mask);
- windows of 16 frames with a positional temporal ensemble (TrackNetV3 eval_mode "weight");
- thresholding of near-zero coordinates with COOR_TH, as in the reference code.
"""

from __future__ import annotations

from typing import Callable, Sequence

import numpy as np

from app.ai.shuttle_tracking.tracknet import COOR_TH, TrackNetFrame, position_weights

InpaintFn = Callable[[np.ndarray, np.ndarray], np.ndarray]


def generate_inpaint_mask(y: Sequence[float], visible: Sequence[int], th_h: float) -> np.ndarray:
    """Replicates TrackNetV3 test.generate_inpaint_mask (MIT)."""
    y_arr = np.asarray(y, dtype=np.float64)
    vis = np.asarray(visible, dtype=np.int64)
    n = len(vis)
    mask = np.zeros(n, dtype=np.int64)
    i = 0
    j = 0
    while j < n:
        while i < n - 1 and vis[i] == 1:
            i += 1
        j = i
        while j < n - 1 and vis[j] == 0:
            j += 1
        if j == i:
            break
        if i == 0 and y_arr[j] > th_h:
            mask[:j] = 1
        elif (i > 1 and y_arr[i - 1] > th_h) and (j < n and y_arr[j] > th_h):
            mask[i:j] = 1
        i = j
    return mask


def refine_trajectory(
    frames: Sequence[TrackNetFrame],
    src_w: int,
    src_h: int,
    infer: InpaintFn,
    seq_len: int = 16,
    batch_size: int = 256,
) -> list[TrackNetFrame]:
    """Refine TrackNet detections; returns one TrackNetFrame per input frame in order."""
    n = len(frames)
    if n < seq_len:
        return [TrackNetFrame(f.frame, f.x, f.y, f.visible, f.confidence, False) for f in frames]

    xs = np.array([f.x for f in frames], dtype=np.float64)
    ys = np.array([f.y for f in frames], dtype=np.float64)
    vis = [1 if f.visible else 0 for f in frames]
    mask = generate_inpaint_mask(ys, vis, th_h=src_h * 0.05)
    coords = np.stack([xs / src_w, ys / src_h], axis=1).astype(np.float32)

    weights = position_weights(seq_len)
    weighted_sum = np.zeros((n, 2), dtype=np.float64)
    uniform_sum = np.zeros((n, 2), dtype=np.float64)
    counts = np.zeros(n, dtype=np.int64)

    window_starts = np.arange(0, n - seq_len + 1)
    offsets = np.arange(seq_len)
    for start in range(0, len(window_starts), batch_size):
        starts = window_starts[start : start + batch_size]
        idx = starts[:, None] + offsets[None, :]
        window_coords = coords[idx]
        window_mask = mask[idx].astype(np.float32)[..., None]
        predicted = np.asarray(infer(window_coords, window_mask), dtype=np.float32)
        blended = predicted * window_mask + window_coords * (1.0 - window_mask)
        near_zero = (blended[..., 0] < COOR_TH) & (blended[..., 1] < COOR_TH)
        blended[near_zero] = 0.0
        for b, k in enumerate(starts):
            for p in range(seq_len):
                t = int(k) + p
                weighted_sum[t] += weights[p] * blended[b, p]
                uniform_sum[t] += blended[b, p]
                counts[t] += 1

    refined: list[TrackNetFrame] = []
    for t, frame in enumerate(frames):
        if mask[t] == 0:
            # frames outside the inpaint mask keep the TrackNet detection exactly
            refined.append(frame)
            continue
        if counts[t] == seq_len:
            point = weighted_sum[t]
        elif counts[t] > 0:
            point = uniform_sum[t] / counts[t]
        else:
            point = np.array([coords[t, 0], coords[t, 1]], dtype=np.float64)
        if point[0] < COOR_TH and point[1] < COOR_TH:
            point = np.zeros(2, dtype=np.float64)
        x = int(round(point[0] * src_w))
        y = int(round(point[1] * src_h))
        visible = not (x == 0 and y == 0)
        changed = (x, y) != (frame.x, frame.y)
        refined.append(
            TrackNetFrame(
                frame=frame.frame,
                x=x,
                y=y,
                visible=visible,
                confidence=0.0,  # interpolated points carry no TrackNet heatmap confidence
                refined=changed,
            )
        )
    return refined


class InpaintNetModel:
    """ONNX Runtime wrapper for the exported InpaintNet model (inputs: coords, mask)."""

    def __init__(self, model_path: str, seq_len: int = 16, threads: int = 4) -> None:
        from app.ai.runtime import session_options

        import onnxruntime as ort  # noqa: F401  (ensures the provider is loaded before the session)

        self.seq_len = int(seq_len)
        self._session = ort.InferenceSession(model_path, sess_options=session_options(threads), providers=["CPUExecutionProvider"])

    @property
    def providers(self) -> list[str]:
        """Execution providers the ONNX Runtime session actually uses."""
        return list(self._session.get_providers())

    def __call__(self, coords: np.ndarray, mask: np.ndarray) -> np.ndarray:
        return self._session.run(
            None,
            {"coords": coords.astype(np.float32, copy=False), "mask": mask.astype(np.float32, copy=False)},
        )[0]
