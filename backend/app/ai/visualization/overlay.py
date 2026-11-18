"""Frame overlays for the annotated MP4.

Labels are ASCII and state the measurement scope: boxes are person detections, the shuttle
marker is a detection in image coordinates. Nothing here shows racket contact or shuttle flight.
"""

from __future__ import annotations

from collections import deque
from typing import Deque, Optional, Sequence

import cv2
import numpy as np

from app.ai.player_detection.tracker import TrackObservation
from app.ai.shuttle_tracking.tracknet import TrackNetFrame

PALETTE_BGR = [
    (255, 140, 0),
    (0, 200, 255),
    (90, 220, 90),
    (255, 90, 255),
    (255, 255, 0),
    (60, 120, 255),
]
SHUTTLE_BGR = (0, 255, 255)
REFINED_BGR = (0, 140, 255)
HEADER = "SmashLab local AI - detections in image coordinates (not racket or shuttle-flight measurement)"


def _scale(height: int) -> tuple[int, float]:
    thickness = max(2, round(height / 360))
    font_scale = max(0.5, height / 900)
    return thickness, font_scale


def draw_frame(
    frame_bgr: np.ndarray,
    frame_index: int,
    total_frames: int,
    players: Sequence[TrackObservation],
    shuttle: Optional[TrackNetFrame],
    trail: Deque[tuple[int, int]],
) -> np.ndarray:
    out = frame_bgr.copy()
    height = out.shape[0]
    thickness, font_scale = _scale(height)

    for obs in players:
        colour = PALETTE_BGR[obs.track_id % len(PALETTE_BGR)]
        p1 = (int(obs.x1), int(obs.y1))
        p2 = (int(obs.x2), int(obs.y2))
        cv2.rectangle(out, p1, p2, colour, thickness if obs.confirmed else max(1, thickness - 1))
        label = f"P{obs.track_id}" if obs.confirmed else f"P{obs.track_id}?"
        cv2.putText(out, label, (p1[0], max(12, p1[1] - 6)), cv2.FONT_HERSHEY_SIMPLEX, font_scale, colour, thickness, cv2.LINE_AA)
        cv2.circle(out, (int(obs.foot_x), int(obs.foot_y)), max(2, thickness), colour, -1, cv2.LINE_AA)

    points = list(trail)
    for age, point in enumerate(points):
        radius = max(2, thickness + 1 - (len(points) - age - 1) // 3)
        cv2.circle(out, point, radius, SHUTTLE_BGR, -1, cv2.LINE_AA)

    if shuttle is not None and shuttle.visible:
        colour = REFINED_BGR if shuttle.refined else SHUTTLE_BGR
        cv2.circle(out, (shuttle.x, shuttle.y), max(5, thickness * 2), colour, thickness, cv2.LINE_AA)

    banner = f"{HEADER}   frame {frame_index + 1}/{total_frames}"
    (text_w, text_h), baseline = cv2.getTextSize(banner, cv2.FONT_HERSHEY_SIMPLEX, font_scale * 0.6, 1)
    cv2.rectangle(out, (0, 0), (text_w + 16, text_h + baseline + 10), (0, 0, 0), -1)
    cv2.putText(out, banner, (8, text_h + 5), cv2.FONT_HERSHEY_SIMPLEX, font_scale * 0.6, (235, 235, 235), 1, cv2.LINE_AA)
    return out


def new_trail(maxlen: int = 8) -> Deque[tuple[int, int]]:
    return deque(maxlen=maxlen)
