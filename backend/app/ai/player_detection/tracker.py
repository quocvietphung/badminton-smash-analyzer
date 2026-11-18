"""Greedy IoU tracker for person boxes.

Uses bounding-box geometry only (IoU between the last box and the new detection). It does
not compute face, identity or appearance features. Track IDs identify video fragments, not
athletes: a player can receive a new ID after an occlusion or a missed-detection gap.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Sequence

from app.ai.player_detection.yolox import Detection


@dataclass(frozen=True)
class TrackObservation:
    frame: int
    track_id: int
    x1: float
    y1: float
    x2: float
    y2: float
    score: float
    confirmed: bool

    @property
    def foot_x(self) -> float:
        return (self.x1 + self.x2) / 2.0

    @property
    def foot_y(self) -> float:
        return self.y2

    @property
    def centre_x(self) -> float:
        return (self.x1 + self.x2) / 2.0

    @property
    def centre_y(self) -> float:
        return (self.y1 + self.y2) / 2.0


@dataclass
class _Track:
    track_id: int
    box: tuple[float, float, float, float]
    score: float
    hits: int = 1
    misses: int = 0
    history: list[int] = field(default_factory=list)


def iou(a: Sequence[float], b: Sequence[float]) -> float:
    ix1 = max(a[0], b[0])
    iy1 = max(a[1], b[1])
    ix2 = min(a[2], b[2])
    iy2 = min(a[3], b[3])
    inter_w = max(0.0, ix2 - ix1)
    inter_h = max(0.0, iy2 - iy1)
    inter = inter_w * inter_h
    if inter <= 0.0:
        return 0.0
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


class IouTracker:
    """Associates per-frame detections with tracks.

    - At most ``max_players`` detections per frame are kept (largest boxes, weighted by score).
    - Boxes shorter than ``min_height_ratio`` of the frame height are ignored (spectators, far background).
    - A track is confirmed after ``min_hits`` matched frames; only confirmed tracks feed analytics.
    """

    def __init__(
        self,
        frame_height: int,
        iou_threshold: float = 0.3,
        max_misses: int = 15,
        min_hits: int = 3,
        max_players: int = 4,
        min_height_ratio: float = 0.06,
    ) -> None:
        self.frame_height = frame_height
        self.iou_threshold = iou_threshold
        self.max_misses = max_misses
        self.min_hits = min_hits
        self.max_players = max_players
        self.min_height_ratio = min_height_ratio
        self._tracks: list[_Track] = []
        self._next_id = 1

    def _filter(self, detections: Sequence[Detection]) -> list[Detection]:
        min_height = self.frame_height * self.min_height_ratio
        kept = [d for d in detections if d.height >= min_height]
        kept.sort(key=lambda d: d.height * d.width * d.score, reverse=True)
        return kept[: self.max_players]

    def update(self, frame: int, detections: Sequence[Detection]) -> list[TrackObservation]:
        dets = self._filter(detections)
        pairs = []
        for t_index, track in enumerate(self._tracks):
            for d_index, det in enumerate(dets):
                score = iou(track.box, (det.x1, det.y1, det.x2, det.y2))
                if score >= self.iou_threshold:
                    pairs.append((score, t_index, d_index))
        pairs.sort(reverse=True)
        used_tracks: set[int] = set()
        used_dets: set[int] = set()
        observations: list[TrackObservation] = []
        for _, t_index, d_index in pairs:
            if t_index in used_tracks or d_index in used_dets:
                continue
            used_tracks.add(t_index)
            used_dets.add(d_index)
            track = self._tracks[t_index]
            det = dets[d_index]
            track.box = (det.x1, det.y1, det.x2, det.y2)
            track.score = det.score
            track.hits += 1
            track.misses = 0
            track.history.append(frame)
            observations.append(self._observation(frame, track))
        for t_index, track in enumerate(self._tracks):
            if t_index not in used_tracks:
                track.misses += 1
        for d_index, det in enumerate(dets):
            if d_index in used_dets:
                continue
            track = _Track(self._next_id, (det.x1, det.y1, det.x2, det.y2), det.score, history=[frame])
            self._next_id += 1
            self._tracks.append(track)
            observations.append(self._observation(frame, track))
        self._tracks = [t for t in self._tracks if t.misses <= self.max_misses]
        return observations

    def _observation(self, frame: int, track: _Track) -> TrackObservation:
        x1, y1, x2, y2 = track.box
        return TrackObservation(
            frame=frame,
            track_id=track.track_id,
            x1=x1,
            y1=y1,
            x2=x2,
            y2=y2,
            score=track.score,
            confirmed=track.hits >= self.min_hits,
        )
