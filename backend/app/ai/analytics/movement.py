"""Image-space analytics for player tracks and the shuttle detections.

Every distance here is in normalised image units: pixel distance divided by the image
diagonal, so the value is unitless and comparable only within one video. These numbers are
not metres, not km/h and not stamina. Shot counts, rally segmentation and shuttle speed in
physical units are not computed (see rally_detection and the inference report).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable, Sequence

import numpy as np

from app.ai.player_detection.tracker import TrackObservation
from app.ai.shuttle_tracking.tracknet import TrackNetFrame

HEATMAP_COLS = 12
HEATMAP_ROWS = 8


@dataclass(frozen=True)
class PlayerMovement:
    track_id: int
    first_frame: int
    last_frame: int
    observed_frames: int
    coverage_ratio: float
    segments: int
    path_length_norm: float
    time_observed_s: float
    avg_speed_norm_per_s: float
    mean_score: float

    def as_dict(self) -> dict:
        return {
            "track_id": self.track_id,
            "first_frame": self.first_frame,
            "last_frame": self.last_frame,
            "observed_frames": self.observed_frames,
            "coverage_ratio": round(self.coverage_ratio, 4),
            "segments": self.segments,
            "path_length_norm": round(self.path_length_norm, 4),
            "time_observed_s": round(self.time_observed_s, 3),
            "avg_speed_norm_per_s": round(self.avg_speed_norm_per_s, 4),
            "mean_score": round(self.mean_score, 4),
        }


def _diagonal(width: int, height: int) -> float:
    return math.hypot(width, height)


def compute_player_movements(
    observations: Iterable[TrackObservation],
    fps: float,
    width: int,
    height: int,
    total_frames: int,
    max_gap: int = 3,
    min_observed_frames: int = 1,
) -> list[PlayerMovement]:
    """Movement per confirmed track. Steps are counted only between frames at most ``max_gap`` apart."""
    by_track: dict[int, list[TrackObservation]] = {}
    for obs in observations:
        if obs.confirmed:
            by_track.setdefault(obs.track_id, []).append(obs)
    diag = _diagonal(width, height)
    results: list[PlayerMovement] = []
    for track_id in sorted(by_track):
        items = sorted(by_track[track_id], key=lambda o: o.frame)
        if len(items) < min_observed_frames:
            continue
        path = 0.0
        segments = 1
        for prev, cur in zip(items, items[1:]):
            gap = cur.frame - prev.frame
            if gap <= max_gap:
                step = math.hypot(cur.foot_x - prev.foot_x, cur.foot_y - prev.foot_y) / diag
                path += step
            else:
                segments += 1
        first_frame = items[0].frame
        last_frame = items[-1].frame
        observed = len(items)
        time_observed = observed / fps if fps > 0 else 0.0
        results.append(
            PlayerMovement(
                track_id=track_id,
                first_frame=first_frame,
                last_frame=last_frame,
                observed_frames=observed,
                coverage_ratio=observed / total_frames if total_frames > 0 else 0.0,
                segments=segments,
                path_length_norm=path,
                time_observed_s=time_observed,
                avg_speed_norm_per_s=(path / time_observed) if time_observed > 0 else 0.0,
                mean_score=float(np.mean([o.score for o in items])),
            )
        )
    return results


def foot_heatmap(
    observations: Iterable[TrackObservation], width: int, height: int, cols: int = HEATMAP_COLS, rows: int = HEATMAP_ROWS
) -> dict:
    """Occupancy grid of confirmed foot points in normalised image coordinates."""
    counts = np.zeros((rows, cols), dtype=np.int64)
    for obs in observations:
        if not obs.confirmed:
            continue
        u = min(max(obs.foot_x / width, 0.0), 0.999999)
        v = min(max(obs.foot_y / height, 0.0), 0.999999)
        counts[int(v * rows), int(u * cols)] += 1
    peak = int(counts.max())
    normalised = (counts / peak).round(4) if peak > 0 else counts.astype(float)
    return {
        "coordinate_space": "normalised image (0 = left/top, 1 = right/bottom)",
        "cols": cols,
        "rows": rows,
        "counts": counts.tolist(),
        "normalised": normalised.tolist(),
        "total_observations": int(counts.sum()),
    }


def shuttle_summary(frames: Sequence[TrackNetFrame], fps: float, width: int, height: int) -> dict:
    """Image-space proxy statistics for shuttle detections. Not a physical speed."""
    diag = _diagonal(width, height)
    visible = [f for f in frames if f.visible]
    total = len(frames)
    runs: list[int] = []
    current = 0
    for frame in frames:
        if frame.visible:
            current += 1
        elif current:
            runs.append(current)
            current = 0
    if current:
        runs.append(current)
    steps = []
    path = 0.0
    prev = None
    for frame in frames:
        if not frame.visible:
            prev = None
            continue
        if prev is not None and frame.frame - prev.frame == 1:
            step = math.hypot(frame.x - prev.x, frame.y - prev.y)
            steps.append(step)
            path += step / diag
        prev = frame
    detected = [f for f in visible if not f.refined]
    mean_conf = float(np.mean([f.confidence for f in detected])) if detected else 0.0
    return {
        "frames_total": total,
        "frames_visible": len(visible),
        "frames_detected": len(detected),
        "frames_interpolated": int(sum(1 for f in frames if f.refined)),
        "visible_ratio": round(len(visible) / total, 4) if total else 0.0,
        "detected_ratio": round(len(detected) / total, 4) if total else 0.0,
        "visible_runs": len(runs),
        "longest_visible_run_frames": max(runs) if runs else 0,
        "mean_confidence_detected": round(mean_conf, 4),
        "image_path_length_norm": round(path, 4),
        "step_px_per_frame_p95": round(float(np.percentile(steps, 95)), 2) if steps else None,
        "step_px_per_frame_max": round(float(max(steps)), 2) if steps else None,
        "units": "source pixels per frame (image space), not physical speed",
        "fps": fps,
    }


COURT_HEATMAP_COLS = 6
COURT_HEATMAP_ROWS = 13


def court_points(observations: Iterable[TrackObservation], h_image_from_court) -> dict[int, tuple[float, float]]:
    """Map confirmed foot points to floor-plane metres. Keys are the observation frame plus track id."""
    h_court_from_image = np.linalg.inv(np.asarray(h_image_from_court, dtype=np.float64))
    items = [o for o in observations if o.confirmed]
    if not items:
        return {}
    pts = np.array([[o.foot_x, o.foot_y, 1.0] for o in items]) @ h_court_from_image.T
    xy = pts[:, :2] / pts[:, 2:3]
    return {(o.frame, o.track_id): (float(x), float(y)) for o, (x, y) in zip(items, xy)}


def court_player_movements(
    observations: Iterable[TrackObservation],
    h_image_from_court,
    fps: float,
    total_frames: int,
    max_gap: int = 3,
    min_observed_frames: int = 1,
) -> list[dict]:
    """Approximate floor-plane distance per confirmed track (metres, flat-floor assumption)."""
    positions = court_points(observations, h_image_from_court)
    by_track: dict[int, list[tuple[int, float, float]]] = {}
    for (frame, track_id), (x, y) in positions.items():
        by_track.setdefault(track_id, []).append((frame, x, y))
    results = []
    for track_id in sorted(by_track):
        items = sorted(by_track[track_id])
        if len(items) < min_observed_frames:
            continue
        path = 0.0
        for (f0, x0, y0), (f1, x1, y1) in zip(items, items[1:]):
            if f1 - f0 <= max_gap:
                path += math.hypot(x1 - x0, y1 - y0)
        observed = len(items)
        time_observed = observed / fps if fps > 0 else 0.0
        inside = sum(1 for _, x, y in items if 0.0 <= x <= 6.10 and 0.0 <= y <= 13.40)
        results.append(
            {
                "track_id": track_id,
                "observed_frames": observed,
                "path_length_m": round(path, 3),
                "avg_speed_m_per_s": round(path / time_observed, 3) if time_observed > 0 else 0.0,
                "share_inside_doubles_outline": round(inside / observed, 4) if observed else 0.0,
                "note": "approximate floor-plane estimate from a single homography; flat-floor assumption",
            }
        )
    return results


def court_heatmap(observations: Iterable[TrackObservation], h_image_from_court) -> dict:
    """Occupancy of foot points on the doubles outline, 1 m cells along the court length."""
    positions = court_points(observations, h_image_from_court)
    counts = np.zeros((COURT_HEATMAP_ROWS, COURT_HEATMAP_COLS), dtype=np.int64)
    for x, y in positions.values():
        if 0.0 <= x < 6.10 and 0.0 <= y < 13.40:
            counts[min(int(y / 13.40 * COURT_HEATMAP_ROWS), COURT_HEATMAP_ROWS - 1), min(int(x / 6.10 * COURT_HEATMAP_COLS), COURT_HEATMAP_COLS - 1)] += 1
    peak = int(counts.max())
    normalised = (counts / peak).round(4) if peak > 0 else counts.astype(float)
    return {
        "coordinate_space": "floor-plane metres, rows along the court (13.40 m), cols across it (6.10 m)",
        "cols": COURT_HEATMAP_COLS,
        "rows": COURT_HEATMAP_ROWS,
        "counts": counts.tolist(),
        "normalised": normalised.tolist(),
        "total_observations": int(counts.sum()),
    }
