"""Derived analysis: court filter, tracking, logical identities, rally candidates and the annotated video.

It runs in one decoding pass over the job video and reads only the raw inference outputs and the corrections
file. Raw outputs are never edited, so the whole derivation can be repeated after a correction.

Rally segmentation here is a labelled heuristic (runs of detected shuttle frames separated by short gaps). It is
not validated against ground truth. Shot classification is not implemented, so the shots section is "unsupported".
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from typing import Callable, Iterable, Optional

import cv2
import numpy as np

from app.ai.analytics.movement import compute_player_movements, court_heatmap, court_player_movements, foot_heatmap, shuttle_summary
from app.ai.court_detection.court import COURT_LENGTH_M, COURT_WIDTH_M, NET_Y_M
from app.ai.player_detection.bytetrack import ByteTracker
from app.ai.player_detection.identity import Candidate, IdentityConfig, IdentityManager, IdentityState
from app.ai.player_detection.tracker import TrackObservation
from app.services import corrections as corrections_service

COURT_MARGIN_SIDE_M = 2.0
COURT_MARGIN_END_M = 3.0
MIN_HEIGHT_RATIO = 0.06
HIGH_SCORE = 0.5
RALLY_GAP_S = 1.0
RALLY_MIN_S = 1.0
MOVEMENT_MIN_FRAMES = 15
TEMPLATE_CORNERS_M = np.array(
    [[0.0, 0.0], [COURT_WIDTH_M, 0.0], [COURT_WIDTH_M, COURT_LENGTH_M], [0.0, COURT_LENGTH_M]], dtype=np.float32
)
DERIVATION_VERSION = "0.2.0"


@dataclass
class CourtInfo:
    calibrated: bool
    status: str
    source: str  # auto | manual | none
    reason: str
    homography_image_from_court: Optional[np.ndarray] = None
    quad_image: Optional[list] = None
    template: str = ""

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "source": self.source,
            "reason": self.reason,
            "template": self.template,
            "homography_image_from_court": None if self.homography_image_from_court is None else self.homography_image_from_court.tolist(),
            "quad_image_px": self.quad_image,
        }


def court_from_auto(payload: dict) -> CourtInfo:
    if payload.get("status") == "calibrated" and payload.get("homography_image_from_court"):
        return CourtInfo(True, "calibrated", "auto", payload.get("reason", ""),
                         np.asarray(payload["homography_image_from_court"], dtype=np.float64),
                         payload.get("quad_image_px"), payload.get("template", ""))
    return CourtInfo(False, payload.get("status", "failed"), "auto", payload.get("reason", "automatic calibration failed"))


def court_from_manual(corners_px: list) -> CourtInfo:
    image = np.asarray(corners_px, dtype=np.float32)
    homography = cv2.getPerspectiveTransform(TEMPLATE_CORNERS_M, image).astype(np.float64)
    return CourtInfo(True, "calibrated", "manual", "four corners provided by the user", homography,
                     [[float(x), float(y)] for x, y in corners_px], "doubles 13.40 m x 6.10 m")


def _court_outline_px(court: CourtInfo) -> Optional[list[tuple[int, int]]]:
    if not court.calibrated:
        return None
    outline = np.array([[0, 0], [COURT_WIDTH_M, 0], [COURT_WIDTH_M, COURT_LENGTH_M], [0, COURT_LENGTH_M],
                        [0, NET_Y_M], [COURT_WIDTH_M, NET_Y_M]], dtype=np.float64)
    homogeneous = np.hstack([outline, np.ones((len(outline), 1))]) @ court.homography_image_from_court.T
    points = homogeneous[:, :2] / homogeneous[:, 2:3]
    return [(int(round(x)), int(round(y))) for x, y in points]


def appearance_histogram(frame_bgr: np.ndarray, box: tuple[float, float, float, float]) -> Optional[np.ndarray]:
    """Hue-saturation histogram of the upper body. Body colour only, not facial features."""
    height, width = frame_bgr.shape[:2]
    x1, y1, x2, y2 = (int(max(0, round(v))) for v in box)
    x2, y2 = min(x2, width), min(y2, height)
    box_height = y2 - y1
    if x2 - x1 < 4 or box_height < 8:
        return None
    top = y1 + int(0.15 * box_height)
    bottom = y1 + int(0.55 * box_height)
    crop = frame_bgr[top:bottom, x1:x2]
    if crop.size == 0:
        return None
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1], None, [16, 4], [0, 180, 0, 256]).flatten().astype(np.float64)
    total = hist.sum()
    return hist / total if total > 0 else None


def choose_mode(detections: dict[int, np.ndarray], court: CourtInfo, width: int, height: int) -> str:
    """Doubles when at least three high-score people stand on the court for most of the clip (90th percentile)."""
    counts = []
    for boxes in detections.values():
        kept = [b for b in boxes if b[4] >= HIGH_SCORE and _passes_filter(b, court, height)]
        counts.append(len(kept))
    if not counts:
        return "singles"
    return "doubles" if float(np.percentile(counts, 90)) >= 3 else "singles"


def resolve_mode(entries: list[dict], requested: str, detections: dict[int, np.ndarray], court: CourtInfo, width: int, height: int) -> str:
    """A 'mode' correction overrides the requested mode; 'auto' is decided from the detections."""
    override = corrections_service.latest(entries, "mode")
    chosen = override["mode"] if override else requested
    return choose_mode(detections, court, width, height) if chosen == "auto" else chosen


def _passes_filter(box: np.ndarray, court: CourtInfo, height: int, h_court_from_image: Optional[np.ndarray] = None) -> bool:
    if court.calibrated:
        if h_court_from_image is None:
            h_court_from_image = np.linalg.inv(court.homography_image_from_court)
        foot = np.array([(box[0] + box[2]) / 2.0, box[3], 1.0])
        mapped = h_court_from_image @ foot
        if abs(mapped[2]) < 1e-9:
            return False
        x, y = mapped[0] / mapped[2], mapped[1] / mapped[2]
        return (-COURT_MARGIN_SIDE_M <= x <= COURT_WIDTH_M + COURT_MARGIN_SIDE_M
                and -COURT_MARGIN_END_M <= y <= COURT_LENGTH_M + COURT_MARGIN_END_M)
    return (box[3] - box[1]) >= MIN_HEIGHT_RATIO * height


def rally_candidates(shuttle, fps: float) -> list[dict]:
    """Heuristic rally candidates: runs of detected (not interpolated) shuttle frames with short gaps."""
    detected = [s.frame for s in shuttle if s.visible and not s.refined]
    if not detected or not fps:
        return []
    gap_frames = RALLY_GAP_S * fps
    runs: list[list[int]] = [[detected[0]]]
    for frame in detected[1:]:
        if frame - runs[-1][-1] <= gap_frames:
            runs[-1].append(frame)
        else:
            runs.append([frame])
    rallies = []
    for run in runs:
        duration = (run[-1] - run[0]) / fps
        if duration < RALLY_MIN_S:
            continue
        rallies.append({
            "index": len(rallies) + 1,
            "start_frame": run[0],
            "end_frame": run[-1],
            "start_s": round(run[0] / fps, 3),
            "end_s": round(run[-1] / fps, 3),
            "duration_s": round(duration, 3),
            "detected_shuttle_frames": len(run),
            "status": "candidate",
            "validated": False,
            "method": f"heuristic: detected shuttle frames separated by gaps of at most {RALLY_GAP_S} s, minimum {RALLY_MIN_S} s",
            "ground_truth": None,
            "evaluation": "not evaluated (no ground truth)",
        })
    return rallies


def identity_segments(states_by_frame: list[tuple[int, list[IdentityState]]]) -> dict[str, list[dict]]:
    segments: dict[str, list[dict]] = {}
    for frame, states in states_by_frame:
        for state in states:
            runs = segments.setdefault(state.identity, [])
            if runs and runs[-1]["status"] == state.status and runs[-1]["end_frame"] == frame - 1:
                runs[-1]["end_frame"] = frame
            else:
                runs.append({"status": state.status, "start_frame": frame, "end_frame": frame})
    return segments


@dataclass
class DeriveConfig:
    mode: str = "auto"
    render: bool = True
    tracker_kwargs: dict = field(default_factory=dict)


@dataclass
class DeriveOutput:
    mode: str
    players: int
    court: CourtInfo
    track_records: list[dict]
    identity_states: list[tuple[int, list[IdentityState]]]
    identity_events: list
    identity_segments: dict
    movement_observations: list[TrackObservation]
    rallies: list[dict]
    shuttle_stats: dict
    frames_processed: int
    corrections_applied: int
    tracks_total: int
    tracks_confirmed: int
    max_concurrent_identities: int
    identity_gate: float = 0.0


def derive(
    *,
    fps: float,
    width: int,
    height: int,
    total_frames: int,
    detections: dict[int, np.ndarray],
    shuttle: list,
    court: CourtInfo,
    corrections_doc: dict,
    config: DeriveConfig,
    frames: Optional[Iterable[tuple[int, np.ndarray]]] = None,
    render: Optional[Callable[[int, np.ndarray, list[dict], Optional[object], list, Optional[list]], np.ndarray]] = None,
    writer=None,
) -> DeriveOutput:
    """Run the derivation. ``frames`` yields (index, BGR image) for appearance features and rendering."""
    entries = corrections_doc.get("entries", [])
    forced_by_frame = corrections_service.forced_identities(entries)
    mode = resolve_mode(entries, config.mode, detections, court, width, height)
    players = 4 if mode == "doubles" else 2
    h_court_from_image = np.linalg.inv(court.homography_image_from_court) if court.calibrated else None

    identity_gate = 2.0 if court.calibrated else 0.15  # metres when calibrated, else fraction of the frame diagonal
    identity_manager = IdentityManager(IdentityConfig(
        players=players,
        gate=identity_gate,  # 2 m: foot points jitter by about 1 m between frames (host run, sample A)
        net_y=NET_Y_M if court.calibrated else None,
    ))
    tracker = ByteTracker(**config.tracker_kwargs)
    diagonal = math.hypot(width, height)
    shuttle_by_frame = {s.frame: s for s in shuttle}
    trail: deque = deque(maxlen=8)
    last_visible = -(10 ** 9)
    track_records: dict[int, dict] = {}
    identity_states: list[tuple[int, list[IdentityState]]] = []
    movement_observations: list[TrackObservation] = []
    frames_processed = 0
    corrections_applied = sum(len(v) for v in forced_by_frame.values())
    max_concurrent = 0
    outline = _court_outline_px(court)

    frame_iterable = frames if frames is not None else ((index, None) for index in range(total_frames))
    for index, image in frame_iterable:
        raw = detections.get(index)
        if raw is None or len(raw) == 0:
            boxes = np.zeros((0, 5))
        else:
            keep = [row for row in np.asarray(raw, dtype=np.float64) if _passes_filter(row, court, height, h_court_from_image)]
            boxes = np.asarray(keep, dtype=np.float64).reshape(-1, 5)
        tracked = tracker.update(index, boxes)
        candidates: list[Candidate] = []
        for item in tracked:
            box = (item.x1, item.y1, item.x2, item.y2)
            foot = np.array([(item.x1 + item.x2) / 2.0, item.y2, 1.0])
            if court.calibrated:
                mapped = h_court_from_image @ foot
                position = (float(mapped[0] / mapped[2]), float(mapped[1] / mapped[2]))
            else:
                position = (float(foot[0] / diagonal), float(foot[1] / diagonal))
            appearance = appearance_histogram(image, box) if image is not None else None
            candidates.append(Candidate(index, item.track_id, box, item.score, item.confirmed, position, appearance))
            record = track_records.setdefault(item.track_id, {"track_id": item.track_id, "confirmed": False, "observations": []})
            record["confirmed"] = record["confirmed"] or item.confirmed
            record["observations"].append({
                "frame": index,
                "time_s": round(index / fps, 3) if fps else None,
                "x1": round(item.x1, 1), "y1": round(item.y1, 1), "x2": round(item.x2, 1), "y2": round(item.y2, 1),
                "score": round(item.score, 4),
                "confirmed": item.confirmed,
            })

        states = identity_manager.step(index, candidates, forced_by_frame.get(index))
        identity_states.append((index, states))
        active = [s for s in states if s.box is not None and s.status in ("matched", "recovered", "manual")]
        max_concurrent = max(max_concurrent, len(active))
        for state in active:
            number = int(state.identity[1:])
            movement_observations.append(TrackObservation(index, number, *state.box, float(state.score or 0.0), True))
        frames_processed = index + 1
        if config.render and render is not None and image is not None and writer is not None:
            shuttle_sample = shuttle_by_frame.get(index)
            if shuttle_sample is not None and shuttle_sample.visible:
                trail.append((shuttle_sample.x, shuttle_sample.y))
                last_visible = index
            if index - last_visible > 3:
                trail.clear()
            drawn_players = [
                {"identity": s.identity, "status": s.status, "box": s.box, "track_id": s.track_id,
                 "confidence": s.confidence, "score": s.score}
                for s in states if s.box is not None or s.status == "uncertain"
            ]
            writer.write(render(index, image, drawn_players, shuttle_sample, list(trail), outline))

    tracks_list = [track_records[k] for k in sorted(track_records)]
    shuttle_stats = shuttle_summary(shuttle, fps, width, height)
    return DeriveOutput(
        mode=mode,
        players=players,
        court=court,
        track_records=tracks_list,
        identity_states=identity_states,
        identity_events=identity_manager.events,
        identity_segments=identity_segments(identity_states),
        movement_observations=movement_observations,
        rallies=rally_candidates(shuttle, fps),
        shuttle_stats=shuttle_stats,
        frames_processed=frames_processed,
        corrections_applied=corrections_applied,
        tracks_total=len(track_records),
        tracks_confirmed=sum(1 for r in track_records.values() if r["confirmed"]),
        max_concurrent_identities=max_concurrent,
        identity_gate=identity_gate,
    )


def movement_payload(output: DeriveOutput, fps: float, width: int, height: int, total_frames: int, court: CourtInfo) -> dict:
    movements = compute_player_movements(output.movement_observations, fps, width, height, total_frames,
                                         min_observed_frames=MOVEMENT_MIN_FRAMES)
    heatmap = foot_heatmap(output.movement_observations, width, height)
    payload = {
        "units": "normalised image units (pixel distance divided by image diagonal); not metres",
        "per_player": [m.as_dict() for m in movements],
        "heatmap": heatmap,
    }
    if court.calibrated:
        h = court.homography_image_from_court
        payload["court_plane"] = {
            "units": "approximate metres on the floor plane (flat-floor assumption); reported only because calibration succeeded",
            "per_player": court_player_movements(output.movement_observations, h, fps, total_frames, min_observed_frames=MOVEMENT_MIN_FRAMES) or [],
            "heatmap": court_heatmap(output.movement_observations, h),
        }
    return payload
