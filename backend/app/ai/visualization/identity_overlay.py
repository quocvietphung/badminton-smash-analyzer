"""Annotated frame for the evidence video: identity boxes, court outline, golden shuttle trail and a header.

The shuttle trail is drawn as a glowing gold polyline (the "golden trajectory"). Header text is ASCII only,
because OpenCV's built-in fonts cannot draw accented characters. Boxes are drawn only for identities with a
position in this frame; uncertain identities have no box and are shown in the header.
"""

from __future__ import annotations

from typing import Optional, Sequence

import cv2
import numpy as np

IDENTITY_COLOURS = {
    "P1": (255, 140, 0),
    "P2": (0, 215, 255),
    "P3": (80, 220, 80),
    "P4": (255, 80, 255),
}
GOLD = (0, 200, 255)
UNTRACKED = (160, 160, 160)
COURT_LINE = (200, 255, 200)


def _glow_polyline(canvas: np.ndarray, points: Sequence[tuple[float, float]]) -> None:
    if len(points) < 2:
        return
    pts = np.array([(int(round(x)), int(round(y))) for x, y in points], dtype=np.int32)
    for thickness, alpha in ((12, 0.22), (6, 0.45)):
        layer = canvas.copy()
        cv2.polylines(layer, [pts], False, GOLD, thickness=thickness, lineType=cv2.LINE_AA)
        cv2.addWeighted(layer, alpha, canvas, 1.0 - alpha, 0, dst=canvas)
    cv2.polylines(canvas, [pts], False, (255, 255, 255), 2, cv2.LINE_AA)


def draw_identity_frame(
    image: np.ndarray,
    players: list[dict],
    shuttle,
    trail: list,
    outline: Optional[list[tuple[int, int]]],
    header: str,
) -> np.ndarray:
    canvas = image.copy()
    if outline and len(outline) >= 4:
        cv2.polylines(canvas, [np.array(outline[:4], dtype=np.int32)], True, COURT_LINE, 1, cv2.LINE_AA)
    if outline and len(outline) >= 6:
        cv2.line(canvas, outline[4], outline[5], COURT_LINE, 1, cv2.LINE_AA)

    for player in players:
        if player.get("box") is None:
            continue
        x1, y1, x2, y2 = (int(round(v)) for v in player["box"])
        colour = IDENTITY_COLOURS.get(player.get("identity") or "", UNTRACKED)
        thickness = 2 if player.get("status") in ("matched", "manual") else 1
        cv2.rectangle(canvas, (x1, y1), (x2, y2), colour, thickness, cv2.LINE_AA)
        confidence = player.get("confidence") or 0.0
        label = f"{player.get('identity') or 'track'} {player.get('status', '')} {confidence:.2f}"
        cv2.putText(canvas, label, (x1, max(14, y1 - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, colour, 1, cv2.LINE_AA)

    _glow_polyline(canvas, trail)
    if shuttle is not None and getattr(shuttle, "visible", False):
        cv2.circle(canvas, (int(round(shuttle.x)), int(round(shuttle.y))), 6, GOLD, -1, cv2.LINE_AA)
        cv2.circle(canvas, (int(round(shuttle.x)), int(round(shuttle.y))), 9, (255, 255, 255), 1, cv2.LINE_AA)

    cv2.rectangle(canvas, (0, 0), (canvas.shape[1], 30), (0, 0, 0), -1)
    cv2.putText(canvas, header, (10, 21), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)
    return canvas
