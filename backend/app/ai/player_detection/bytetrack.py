"""ByteTrack-style multi-object tracker (own implementation).

Implemented from the published method description (Zhang et al., "ByteTrack: Multi-Object Tracking by
Associating Every Detection Box", ECCV 2022): detections are split into high- and low-score sets, the
high-score set is matched to predicted tracks first, the low-score set is matched to the tracks that were
left over, and the rest start new tentative tracks. Motion is predicted with a constant-velocity Kalman
filter, and assignments use Hungarian matching on IoU. No ByteTrack code is copied (see docs/REFERENCE_REVIEW.md).

The tracker only produces temporary track IDs. Logical player identities are assigned by app.ai.player_detection.identity.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


def hungarian(cost: np.ndarray) -> list[tuple[int, int]]:
    """Minimum-cost assignment for a rectangular matrix (Kuhn-Munkres, O(n^3)). Returns (row, col) pairs."""
    matrix = np.asarray(cost, dtype=np.float64)
    if matrix.size == 0:
        return []
    transposed = matrix.shape[0] > matrix.shape[1]
    if transposed:
        matrix = matrix.T
    n, m = matrix.shape  # n <= m
    u = np.zeros(n + 1)
    v = np.zeros(m + 1)
    p = np.zeros(m + 1, dtype=np.int64)
    way = np.zeros(m + 1, dtype=np.int64)
    for i in range(1, n + 1):
        p[0] = i
        j0 = 0
        minv = np.full(m + 1, np.inf)
        used = np.zeros(m + 1, dtype=bool)
        while True:
            used[j0] = True
            i0 = p[j0]
            delta = np.inf
            j1 = 0
            for j in range(1, m + 1):
                if not used[j]:
                    current = matrix[i0 - 1, j - 1] - u[i0] - v[j]
                    if current < minv[j]:
                        minv[j] = current
                        way[j] = j0
                    if minv[j] < delta:
                        delta = minv[j]
                        j1 = j
            for j in range(m + 1):
                if used[j]:
                    u[p[j]] += delta
                    v[j] -= delta
                else:
                    minv[j] -= delta
            j0 = j1
            if p[j0] == 0:
                break
        while True:
            j1 = way[j0]
            p[j0] = p[j1]
            j0 = j1
            if j0 == 0:
                break
    pairs = [(int(p[j]) - 1, j - 1) for j in range(1, m + 1) if p[j] != 0]
    if transposed:
        pairs = [(col, row) for row, col in pairs]
    return sorted(pairs)


def iou_matrix(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """IoU between rows of a (N, 4) and rows of b (M, 4), both as x1, y1, x2, y2."""
    if a.size == 0 or b.size == 0:
        return np.zeros((a.shape[0], b.shape[0]))
    x1 = np.maximum(a[:, None, 0], b[None, :, 0])
    y1 = np.maximum(a[:, None, 1], b[None, :, 1])
    x2 = np.minimum(a[:, None, 2], b[None, :, 2])
    y2 = np.minimum(a[:, None, 3], b[None, :, 3])
    inter = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
    area_a = (a[:, 2] - a[:, 0]) * (a[:, 3] - a[:, 1])
    area_b = (b[:, 2] - b[:, 0]) * (b[:, 3] - b[:, 1])
    union = area_a[:, None] + area_b[None, :] - inter
    return np.where(union > 0, inter / np.maximum(union, 1e-9), 0.0)


# Constant-velocity model over (cx, cy, w, h) with one-frame steps.
_F = np.eye(8)
_F[:4, 4:] = np.eye(4)
_H = np.zeros((4, 8))
_H[:, :4] = np.eye(4)
_Q = np.diag([4.0, 4.0, 4.0, 4.0, 1.0, 1.0, 1.0, 1.0])
_R = np.diag([4.0, 4.0, 4.0, 4.0])


def _xyxy_to_cxcywh(box: np.ndarray) -> np.ndarray:
    return np.array([(box[0] + box[2]) / 2, (box[1] + box[3]) / 2, box[2] - box[0], box[3] - box[1]])


def _cxcywh_to_xyxy(state: np.ndarray) -> np.ndarray:
    cx, cy, w, h = state[:4]
    return np.array([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2])


@dataclass(frozen=True)
class TrackedBox:
    track_id: int
    frame: int
    x1: float
    y1: float
    x2: float
    y2: float
    score: float
    confirmed: bool
    det_index: int


@dataclass
class _Track:
    track_id: int
    mean: np.ndarray
    cov: np.ndarray
    score: float
    hits: int = 1
    misses: int = 0
    last_frame: int = -1

    def predicted_xyxy(self) -> np.ndarray:
        return _cxcywh_to_xyxy(self.mean)


class ByteTracker:
    """Two-stage association. ``update`` returns the boxes matched in the current frame."""

    def __init__(
        self,
        high_threshold: float = 0.5,
        low_threshold: float = 0.1,
        new_track_threshold: float = 0.5,
        match_iou: float = 0.3,
        second_match_iou: float = 0.5,
        max_age: int = 30,
        min_hits: int = 3,
    ) -> None:
        self.high_threshold = high_threshold
        self.low_threshold = low_threshold
        self.new_track_threshold = new_track_threshold
        self.match_iou = match_iou
        self.second_match_iou = second_match_iou
        self.max_age = max_age
        self.min_hits = min_hits
        self._tracks: list[_Track] = []
        self._next_id = 1

    def _associate(self, tracks: list[_Track], det_boxes: np.ndarray, det_indices: list[int], min_iou: float):
        if not tracks or not det_indices:
            return [], list(range(len(tracks))), []
        predicted = np.stack([t.predicted_xyxy() for t in tracks])
        iou = iou_matrix(predicted, det_boxes[det_indices])
        pairs = hungarian(1.0 - iou)
        matched = [(ti, det_indices[di]) for ti, di in pairs if iou[ti, di] >= min_iou]
        matched_tracks = {ti for ti, _ in matched}
        matched_dets = {d for _, d in matched}
        unmatched_tracks = [i for i in range(len(tracks)) if i not in matched_tracks]
        unmatched_dets = [d for d in det_indices if d not in matched_dets]
        return matched, unmatched_tracks, unmatched_dets

    def update(self, frame: int, detections: np.ndarray) -> list[TrackedBox]:
        """detections: (N, 5) array of x1, y1, x2, y2, score for one frame."""
        boxes = np.asarray(detections, dtype=np.float64).reshape(-1, 5)
        for track in self._tracks:
            track.mean, track.cov = _F @ track.mean, _F @ track.cov @ _F.T + _Q

        scores = boxes[:, 4]
        high = [i for i in range(len(boxes)) if scores[i] >= self.high_threshold]
        low = [i for i in range(len(boxes)) if self.low_threshold <= scores[i] < self.high_threshold]

        active = list(self._tracks)
        matched, left_tracks, _ = self._associate(active, boxes[:, :4], high, self.match_iou)
        assigned: dict[int, int] = {}  # track index -> det index
        for ti, di in matched:
            assigned[ti] = di
        remaining_tracks = [active[i] for i in left_tracks]
        remaining_index = {id(t): i for i, t in enumerate(active)}

        second_pairs, _, _ = self._associate(remaining_tracks, boxes[:, :4], low, self.second_match_iou)
        for local_ti, di in second_pairs:
            assigned[remaining_index[id(remaining_tracks[local_ti])]] = di

        matched_det_ids = set(assigned.values())
        unmatched_high = [i for i in high if i not in matched_det_ids and scores[i] >= self.new_track_threshold]

        output: list[TrackedBox] = []
        for ti, track in enumerate(active):
            if ti in assigned:
                di = assigned[ti]
                x1, y1, x2, y2, score = boxes[di]
                measurement = _xyxy_to_cxcywh(np.array([x1, y1, x2, y2]))
                innovation = measurement - _H @ track.mean
                s = _H @ track.cov @ _H.T + _R
                gain = track.cov @ _H.T @ np.linalg.inv(s)
                track.mean = track.mean + gain @ innovation
                track.cov = (np.eye(8) - gain @ _H) @ track.cov
                track.score = float(score)
                track.hits += 1
                track.misses = 0
                track.last_frame = frame
                output.append(TrackedBox(track.track_id, frame, x1, y1, x2, y2, float(score), track.hits >= self.min_hits, di))
            else:
                track.misses += 1

        for di in unmatched_high:
            x1, y1, x2, y2, score = boxes[di]
            mean = np.concatenate([_xyxy_to_cxcywh(np.array([x1, y1, x2, y2])), np.zeros(4)])
            cov = np.diag([10.0, 10.0, 10.0, 10.0, 25.0, 25.0, 25.0, 25.0])
            track = _Track(self._next_id, mean, cov, float(score), last_frame=frame)
            self._next_id += 1
            self._tracks.append(track)
            output.append(TrackedBox(track.track_id, frame, x1, y1, x2, y2, float(score), track.hits >= self.min_hits, di))

        self._tracks = [t for t in self._tracks if t.misses <= self.max_age]
        return sorted(output, key=lambda item: item.track_id)
