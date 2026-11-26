"""Synthetic trajectory fixtures for the six classes, partial and fallback cases.

Deterministic: no random numbers, no clocks. A fixture is a shuttle file plus a court-context player position, built from
constant or piecewise-constant image velocities. They test the algorithm only. They are not evidence for real footage
and must never be mixed into a video result.
"""

from __future__ import annotations

FPS = 30.0
WIDTH = 1920
HEIGHT = 1080
CONTACT = 60
SPEED_REF = 1500.0  # fixed reference for the tests, standing in for the video's p95 speed

# Player foot positions in metres on the floor plane (court origin at the far edge; net at 6.7 m).
BACK_COURT_NEAR_PLAYER = 12.0   # 5.3 m from the net
FRONT_COURT_NEAR_PLAYER = 7.5   # 0.8 m from the net
MID_COURT_NEAR_PLAYER = 9.5     # 2.8 m from the net


def _segments(start: tuple[float, float], segments: list[tuple[float, float, float, float]], fps: float = FPS):
    """Points per frame for piecewise-constant velocity. segments: (duration_s, vx_px_s, vy_px_s, visible_fraction)."""
    x, y = start
    points = {}
    frame = CONTACT
    points[frame] = (x, y)
    for duration, vx, vy, visible in segments:
        steps = int(round(duration * fps))
        for _ in range(steps):
            frame += 1
            x += vx / fps
            y += vy / fps
            points[frame] = (x, y, visible)
    return points


def _shuttle_doc(points: dict[int, tuple], *, drop_every: int = 0, interpolate_every: int = 0, confidence: float = 0.85) -> dict:
    """A shuttle file with the same structure as outputs/<job>/shuttle_trajectory.json."""
    frames = []
    for frame in range(0, CONTACT + 80):
        item = {"frame": frame, "time_s": round(frame / FPS, 3), "x": None, "y": None, "visible": False,
                "confidence": 0.0, "refined": False}
        if frame in points:
            value = points[frame]
            x, y = value[0], value[1]
            visible_fraction = value[2] if len(value) > 2 else 1.0
            keep = visible_fraction >= 1.0
            if drop_every and frame % drop_every == 0 and frame != CONTACT:
                keep = False
            if keep:
                item.update(x=round(x, 2), y=round(y, 2), visible=True, confidence=confidence)
                if interpolate_every and frame % interpolate_every == 0 and frame != CONTACT:
                    item["refined"] = True
        frames.append(item)
    return {"schema": "smashlab.local-ai.results/v1", "fps": FPS, "source_width": WIDTH, "source_height": HEIGHT, "frames": frames}


def _contact_start(x: float = 960.0, y: float = 520.0) -> tuple[float, float]:
    return (x, y)


# Each stroke: the shuttle moves away from the contact with the velocity pattern its class is known for.
STROKES: dict[str, dict] = {
    # Fast, steep downward, short and straight: the shuttle ends at the floor within half a second. The contact starts
    # higher in the image so that the whole flight stays inside the 1920 x 1080 frame (the sanitizer rejects points
    # outside the image, as TrackNet never produces them).
    "smash": {"segments": [(0.45, 700.0, 1400.0, 1.0)], "player_y": BACK_COURT_NEAR_PLAYER, "start": (960.0, 400.0)},
    # Rises clearly to a high apex, then falls slowly: long flight, deep.
    "clear": {"segments": [(0.6, 350.0, -400.0, 1.0), (0.9, 350.0, 250.0, 1.0)], "player_y": BACK_COURT_NEAR_PLAYER},
    # Decelerates sharply after the contact and drops short near the net. Fast in before window is set by before_segments.
    "drop": {"segments": [(0.2, 380.0, 120.0, 1.0), (0.5, 60.0, 260.0, 1.0)], "player_y": FRONT_COURT_NEAR_PLAYER,
             "before": (0.4, -900.0, 0.0)},
    # Nearly horizontal, fast, almost no height change.
    "drive": {"segments": [(0.5, 1100.0, 20.0, 1.0)], "player_y": BACK_COURT_NEAR_PLAYER},
    # Slow, short, very little rise, ends at the net.
    "net_shot": {"segments": [(0.2, 180.0, -40.0, 1.0), (0.4, 120.0, 40.0, 1.0)], "player_y": FRONT_COURT_NEAR_PLAYER},
    # From near the net, rises strongly and goes towards the back of the court.
    "lift": {"segments": [(1.0, 150.0, -500.0, 1.0), (0.5, 150.0, -40.0, 1.0)], "player_y": FRONT_COURT_NEAR_PLAYER},
}


DEFAULT_BEFORE = (0.5, -200.0, -150.0)  # the incoming shuttle moves towards the player at a moderate speed


def stroke_points(label: str) -> dict[int, tuple]:
    spec = STROKES[label]
    before = spec.get("before", DEFAULT_BEFORE)
    start = spec.get("start", _contact_start())
    points = {}
    if before:
        duration, vx, vy = before
        steps = int(round(duration * FPS))
        x, y = start
        x0, y0 = x - vx * duration, y - vy * duration
        for index in range(steps + 1):
            frame = CONTACT - steps + index
            points[frame] = (x0 + vx * index / FPS, y0 + vy * index / FPS, 1.0)
    points.update(_segments(start, spec["segments"]))
    return points


def stroke_shuttle(label: str, **kwargs) -> dict:
    return _shuttle_doc(stroke_points(label), **kwargs)


def player_context(label: str) -> tuple[float, float]:
    """A foot position on the floor plane for the player who hit the stroke (court calibrated)."""
    return (3.0, STROKES[label]["player_y"])


def partial_shuttle() -> dict:
    """Only a short post-contact stretch survives: some features are computable, the full window is not."""
    points = {}
    x, y = _contact_start()
    points[CONTACT] = (x, y, 1.0)
    for index in range(1, 8):
        points[CONTACT + index] = (x + 180.0 * index / FPS, y - 260.0 * index / FPS, 1.0)
    return _shuttle_doc(points)


def fallback_shuttle() -> dict:
    """Almost no data: a few points within a small window around the contact, but enough for the fallback tier."""
    points = {}
    x, y = _contact_start()
    points[CONTACT - 3] = (x - 140.0 / FPS * 3, y + 90.0 / FPS * 3, 1.0)
    points[CONTACT] = (x, y, 1.0)
    points[CONTACT + 2] = (x + 300.0 / FPS * 2, y - 200.0 / FPS * 2, 1.0)
    return _shuttle_doc(points)


def empty_shuttle() -> dict:
    """No shuttle data at all near the contact: must be reported as a pipeline integrity error."""
    return _shuttle_doc({})
