"""observed-2d/v1: the one sanitized shuttle track that every 2D number in SmashLab is computed from.

The raw TrackNetV3 / InpaintNet output (``shuttle_trajectory.json``) is read and never written. This module decides once,
for every consumer (contact candidates, trajectory-rules, the per-shot dataset, the speed monitor, the dashboard and the
trajectory charts), which shuttle positions are used and why the others are not:

- A point needs a visible position inside the frame. A TrackNet detection also needs ``confidence >= conf_threshold``.
- TrackNet detections ("detected") and InpaintNet fills ("interpolated") stay apart. Only steps between two detections
  give a speed; an interpolated point is never a speed measurement.
- A tracker jump is a short excursion (at most ``max_spike_frames`` points) whose entry step is faster than the
  plausible image speed while the track returns to where it was. Those points are rejected and the reason is kept.
- A fast step that does not return is kept but recorded as an implausible step. It ends the run and is never a speed.
- A run ("segment") continues across at most ``max_missing_frames`` missing frames.
- Speeds use a centred moving average over consecutive frames of one source inside one run (``smoothing_window``,
  never across a gap, a rejected point, a run boundary or a change of source). Geometry and charts use the
  unsmoothed positions.
- The plausible image speed is a number of frame diagonals per second, so the same rule holds at every resolution and
  frame rate.
- Every point keeps its original frame and timestamp. Presentation timestamps are used for durations when the file
  carries them; otherwise durations come from the frame rate.

Units: image pixels and pixels per second. Nothing here is metres, m/s or km/h.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import Mapping, Optional, Sequence

VERSION = "observed-2d/v1"
DETECTED = "detected"
INTERPOLATED = "interpolated"
REJECTION_REASONS = ("missing_coordinates", "outside_frame", "low_confidence", "tracker_jump")
SPEED_METHOD = (
    "Image-space speed: total length of the valid steps between consecutive TrackNet detections within 3 frames of the "
    "contact, divided by their total duration. Pixels per second on the image; not a physical speed."
)
COORDINATE_SPACE = "image position: source image pixels, origin top-left, x to the right, y downwards"


@dataclass(frozen=True)
class Config:
    conf_threshold: float = 0.5           # a TrackNet detection below this confidence is not used
    max_speed_diag_per_s: float = 2.25    # plausible image speed in frame diagonals per second (about 4960 px/s at 1080p)
    max_spike_frames: int = 3             # an excursion of at most this many points that returns is a tracker jump
    max_missing_frames: int = 3           # a run continues across at most this many missing frames
    speed_max_frame_gap: int = 2          # a speed step spans at most this many frames
    smoothing_window: int = 3             # centred moving average for speeds (1 = off); odd
    contact_half_window: int = 3          # frames either side of a contact for its image-space speed
    contact_min_points: int = 4           # TrackNet detections needed in that window
    contact_min_steps: int = 2            # valid steps needed in that window
    constant_run_frames: int = 8          # tracking check: one axis fixed for this many consecutive frames
    constant_tol_diag: float = 0.0005     # "fixed" means within this share of the diagonal (at least 1 px)
    other_axis_range_diag: float = 0.0136  # while the other axis moves at least this share of the diagonal

    def as_dict(self) -> dict:
        return asdict(self)


DEFAULT_CONFIG = Config()


@dataclass(frozen=True)
class ObservedPoint:
    frame: int
    time_s: float
    x: float          # image position as written by TrackNet or InpaintNet
    y: float
    xs: float         # smoothed position, used for speeds only
    ys: float
    confidence: float
    source: str       # "detected" or "interpolated"
    segment: int

    @property
    def interpolated(self) -> bool:
        return self.source == INTERPOLATED


@dataclass(frozen=True)
class RejectedPoint:
    frame: int
    time_s: Optional[float]
    x: Optional[float]
    y: Optional[float]
    confidence: float
    source: str
    reason: str
    detail: dict = field(default_factory=dict)

    def as_record(self) -> dict:
        return {
            "frame": self.frame,
            "time_s": None if self.time_s is None else round(self.time_s, 6),
            "x_px": None if self.x is None else round(self.x, 2),
            "y_px": None if self.y is None else round(self.y, 2),
            "confidence": round(self.confidence, 4),
            "source": self.source,
            "reason": self.reason,
            **({"detail": self.detail} if self.detail else {}),
        }


@dataclass(frozen=True)
class InvalidStep:
    from_frame: int
    to_frame: int
    distance_px: float
    speed_px_s: float
    reason: str = "implausible_step"

    def as_record(self) -> dict:
        return {"from_frame": self.from_frame, "to_frame": self.to_frame, "distance_px": round(self.distance_px, 1),
                "speed_px_s": round(self.speed_px_s, 1), "reason": self.reason}


@dataclass(frozen=True)
class Step:
    from_frame: int
    to_frame: int
    distance_px: float
    duration_s: float
    speed_px_s: float


@dataclass
class ObservedTrack:
    config: Config
    width: int
    height: int
    fps: float
    timestamp_source: str
    points: dict[int, ObservedPoint]
    rejected: list[RejectedPoint]
    invalid_steps: list[InvalidStep]
    times: dict[int, float]
    frames_total: int
    frames_without_position: int
    version: str = VERSION

    @property
    def diagonal(self) -> float:
        return math.hypot(self.width, self.height)

    @property
    def max_speed_px_s(self) -> float:
        return self.config.max_speed_diag_per_s * self.diagonal

    @property
    def last_frame(self) -> Optional[int]:
        return max(self.times) if self.times else (max(self.points) if self.points else None)

    def time_of(self, frame: int) -> float:
        value = self.times.get(frame)
        if value is not None:
            return float(value)
        return frame / self.fps if self.fps > 0 else 0.0

    def duration(self, first: int, second: int) -> float:
        """Seconds from one frame to another: presentation timestamps when the file has them, else the frame rate."""
        if self.timestamp_source == "presentation_timestamp" and first in self.times and second in self.times:
            return float(self.times[second] - self.times[first])
        return (second - first) / self.fps if self.fps > 0 else 0.0

    def window(self, lo: int, hi: int) -> list[ObservedPoint]:
        return [self.points[frame] for frame in range(lo, hi + 1) if frame in self.points]

    def rejected_in(self, lo: int, hi: int) -> list[RejectedPoint]:
        return [item for item in self.rejected if lo <= item.frame <= hi]

    def invalid_steps_in(self, lo: int, hi: int) -> list[InvalidStep]:
        return [item for item in self.invalid_steps if item.to_frame >= lo and item.from_frame <= hi]

    def counts(self, lo: Optional[int] = None, hi: Optional[int] = None) -> dict:
        low = -10**9 if lo is None else lo
        high = 10**9 if hi is None else hi
        kept = [point for frame, point in self.points.items() if low <= frame <= high]
        rejected = [item for item in self.rejected if low <= item.frame <= high]
        by_reason = {reason: 0 for reason in REJECTION_REASONS}
        for item in rejected:
            by_reason[item.reason] = by_reason.get(item.reason, 0) + 1
        return {
            "detected": sum(1 for point in kept if point.source == DETECTED),
            "interpolated": sum(1 for point in kept if point.source == INTERPOLATED),
            "rejected": by_reason,
            "rejected_total": len(rejected),
            "invalid_steps": len([item for item in self.invalid_steps if item.to_frame >= low and item.from_frame <= high]),
        }

    def summary(self) -> dict:
        counts = self.counts()
        return {
            "version": self.version,
            "config": self.config.as_dict(),
            "frame_size": [self.width, self.height],
            "fps": self.fps,
            "timestamp_source": self.timestamp_source,
            "max_speed_px_s": round(self.max_speed_px_s, 1),
            "frames_total": self.frames_total,
            "frames_without_position": self.frames_without_position,
            "detected": counts["detected"],
            "interpolated": counts["interpolated"],
            "rejected": counts["rejected"],
            "rejected_total": counts["rejected_total"],
            "invalid_steps": counts["invalid_steps"],
            "segments": len({point.segment for point in self.points.values()}),
            "coordinate_space": COORDINATE_SPACE,
        }

    def compact(self) -> dict:
        """The sanitized track for charts: points [frame, x, y, "d"|"i", segment], rejected_points [frame, x, y, reason]."""
        return {
            "points": [
                [point.frame, round(point.x, 2), round(point.y, 2), "d" if point.source == DETECTED else "i", point.segment]
                for point in sorted(self.points.values(), key=lambda item: item.frame)
            ],
            "rejected_points": [
                [item.frame, None if item.x is None else round(item.x, 2), None if item.y is None else round(item.y, 2), item.reason]
                for item in self.rejected
            ],
            "invalid_step_list": [item.as_record() for item in self.invalid_steps],
        }


@dataclass(frozen=True)
class _Candidate:
    frame: int
    x: float
    y: float
    confidence: float
    source: str


def _finite(value) -> bool:
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError):
        return False


def sanitize(shuttle_doc: Optional[Mapping], *, width: Optional[int] = None, height: Optional[int] = None,
             fps: Optional[float] = None, config: Config = DEFAULT_CONFIG) -> ObservedTrack:
    """The sanitized track of one analysis. ``shuttle_doc`` is read only; no value in it is changed."""
    doc = shuttle_doc or {}
    frames = [item for item in (doc.get("frames") or []) if isinstance(item, Mapping)]
    frame_width = int(doc.get("source_width") or width or 0)
    frame_height = int(doc.get("source_height") or height or 0)
    rate = float(doc.get("fps") or fps or 30.0)
    timestamp_source = str(doc.get("timestamp_source") or "frame_rate_derived")
    bounds_known = frame_width > 0 and frame_height > 0
    if not bounds_known:
        xs = [float(item["x"]) for item in frames if _finite(item.get("x"))]
        ys = [float(item["y"]) for item in frames if _finite(item.get("y"))]
        frame_width = int(math.ceil(max(xs) + 1)) if xs else 1920
        frame_height = int(math.ceil(max(ys) + 1)) if ys else 1080

    times: dict[int, float] = {}
    candidates: list[_Candidate] = []
    rejected: list[RejectedPoint] = []
    seen: set[int] = set()
    without_position = 0
    for item in sorted(frames, key=lambda value: int(value.get("frame", -1))):
        frame = int(item.get("frame", -1))
        if frame < 0 or frame in seen:
            continue
        seen.add(frame)
        if _finite(item.get("time_s")):
            times[frame] = float(item["time_s"])
        if not item.get("visible"):
            without_position += 1
            continue
        source = INTERPOLATED if item.get("refined") else DETECTED
        confidence = float(item.get("confidence") or 0.0)
        if not _finite(item.get("x")) or not _finite(item.get("y")):
            rejected.append(RejectedPoint(frame, times.get(frame), None, None, confidence, source, "missing_coordinates"))
            continue
        x, y = float(item["x"]), float(item["y"])
        if bounds_known and not (0.0 <= x < frame_width and 0.0 <= y < frame_height):
            rejected.append(RejectedPoint(frame, times.get(frame), x, y, confidence, source, "outside_frame",
                                          {"frame_size": [frame_width, frame_height]}))
            continue
        if source == DETECTED and confidence < config.conf_threshold:
            rejected.append(RejectedPoint(frame, times.get(frame), x, y, confidence, source, "low_confidence",
                                          {"threshold": config.conf_threshold}))
            continue
        candidates.append(_Candidate(frame, x, y, confidence, source))

    diagonal = math.hypot(frame_width, frame_height)
    cap = config.max_speed_diag_per_s * diagonal
    link = config.max_missing_frames + 1

    def seconds(first: int, second: int) -> float:
        if timestamp_source == "presentation_timestamp" and first in times and second in times:
            return float(times[second] - times[first])
        return (second - first) / rate if rate > 0 else 0.0

    def speed(a: _Candidate, b: _Candidate) -> float:
        duration = seconds(a.frame, b.frame)
        if duration <= 0:
            duration = (b.frame - a.frame) / rate if rate > 0 else 0.0
        distance = math.hypot(b.x - a.x, b.y - a.y)
        return distance / duration if duration > 0 else math.inf

    kept: list[_Candidate] = []
    run_starts: set[int] = set()
    invalid_steps: list[InvalidStep] = []
    index = 0
    while index < len(candidates):
        point = candidates[index]
        if not kept:
            kept.append(point)
            run_starts.add(point.frame)
            index += 1
            continue
        previous = kept[-1]
        if point.frame - previous.frame > link:
            kept.append(point)
            run_starts.add(point.frame)
            index += 1
            continue
        if speed(previous, point) <= cap:
            kept.append(point)
            index += 1
            continue
        back = None
        for offset in range(1, config.max_spike_frames + 1):
            if index + offset >= len(candidates):
                break
            later = candidates[index + offset]
            if later.frame - previous.frame > link + config.max_spike_frames:
                break
            if speed(previous, later) <= cap:
                back = offset
                break
        if back is not None:
            returned = candidates[index + back]
            entry = math.hypot(point.x - previous.x, point.y - previous.y)
            for jumped in candidates[index:index + back]:
                rejected.append(RejectedPoint(
                    jumped.frame, times.get(jumped.frame), jumped.x, jumped.y, jumped.confidence, jumped.source, "tracker_jump",
                    {"from_frame": previous.frame, "return_frame": returned.frame, "entry_step_px": round(entry, 1),
                     "entry_speed_px_s": round(speed(previous, point), 1), "limit_px_s": round(cap, 1), "excursion_points": back},
                ))
            index += back
            continue
        invalid_steps.append(InvalidStep(previous.frame, point.frame, math.hypot(point.x - previous.x, point.y - previous.y),
                                         speed(previous, point)))
        kept.append(point)
        run_starts.add(point.frame)
        index += 1

    rejected.sort(key=lambda item: item.frame)
    segments: dict[int, int] = {}
    segment = -1
    for point in kept:
        if point.frame in run_starts:
            segment += 1
        segments[point.frame] = max(segment, 0)
    by_frame = {point.frame: point for point in kept}
    smoothed = _smooth(by_frame, segments, config.smoothing_window)
    points = {
        point.frame: ObservedPoint(
            frame=point.frame,
            time_s=times.get(point.frame, point.frame / rate if rate > 0 else 0.0),
            x=point.x,
            y=point.y,
            xs=smoothed[point.frame][0],
            ys=smoothed[point.frame][1],
            confidence=point.confidence,
            source=point.source,
            segment=segments[point.frame],
        )
        for point in kept
    }
    return ObservedTrack(
        config=config,
        width=frame_width,
        height=frame_height,
        fps=rate,
        timestamp_source=timestamp_source,
        points=points,
        rejected=rejected,
        invalid_steps=invalid_steps,
        times=times,
        frames_total=len(seen),
        frames_without_position=without_position,
    )


def _smooth(by_frame: Mapping[int, _Candidate], segments: Mapping[int, int], window: int) -> dict[int, tuple[float, float]]:
    """Centred mean over consecutive frames of the same source and run; the window shrinks at gaps and run ends."""
    half = max(0, int(window) // 2)
    out: dict[int, tuple[float, float]] = {}
    for frame, point in by_frame.items():
        reach = 0
        for k in range(1, half + 1):
            left, right = by_frame.get(frame - k), by_frame.get(frame + k)
            if (left is None or right is None or left.source != point.source or right.source != point.source
                    or segments.get(frame - k) != segments[frame] or segments.get(frame + k) != segments[frame]):
                break
            reach = k
        group = [by_frame[frame + k] for k in range(-reach, reach + 1)]
        out[frame] = (sum(item.x for item in group) / len(group), sum(item.y for item in group) / len(group))
    return out


def steps(track: ObservedTrack, points: Sequence[ObservedPoint]) -> list[Step]:
    """Valid speed steps: consecutive TrackNet detections of one run, at most speed_max_frame_gap frames apart."""
    unique = {point.frame: point for point in points if point is not None}
    detected = [unique[frame] for frame in sorted(unique) if unique[frame].source == DETECTED]
    out: list[Step] = []
    for a, b in zip(detected, detected[1:]):
        gap = b.frame - a.frame
        if a.segment != b.segment or gap <= 0 or gap > track.config.speed_max_frame_gap:
            continue
        duration = track.duration(a.frame, b.frame)
        if duration <= 0:
            continue
        distance = math.hypot(b.xs - a.xs, b.ys - a.ys)
        out.append(Step(a.frame, b.frame, distance, duration, distance / duration))
    return out


def _percentile(values: Sequence[float], q: float) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    k = (len(ordered) - 1) * q / 100.0
    lo, hi = math.floor(k), math.ceil(k)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (k - lo)


def speed_reference(track: ObservedTrack) -> Optional[float]:
    """95th percentile of all valid step speeds of the video: the reference for relative speeds."""
    return _percentile([step.speed_px_s for step in steps(track, list(track.points.values()))], 95)


def image_speed_around(track: ObservedTrack, frame: int) -> dict:
    """Image-space speed around one contact, from valid steps only. Never metres, m/s or km/h."""
    config = track.config
    half = config.contact_half_window
    window = [point for point in track.window(frame - half, frame + half) if point.source == DETECTED]
    used = steps(track, window)
    base = {"kmh": None, "unit": "px/s", "method": SPEED_METHOD, "physical_speed_available": False,
            "points": len(window), "steps": len(used)}
    if len(window) < config.contact_min_points or len(used) < config.contact_min_steps:
        return {**base, "px_per_s": None, "kind": None, "frames": [],
                "reason": (f"Only {len(window)} TrackNet detections and {len(used)} valid steps lie within {half} frames of "
                           f"the contact; {config.contact_min_points} detections and {config.contact_min_steps} steps are needed.")}
    distance = sum(step.distance_px for step in used)
    duration = sum(step.duration_s for step in used)
    frames = sorted({step.from_frame for step in used} | {step.to_frame for step in used})
    return {**base, "px_per_s": round(distance / duration, 1), "kind": "image_space", "frames": frames, "reason": None}


def contact_point(track: ObservedTrack, frame: int) -> Optional[ObservedPoint]:
    """The point at the contact frame, else the first kept point of frame-2, -1, +1, +2."""
    point = track.points.get(frame)
    if point is not None:
        return point
    for other in (frame - 2, frame - 1, frame + 1, frame + 2):
        if other in track.points:
            return track.points[other]
    return None


def tracking_checks(track: ObservedTrack, lo: int, hi: int) -> list[dict]:
    """Checks to make on the video between two frames. Each one says which points are TrackNet and which InpaintNet.

    Nothing is corrected here: a shuttle that falls straight down also keeps one axis fixed.
    """
    config = track.config
    reach = config.constant_run_frames
    points = track.window(lo - reach, hi + reach)
    tolerance = max(1.0, config.constant_tol_diag * track.diagonal)
    other_minimum = config.other_axis_range_diag * track.diagonal
    checks: list[dict] = []

    def sources(group: Sequence[ObservedPoint]) -> dict:
        return {"detected": sum(1 for point in group if point.source == DETECTED),
                "interpolated": sum(1 for point in group if point.source == INTERPOLATED)}

    for a, b in zip(points, points[1:]):
        if b.frame == a.frame + 1 and a.x == b.x and a.y == b.y:
            if a.source == DETECTED and b.source == DETECTED:
                kind = "repeated_detection"
            elif a.source == INTERPOLATED and b.source == INTERPOLATED:
                kind = "repeated_interpolation"
            else:
                kind = "repeated_mixed"
            checks.append({"kind": kind, "from": a.frame, "to": b.frame, "x": round(b.x, 2), "y": round(b.y, 2), **sources((a, b))})

    for axis, other in (("x", "y"), ("y", "x")):
        run: list[ObservedPoint] = []

        def flush(group: list[ObservedPoint]) -> None:
            if len(group) < config.constant_run_frames:
                return
            values = [getattr(point, other) for point in group]
            spread = max(values) - min(values)
            if spread < other_minimum:
                return
            checks.append({"kind": f"constant_{axis}", "from": group[0].frame, "to": group[-1].frame, "length": len(group),
                           "value": round(getattr(group[0], axis), 2), "other_range_px": round(spread, 1), **sources(group)})

        for point in points:
            if run and point.frame == run[-1].frame + 1 and abs(getattr(point, axis) - getattr(run[-1], axis)) <= tolerance:
                run.append(point)
            else:
                flush(run)
                run = [point]
        flush(run)

    jumps = [item for item in track.rejected_in(lo - reach, hi + reach) if item.reason == "tracker_jump"]
    group: list[RejectedPoint] = []
    for item in jumps + [None]:
        if item is not None and group and item.frame == group[-1].frame + 1:
            group.append(item)
            continue
        if group:
            detail = group[0].detail
            checks.append({
                "kind": "tracker_jump_removed", "from": group[0].frame, "to": group[-1].frame, "length": len(group),
                "from_frame": detail.get("from_frame"), "return_frame": detail.get("return_frame"),
                "entry_step_px": detail.get("entry_step_px"), "limit_px_s": detail.get("limit_px_s"),
                "detected": sum(1 for value in group if value.source == DETECTED),
                "interpolated": sum(1 for value in group if value.source == INTERPOLATED),
            })
        group = [item] if item is not None else []

    for step in track.invalid_steps_in(lo - reach, hi + reach):
        checks.append({"kind": "implausible_step", "from": step.from_frame, "to": step.to_frame,
                       "distance_px": round(step.distance_px, 1), "speed_px_s": round(step.speed_px_s, 1),
                       "limit_px_s": round(track.max_speed_px_s, 1)})

    return sorted((check for check in checks if check["to"] >= lo and check["from"] <= hi),
                  key=lambda check: (check["from"], check["kind"]))


def point_record(point: ObservedPoint) -> dict:
    return {
        "frame": point.frame,
        "time_s": round(point.time_s, 6),
        "x_px": round(point.x, 2),
        "y_px": round(point.y, 2),
        "confidence": round(point.confidence, 4),
        "source": point.source,
        "interpolated": point.interpolated,
        "segment": point.segment,
    }
