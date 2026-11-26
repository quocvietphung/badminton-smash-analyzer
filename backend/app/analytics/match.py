"""Match intelligence derived from the saved outputs of one analysis.

The inputs are files the pipeline already wrote: the shuttle trajectory and the player tracks (image pixels, logical
identities P1 to P4, and floor-plane metres when the court is calibrated), the rally candidates, the court
calibration, the metrics and the manual corrections. No model runs here, and nothing is written back.

Rules that keep the numbers honest:
- Every shuttle number comes from the shared observed-2d/v1 track (app/analytics/observed2d.py): tracker jumps are
  removed there with their reasons, TrackNet detections and InpaintNet fills stay apart, and speeds use valid steps only.
- A contact is a candidate: a sharp turn of the detected shuttle close to a tracked player. A turn alone does not
  prove racket contact, so a candidate stays unconfirmed until a person confirms it.
- Shot types are either a person's six-class label or the trajectory-rules/v2 estimate (labelled "Trajectory estimate ·
  unverified") from the per-shot dataset of this analysis. A person's label always wins. A person's note outside the six
  classes ("unknown" or a legacy label) is kept as a note and never becomes a stroke type.
- Shuttle motion is reported only as image-space speed in pixels per second. It is not physical shuttle speed. One camera
  does not observe the shuttle's height, so projecting an airborne shuttle onto the floor plane would misstate km/h.
- Official speed statistics use confirmed contacts only; automatic candidates are reported apart.
- Court positions come from floor-plane metres of the players' feet, which exist only for a calibrated court.
- Three tiers stay apart: Observed 2D (this document), Estimated 3D (monocular, experimental, gated) and Measured 3D
  (stereo; not run without a synchronised second camera).
"""

from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass
from typing import Callable, Optional

from app.analytics import observed2d as O
from app.analytics.rallies import derive_rallies, merge_with_human_boundaries, summarise as summarise_rallies
from app.physics import stereo
from app.physics.speed3d import estimate_monocular, LABEL as ESTIMATED_3D_LABEL, UNAVAILABLE_LABEL as ESTIMATED_3D_UNAVAILABLE

SCHEMA = "smashlab.match/v1"
COURT = {"length_m": 13.40, "doubles_width_m": 6.10, "singles_width_m": 5.18}
SHOT_TYPES = ("smash", "clear", "drop", "drive", "net_shot", "lift", "unknown")
SIX_CLASSES = SHOT_TYPES[:6]
# Labels from before the taxonomy was narrowed. They are kept in corrections.json for traceability, but the product
# shows them as Unknown and never exports them as a stroke type.
LEGACY_SHOT_TYPES = ("push", "defensive_block", "serve")
IDENTITIES = {"singles": ("P1", "P2"), "doubles": ("P1", "P2", "P3", "P4")}
# A foot point that moves faster than this between frames is an identity switch or a calibration error, not movement.
MAX_PLAYER_SPEED_M_S = 8.0
# The same rule on the image when the court is not calibrated: the foot point may move at most half a frame diagonal per
# second (about 1100 px/s at 1080p). Identity switches jump much further within one frame.
MAX_PLAYER_IMAGE_SPEED_DIAG_S = 0.5
POSITION_RATE_HZ = 15.0
SMOOTHING_FRAMES = 7
DISTANCE_MAX_GAP_FRAMES = 3
CHART_POINTS = 160
CONTACT_METHOD = (
    "heuristic: the detected shuttle turns by at least {turn:.0f} degrees within {window} frames on each side, "
    "within {reach:.0%} of a box height of a tracked player; candidates closer than {dedupe:.2f} s are merged"
)


@dataclass(frozen=True)
class ContactParams:
    window_frames: int = 3  # frames before and after the turn that define the two directions
    min_turn_deg: float = 75.0  # smallest change of direction that counts as a turn
    min_step_px: float = 2.0  # mean motion per frame on both sides, so that jitter is not a turn
    reach_ratio: float = 0.6  # extra reach around a player box, as a share of the box height
    dedupe_s: float = 0.3  # turns closer than this are one candidate (the sharpest turn is kept)


def identities_for(mode: str, logical: int) -> tuple:
    return IDENTITIES["doubles"] if mode == "doubles" or logical >= 4 else IDENTITIES["singles"]


def _points(track: O.ObservedTrack) -> dict:
    """frame -> (x, y, confidence, interpolated) for the points the sanitizer kept (image positions)."""
    return {frame: (point.x, point.y, point.confidence, point.interpolated) for frame, point in track.points.items()}


def player_foot_at(series: list, frame: int, max_gap: int = 3) -> Optional[tuple[float, float]]:
    """A player's foot position in floor-plane metres within max_gap frames of a frame; lost or uncertain samples are skipped."""
    best = None
    for item in series:
        pos_frame, x, y = item[0], item[1], item[2]
        state = item[3] if len(item) > 3 else None
        if x is None or y is None or state in ("lost", "uncertain"):
            continue
        gap = abs(int(pos_frame) - frame)
        if gap <= max_gap and (best is None or gap < best[0]):
            best = (gap, float(x), float(y))
    return None if best is None else (best[1], best[2])


def _boxes_by_frame(tracks: list) -> dict:
    """frame -> [(identity, track_id, x1, y1, x2, y2, identity_status)] for observations with a logical identity."""
    index: dict = {}
    for track in tracks:
        for obs in track.get("observations", []):
            identity = obs.get("identity")
            if identity:
                index.setdefault(int(obs["frame"]), []).append(
                    (identity, track.get("track_id"), obs["x1"], obs["y1"], obs["x2"], obs["y2"], obs.get("identity_status"))
                )
    return index


def _dedupe(candidates: list, window: int):
    """Group candidates at most ``window`` frames apart and keep the strongest of each group.

    Returns (kept, merged), where merged is a list of (weaker candidate, kept candidate) pairs.
    """
    kept, merged, group = [], [], []

    def close(members: list) -> None:
        best = max(members, key=lambda item: (item["score"], item["evidence"]["turn_deg"]))
        kept.append(best)
        merged.extend((item, best) for item in members if item is not best)

    for candidate in sorted(candidates, key=lambda item: item["frame"]):
        if group and candidate["frame"] - group[-1]["frame"] > window:
            close(group)
            group = []
        group.append(candidate)
    if group:
        close(group)
    return kept, merged


NO_PLAYER_REASON = "no tracked player within reach"


def detect_contacts(shuttle_frames: Optional[list], tracks: list, fps: float, params: ContactParams = ContactParams(), *,
                    track: Optional[O.ObservedTrack] = None, width: Optional[int] = None, height: Optional[int] = None):
    """Automatic contact candidates and every rejected turn with its reason. Nothing here is confirmed.

    The turns are read from the sanitized observed-2d/v1 track, so a tracker jump removed there can never become a
    contact. A candidate needs a sharp, sustained turn of detected (not interpolated) shuttle points, a tracked player
    whose box is within reach of the shuttle, and no stronger turn within the de-duplication window. The score is a
    heuristic blend of turn size, box proximity and shuttle confidence. It is not calibrated and not a probability.
    """
    if track is None:
        track = O.sanitize({"frames": list(shuttle_frames or [])}, width=width, height=height, fps=fps)
    points = _points(track)
    boxes = _boxes_by_frame(tracks)
    k = params.window_frames
    raw, rejected = [], []
    for frame in sorted(points):
        x, y, confidence, interpolated = points[frame]
        if interpolated:
            continue  # an interpolated point is not evidence of a turn
        if any(frame + offset not in points for offset in range(-k, k + 1)):
            continue
        before, after = points[frame - k], points[frame + k]
        vb = (x - before[0], y - before[1])
        va = (after[0] - x, after[1] - y)
        nb, na = math.hypot(*vb), math.hypot(*va)
        if nb < params.min_step_px * k or na < params.min_step_px * k:
            continue
        cosine = max(-1.0, min(1.0, (vb[0] * va[0] + vb[1] * va[1]) / (nb * na)))
        turn = math.degrees(math.acos(cosine))
        if turn < params.min_turn_deg:
            continue
        nearest = None
        closest = None
        for identity, track_id, x1, y1, x2, y2, status in boxes.get(frame, []):
            reach = params.reach_ratio * max(1.0, y2 - y1)
            distance = math.hypot(max(x1 - x, 0.0, x - x2), max(y1 - y, 0.0, y - y2))
            closest = distance if closest is None else min(closest, distance)
            if distance <= reach and (nearest is None or distance < nearest[0]):
                nearest = (distance, identity, track_id, status, reach)
        if nearest is None:
            rejected.append({
                "frame": frame,
                "time_s": round(track.time_of(frame), 3),
                "reason": NO_PLAYER_REASON,
                "turn_deg": round(turn, 1),
                "nearest_player_px": None if closest is None else round(closest, 1),
            })
            continue
        distance, identity, track_id, status, reach = nearest
        interpolated_neighbours = sum(1 for offset in range(-k, k + 1) if points[frame + offset][3])
        score = round(
            0.5 * min(turn / 180.0, 1.0) + 0.3 * max(0.0, 1.0 - distance / reach) + 0.2 * max(0.0, min(confidence, 1.0)),
            3,
        )
        raw.append({
            "frame": frame,
            "time_s": round(track.time_of(frame), 3),
            "player": identity,
            "track_id": track_id,
            "status": "candidate",
            "source": "heuristic",
            "validated": False,
            "score": score,
            "score_kind": "heuristic, uncalibrated",
            "evidence": {
                "turn_deg": round(turn, 1),
                "step_before_px": round(nb / k, 1),
                "step_after_px": round(na / k, 1),
                "distance_to_player_px": round(distance, 1),
                "reach_px": round(reach, 1),
                "shuttle_confidence": round(confidence, 3),
                "identity_status": status,
                "interpolated_neighbours": interpolated_neighbours,
            },
        })
    kept, merged = _dedupe(raw, max(1, round(params.dedupe_s * fps)))
    for weaker, stronger in merged:
        rejected.append({
            "frame": weaker["frame"],
            "time_s": weaker["time_s"],
            "reason": f"merged into the stronger turn at frame {stronger['frame']}",
            "turn_deg": weaker["evidence"]["turn_deg"],
            "nearest_player_px": weaker["evidence"]["distance_to_player_px"],
        })
    kept.sort(key=lambda item: item["frame"])
    for number, contact in enumerate(kept, start=1):
        contact["id"] = f"c{number}"
    rejected.sort(key=lambda item: item["frame"])
    return kept, rejected


def contact_candidates(shuttle_frames: Optional[list], tracks: list, fps: float, params: ContactParams = ContactParams(), *,
                       track: Optional[O.ObservedTrack] = None):
    """Candidate contacts and the number of turns that had no tracked player nearby."""
    contacts, rejected = detect_contacts(shuttle_frames, tracks, fps, params, track=track)
    return contacts, sum(1 for item in rejected if item["reason"] == NO_PLAYER_REASON)


def _nearest(items: list, frame: int, window: int) -> Optional[dict]:
    best = None
    for item in items:
        gap = abs(item["frame"] - frame)
        if gap <= window and (best is None or gap < abs(best["frame"] - frame)):
            best = item
    return best


def apply_contact_reviews(contacts: list, reviews: list, fps: float, window: int,
                          time_of: Optional[Callable[[int], float]] = None) -> list:
    """Apply manual decisions in the order they were saved. Rejected candidates stay listed but are not counted."""
    items = [dict(contact) for contact in contacts]
    added = 0
    for review in reviews:
        frame = int(review["frame"])
        decision = review["decision"]
        target = None if decision == "added" else _nearest(items, frame, window)
        if decision == "rejected":
            if target is not None:
                target.update(status="rejected", validated=True, review_id=review.get("id"))
            continue
        if target is not None:
            target.update(status="confirmed", validated=True, review_id=review.get("id"))
            if review.get("player"):
                target["player"] = review["player"]
            continue
        added += 1
        items.append(
            {
                "id": f"m{added}",
                "frame": frame,
                "time_s": round(time_of(frame), 3) if time_of else round(frame / fps, 3),
                "player": review.get("player"),
                "track_id": None,
                "status": "confirmed",
                "source": "manual",
                "validated": True,
                "evidence": None,
                "review_id": review.get("id"),
            }
        )
    items.sort(key=lambda item: item["frame"])
    return items


def build_rallies(rallies_doc: Optional[dict], edits: list, fps: float) -> list:
    items = []
    for item in (rallies_doc or {}).get("rallies", []):
        items.append(
            {
                "id": f"r{int(item['index'])}",
                "index": int(item["index"]),
                "start_frame": int(item["start_frame"]),
                "end_frame": int(item["end_frame"]),
                "source": "heuristic",
                "validated": False,
            }
        )
    next_index = max((item["index"] for item in items), default=0)
    for edit in edits:
        index = edit.get("rally_index")
        target = next((item for item in items if item["index"] == index), None) if index is not None else None
        start, end = int(edit["start_frame"]), int(edit["end_frame"])
        if target is None:
            next_index += 1
            items.append(
                {"id": f"r{next_index}", "index": next_index, "start_frame": start, "end_frame": end, "source": "manual", "validated": True}
            )
        else:
            target.update(start_frame=start, end_frame=end, source="manual", validated=True)
    items.sort(key=lambda item: item["start_frame"])
    for item in items:
        item["start_s"] = round(item["start_frame"] / fps, 3)
        item["end_s"] = round(item["end_frame"] / fps, 3)
        item["duration_s"] = round((item["end_frame"] - item["start_frame"]) / fps, 3)
    return items


def build_shots(contacts: list, rallies: list, labels: list, window: int) -> list:
    """One shot event per counted contact. The type stays "unknown" unless a person labelled it."""
    shots = []
    for contact in contacts:
        if contact["status"] == "rejected":
            continue
        rally = next((item for item in rallies if item["start_frame"] <= contact["frame"] <= item["end_frame"]), None)
        shots.append(
            {
                "id": f"s{len(shots) + 1}",
                "contact_id": contact["id"],
                "rally_id": rally["id"] if rally else None,
                "frame": contact["frame"],
                "time_s": contact["time_s"],
                "player": contact["player"],
                "type": "unknown",
                "type_source": "none",
                "type_reason": "No shot type has been assigned.",
                "confidence": None,
                "evidence_source": "manual contact" if contact["source"] == "manual" else "contact candidate: shuttle turn near the player",
                "contact_status": contact["status"],
                "model_version": None,
                "validation": "unclassified",
                "classifier": None,
                "hit_frame": None,
            }
        )
    for label in labels:
        target = _nearest(shots, int(label["frame"]), window)
        if target is None:
            continue
        value = label["shot_type"]
        if value in SIX_CLASSES:
            target.update(type=value, type_source="manual", type_reason="Labelled by a person.", validation="manual",
                          label_id=label.get("id"), person_label_note=None)
        else:
            # "unknown" or a legacy label: a person's note, never a stroke type. The timeline keeps the six-class estimate,
            # and an earlier six-class label of the same person on this shot is withdrawn by the later note.
            target.update(type="unknown", type_source="none", type_reason="No shot type has been assigned.",
                          validation="unclassified", label_id=label.get("id"), person_label_note=value,
                          legacy_label=value if value in LEGACY_SHOT_TYPES else None)
        if label.get("player"):
            target["player"] = label["player"]
    return shots


def _smoothed(points: list) -> list:
    """Centred moving average over contiguous frames, to keep foot-point jitter out of the distance."""
    half = SMOOTHING_FRAMES // 2
    result = []
    for index, (frame, _x, _y) in enumerate(points):
        window = [
            (px, py)
            for pf, px, py in points[max(0, index - half): index + half + 1]
            if abs(pf - frame) <= half
        ]
        result.append((frame, sum(p[0] for p in window) / len(window), sum(p[1] for p in window) / len(window)))
    return result


def walk_distance(samples: dict, fps: float, max_speed_per_s: float) -> dict:
    """Path length of one player's foot point: the one formula behind every player distance in the studio.

    The foot points are smoothed by a centred 7-frame mean over frames within 3 of each frame. A step counts when it
    spans at most 3 frames and is at most max_speed_per_s fast; faster steps are identity switches or calibration
    errors and are counted as skipped. Units are those of the samples (floor metres, or image pixels).
    """
    points = sorted((frame, value[0], value[1]) for frame, value in samples.items() if value[0] is not None and value[1] is not None)
    total, skipped = 0.0, 0
    series: list[tuple[int, float]] = []
    previous = None
    for frame, x, y in _smoothed(points):
        if previous is not None:
            gap = frame - previous[0]
            if gap <= DISTANCE_MAX_GAP_FRAMES:
                step = math.hypot(x - previous[1], y - previous[2])
                if step <= max_speed_per_s / fps * gap:
                    total += step
                else:
                    skipped += 1
        previous = (frame, x, y)
        series.append((frame, total))
    stride = max(1, math.ceil(len(series) / CHART_POINTS))
    # The chart keeps the summary's precision (0.01 m or 0.01 px), so its last value is exactly the summary value.
    chart = [[round(frame / fps, 3), round(value, 2)] for index, (frame, value) in enumerate(series)
             if index % stride == 0 or index == len(series) - 1]
    return {"total": round(total, 2), "jumps_skipped": skipped, "series": chart}


def _distance_m(samples: dict, fps: float) -> tuple:
    """Approximate floor-plane distance from smoothed foot points, and the number of implausible jumps skipped."""
    walk = walk_distance(samples, fps, MAX_PLAYER_SPEED_M_S)
    return walk["total"], walk["jumps_skipped"]


def player_positions(tracks: list, identities: tuple, fps: float, calibrated: bool, *, width: Optional[int] = None,
                     height: Optional[int] = None) -> dict:
    samples = {identity: {} for identity in identities}
    image = {identity: {} for identity in identities}
    confidences = {identity: [] for identity in identities}
    for track in tracks:
        for obs in track.get("observations", []):
            identity = obs.get("identity")
            if identity not in samples:
                continue
            frame = int(obs["frame"])
            x = obs.get("court_x_m") if calibrated else None
            y = obs.get("court_y_m") if calibrated else None
            samples[identity][frame] = (x, y, obs.get("identity_status"))
            if obs.get("x1") is not None and obs.get("x2") is not None and obs.get("y2") is not None:
                image[identity][frame] = ((float(obs["x1"]) + float(obs["x2"])) / 2.0, float(obs["y2"]))
            if obs.get("identity_confidence") is not None:
                confidences[identity].append(float(obs["identity_confidence"]))
    step = max(1, round(fps / POSITION_RATE_HZ))
    diagonal = math.hypot(width, height) if width and height else None
    series = {}
    players = {}
    for identity, by_frame in samples.items():
        series[identity] = [
            [frame, None if x is None else round(float(x), 3), None if y is None else round(float(y), 3), status]
            for frame, (x, y, status) in sorted(by_frame.items())
            if frame % step == 0
        ]
        if calibrated:
            walk = walk_distance(by_frame, fps, MAX_PLAYER_SPEED_M_S)
            distance = {"value": walk["total"], "unit": "m", "basis": "floor-plane metres of the foot point (flat-floor approximation)",
                        "jumps_skipped": walk["jumps_skipped"], "smoothing_frames": SMOOTHING_FRAMES,
                        "max_step_rule": f"at most {MAX_PLAYER_SPEED_M_S} m per second on the floor plane"}
        elif diagonal:
            limit = MAX_PLAYER_IMAGE_SPEED_DIAG_S * diagonal
            walk = walk_distance(image[identity], fps, limit)
            distance = {"value": walk["total"], "unit": "px", "basis": "image pixels of the foot point (court not calibrated)",
                        "jumps_skipped": walk["jumps_skipped"], "smoothing_frames": SMOOTHING_FRAMES,
                        "max_step_rule": f"at most {MAX_PLAYER_IMAGE_SPEED_DIAG_S} frame diagonals per second ({limit:.0f} px/s)"}
        else:
            walk, distance = None, None
        players[identity] = {
            "frames_with_identity": len(by_frame),
            "distance_m": walk["total"] if walk is not None and calibrated else None,
            "jumps_skipped": walk["jumps_skipped"] if walk is not None else 0,
            "distance": distance,
            "distance_series": walk["series"] if walk is not None else [],
            "mean_identity_confidence": round(sum(confidences[identity]) / len(confidences[identity]), 3) if confidences[identity] else None,
        }
    return {"step_frames": step, "series": series, "players": players}


def shot_speed(track: O.ObservedTrack, contact: Optional[dict]) -> Optional[dict]:
    """Image-space speed for a contact, from the shared sanitized track, with its confirmed or candidate basis."""
    if contact is None:
        return None
    result = O.image_speed_around(track, int(contact["frame"]))
    result["basis"] = "confirmed_contact" if contact["status"] == "confirmed" else "automatic_candidate"
    return result


def _speed_stats(values: list) -> dict:
    return {"count": len(values), "max_px_per_s": max(values) if values else None,
            "mean_px_per_s": round(sum(values) / len(values), 1) if values else None}


def assess_speed(_court_status: str, available_estimates: int = 0) -> dict:
    """Match-level policy: image-space px/s stays on its own; km/h exists only in the gated Estimated 3D tier."""
    config = O.DEFAULT_CONFIG
    return {
        "status": "experimental_3d" if available_estimates else "image_space",
        "kmh": None,
        "kind": "image_space",
        "label": ESTIMATED_3D_LABEL if available_estimates else ESTIMATED_3D_UNAVAILABLE,
        "reason": (
            f"{available_estimates} confirmed shot(s) passed every Estimated 3D gate. Image-space px/s stays separate."
            if available_estimates
            else "No shot passed the Estimated 3D gates (confirmed contact, presentation timestamps, tracking, independent "
                 "3D camera, reprojection and sensitivity)."
        ),
        "conditions": [
            {"id": "contact_confirmed", "checked": "per shot", "detail": "official speed statistics use confirmed contacts only"},
            {
                "id": "valid_steps",
                "checked": "per shot",
                "detail": f"at least {config.contact_min_points} TrackNet detections and {config.contact_min_steps} valid steps within "
                          f"{config.contact_half_window} frames of the contact; tracker jumps are removed by {O.VERSION}",
            },
            {"id": "physical_speed", "checked": "always",
             "detail": "km/h is never derived from image pixels; only the Estimated 3D tier carries km/h, and only when all its gates pass"},
        ],
    }


def _ai_block(results: dict, metrics: Optional[dict], model_execution: Optional[dict]) -> dict:
    shuttle = results.get("shuttle", {})
    frames_total = shuttle.get("frames_total") or results.get("video", {}).get("frames_analysed") or 0
    models = None
    if model_execution and isinstance(model_execution.get("models"), dict):
        models = {key: {"name": value.get("name"), "executed": value.get("executed")} for key, value in model_execution["models"].items()}
    return {
        "frames": results.get("video", {}).get("frames_analysed"),
        "fps": results.get("video", {}).get("fps"),
        "wall_seconds": (metrics or {}).get("wall_seconds"),
        "frames_per_second": (metrics or {}).get("frames_per_second"),
        "shuttle_detected_ratio": round(shuttle.get("frames_detected", 0) / frames_total, 4) if frames_total else None,
        "identity_coverage": (results.get("identity") or {}).get("coverage"),
        "court_status": results.get("court", {}).get("status"),
        "models": models,
        "device": (model_execution or {}).get("device"),
        "note": "Coverage is how often something was detected. It is not accuracy.",
    }


def build_match_document(
    *,
    job_id: str,
    results: dict,
    tracks_doc: Optional[dict],
    shuttle_doc: Optional[dict],
    rallies_doc: Optional[dict],
    corrections: list,
    metrics: Optional[dict] = None,
    model_execution: Optional[dict] = None,
    court_doc: Optional[dict] = None,
    params: ContactParams = ContactParams(),
    trajectory: Optional[dict] = None,
    session_corrections: Optional[list] = None,
    estimated_3d: Optional[dict] = None,
    track: Optional[O.ObservedTrack] = None,
    compute_estimated_3d: bool = True,
) -> dict:
    video = results.get("video", {})
    fps = float(video.get("fps") or (tracks_doc or {}).get("fps") or 30.0)
    players_block = results.get("players", {})
    mode = players_block.get("mode") or (tracks_doc or {}).get("mode") or "singles"
    identities = identities_for(mode, int(players_block.get("logical_identities") or 2))
    court = results.get("court", {})
    calibrated = court.get("status") == "calibrated"
    tracks = (tracks_doc or {}).get("tracks", [])
    window = max(1, round(params.dedupe_s * fps))
    if track is None:
        track = O.sanitize(shuttle_doc, width=video.get("width"), height=video.get("height"), fps=fps)

    def entries(kind: str) -> list:
        return [entry for entry in corrections if entry.get("type") == kind]

    candidates, rejected_contacts = detect_contacts(None, tracks, fps, params, track=track)
    turns_without_player = sum(1 for item in rejected_contacts if item["reason"] == NO_PLAYER_REASON)
    # Annotations from earlier analyses of the same video are transferred only when they match a candidate reliably.
    transferred, unmatched_annotations = reconcile_session_corrections(session_corrections or [], candidates, fps)
    corrections = transferred + corrections
    contacts = apply_contact_reviews(candidates, entries("contact_review"), fps, window, time_of=track.time_of)
    counted_contacts = [contact for contact in contacts if contact["status"] != "rejected"]
    observed_frames = [{"frame": frame, "visible": True, "refined": point.interpolated} for frame, point in track.points.items()]
    total_frames = int(video.get("frames") or 0) or None
    derived = derive_rallies(counted_contacts, fps, observed_frames, total_frames)
    if not derived:
        # No contacts to build a rally from: the shuttle-run candidates of the pipeline stay visible as uncertain.
        derived = [{**item, "status": "uncertain", "source": "shuttle_runs", "validated": False, "contact_ids": [],
                    "evidence": {"reason": "no counted contacts; pipeline shuttle-run candidate", "contacts": 0,
                                 "max_gap_s": None, "shuttle_coverage": None, "players": {}}}
                   for item in build_rallies(rallies_doc, [], fps)]
    manual_boundaries = [edit for edit in entries("rally_boundary") if edit.get("start_frame") is not None]
    rallies = merge_with_human_boundaries(derived, manual_boundaries, fps)
    for position, item in enumerate(rallies, start=1):
        item["id"] = f"r{position}"
        item["index"] = position
    shots = build_shots(contacts, rallies, entries("shot_label"), window)
    # A person's hit frame: the frame where the racket actually meets the shuttle, recorded next to the candidate.
    for hit in entries("hit_frame"):
        target = _nearest(shots, int(hit["frame"]), window)
        if target is not None:
            target["hit_frame"] = int(hit["hit_frame"])
    contact_by_id = {contact["id"]: contact for contact in contacts}
    for shot_index, shot in enumerate(shots):
        contact = contact_by_id.get(shot["contact_id"])
        shot["shot_id"] = f"{job_id}-frame-{shot['frame']}"
        shot["time_s"] = round(track.time_of(int(shot["frame"])), 3)
        shot["speed"] = shot_speed(track, contact)
        next_contact_frame = shots[shot_index + 1]["frame"] if shot_index + 1 < len(shots) else None
        stored = (estimated_3d or {}).get(int(shot["frame"]))
        if stored is not None:
            shot["estimated_3d"] = stored
        elif compute_estimated_3d:
            shot["estimated_3d"] = estimate_monocular(contact=contact, track=track, court_doc=court_doc,
                                                      next_contact_frame=next_contact_frame)
        else:
            shot["estimated_3d"] = {"mode": "estimated_monocular", "status": "not_computed", "label": ESTIMATED_3D_UNAVAILABLE,
                                    "rejection_reasons": [], "speed_candidate_kmh": None, "speed_range_kmh": None}
        shot["measured_3d"] = stereo.not_run_summary()
        record = (trajectory or {}).get(int(shot["frame"]))
        estimate = None if record is None else {
            "best_guess_label": record["best_guess_label"], "evidence_tier": record["evidence_tier"],
            "evidence_quality": record["evidence_quality"], "review_status": record["review_status"],
            "shot_id": record["shot_id"], "rule_version": record.get("rule_version"),
            "top3": record.get("top3"), "label_kind": "trajectory_estimate_unverified"}
        if shot["validation"] == "manual":
            # A person's label is never replaced; the estimate is kept beside it for comparison only.
            shot["trajectory"] = estimate
            continue
        if record is not None:
            shot.update(
                type=record["best_guess_label"], type_source="trajectory_estimate",
                type_reason=f"Trajectory estimate · unverified ({record['evidence_tier']}, {record['evidence_quality']} quality)",
                validation="trajectory_unverified", model_version=record["rule_version"],
                classifier={"top3": record["top3"], "review_status": record["review_status"]},
                trajectory=estimate,
            )
        else:
            shot.update(type="unknown", type_source="none", type_reason="No trajectory dataset row for this contact.",
                        validation="unclassified", model_version=None, classifier=None, trajectory=None)

    def basis_values(basis: str) -> list:
        return [shot["speed"]["px_per_s"] for shot in shots
                if shot["speed"] and shot["speed"].get("basis") == basis and shot["speed"]["px_per_s"] is not None]

    measured = [shot["speed"]["px_per_s"] for shot in shots if shot["speed"] and shot["speed"]["px_per_s"] is not None]
    official_values = basis_values("confirmed_contact")
    candidate_values = basis_values("automatic_candidate")
    available_3d = [shot["estimated_3d"] for shot in shots if (shot.get("estimated_3d") or {}).get("status") == "available"]
    rejection_counts = Counter(reason for shot in shots if (shot.get("estimated_3d") or {}).get("status") != "available"
                               for reason in (shot.get("estimated_3d") or {}).get("rejection_reasons", []))
    positions = player_positions(tracks, identities, fps, calibrated, width=track.width, height=track.height)

    counted = [contact for contact in contacts if contact["status"] != "rejected"]
    # A player cannot hit twice in a row, so the second of two consecutive contacts by one player is suspect.
    repeats = 0
    previous: Optional[dict] = None
    for shot in shots:
        shot["flags"] = []
        if previous is not None and shot["player"] and shot["player"] == previous["player"] and shot["rally_id"] == previous["rally_id"]:
            shot["flags"].append("same_player_twice")
            repeats += 1
        previous = shot
    for rally in rallies:
        rally_shots = [shot for shot in shots if shot["rally_id"] == rally["id"]]
        rally["contacts"] = len(rally_shots)
        rally["hits_by_player"] = {identity: sum(1 for shot in rally_shots if shot["player"] == identity) for identity in identities}
        rally["shot_ids"] = [shot["id"] for shot in rally_shots]
        rally["winner"] = None
        rally["winner_status"] = "not supported: the point outcome is not detected"

    # Statistics count a person's labels only. Trajectory estimates are counted apart and always called estimates.
    by_type = {kind: sum(1 for shot in shots if shot["type"] == kind and shot["type_source"] == "manual") for kind in SIX_CLASSES}
    by_type["unknown"] = sum(1 for shot in shots if shot.get("person_label_note") == "unknown")
    estimates_by_type = {kind: sum(1 for shot in shots if (shot.get("trajectory") or {}).get("best_guess_label") == kind)
                         for kind in SIX_CLASSES}
    ordered = sorted(shots, key=lambda item: (item["time_s"], item["frame"]))
    intervals = [b["time_s"] - a["time_s"] for a, b in zip(ordered, ordered[1:])
                 if a.get("rally_id") is not None and a.get("rally_id") == b.get("rally_id")]
    interval_mean = round(sum(intervals) / len(intervals), 3) if intervals else None

    player_summary = {}
    distance_chart = {}
    dashboard_players = {}
    for identity in identities:
        own = [shot for shot in shots if shot["player"] == identity]
        position = dict(positions["players"][identity])
        series = position.pop("distance_series")
        official = [shot["speed"]["px_per_s"] for shot in own
                    if shot["speed"] and shot["speed"].get("basis") == "confirmed_contact" and shot["speed"]["px_per_s"] is not None]
        estimates = {kind: sum(1 for shot in own if (shot.get("trajectory") or {}).get("best_guess_label") == kind) for kind in SIX_CLASSES}
        top = max(SIX_CLASSES, key=lambda kind: (estimates[kind], -SIX_CLASSES.index(kind))) if any(estimates.values()) else None
        most_frequent = None if top is None else {
            "label": top, "count": estimates[top], "of": sum(estimates.values()),
            "label_kind": "trajectory_estimate_unverified", "badge": "Trajectory estimate · unverified"}
        player_summary[identity] = {
            **position,
            "hits": len(own),
            "confirmed_contacts": sum(1 for shot in own if shot["contact_status"] == "confirmed"),
            "official_speed": {"basis": "confirmed contacts only", **_speed_stats(official)},
            "coverage": ((results.get("identity") or {}).get("coverage") or {}).get(identity),
            "estimates_by_type": estimates,
            "most_frequent_estimate": most_frequent,
            "person_labels_by_type": {kind: sum(1 for shot in own if shot["type_source"] == "manual" and shot["type"] == kind)
                                      for kind in SIX_CLASSES},
        }
        distance_chart[identity] = series
        dashboard_players[identity] = {
            "contacts": len(own),
            "confirmed_contacts": player_summary[identity]["confirmed_contacts"],
            "official_max_px_per_s": player_summary[identity]["official_speed"]["max_px_per_s"],
            "official_mean_px_per_s": player_summary[identity]["official_speed"]["mean_px_per_s"],
            "official_speed_count": player_summary[identity]["official_speed"]["count"],
            "distance": position.get("distance"),
            "most_frequent_estimate": most_frequent,
        }

    if calibrated:
        contact_items = []
        for shot in shots:
            foot = player_foot_at(positions["series"].get(shot["player"], []), int(shot["frame"])) if shot["player"] else None
            contact_items.append({"shot_id": shot["shot_id"], "timeline_id": shot["id"], "frame": shot["frame"], "player": shot["player"],
                                  "x": None if foot is None else round(foot[0], 3), "y": None if foot is None else round(foot[1], 3)})
        contact_positions = {"space": "court_m", "label": "player foot position at the contact (floor-plane metres)",
                             "dimensions_m": COURT, "items": contact_items}
    else:
        contact_items = []
        for shot in shots:
            point = O.contact_point(track, int(shot["frame"]))
            contact_items.append({"shot_id": shot["shot_id"], "timeline_id": shot["id"], "frame": shot["frame"], "player": shot["player"],
                                  "x": None if point is None else round(point.x / track.width, 4),
                                  "y": None if point is None else round(point.y / track.height, 4)})
        contact_positions = {"space": "image_normalized", "label": "shuttle image position at the contact (not court metres)",
                             "frame_size": [track.width, track.height], "items": contact_items}

    rally_summary = summarise_rallies(
        rallies,
        {rally["id"]: [shot for shot in shots if shot["rally_id"] == rally["id"]] for rally in rallies},
        tuple(identities),
    )
    speed_summary = {
        "unit": "px/s",
        "kind": "image_space",
        "label": "Image-space speed (px/s)",
        "official": {"basis": "confirmed contacts only", **_speed_stats(official_values)},
        "candidates": {"basis": "automatic candidates; not part of the official statistics", **_speed_stats(candidate_values)},
        "max_px_per_s": max(official_values) if official_values else None,
        "candidate_max_px_per_s": max(candidate_values) if candidate_values else None,
        "measured_shots": len(measured),
        "by_basis": {"confirmed_contact": len(official_values), "automatic_candidate": len(candidate_values)},
        "method": O.SPEED_METHOD,
        "max_kmh": max((item["speed_candidate_kmh"] for item in available_3d), default=None),
        "physical_measurements": len(available_3d),
        "physical_label": ESTIMATED_3D_LABEL if available_3d else ESTIMATED_3D_UNAVAILABLE,
        "estimated_3d": {
            "mode": "estimated_monocular",
            "label": ESTIMATED_3D_LABEL if available_3d else ESTIMATED_3D_UNAVAILABLE,
            "available": len(available_3d),
            "rejected": len(shots) - len(available_3d),
            "rejection_reasons": dict(sorted(rejection_counts.items())),
        },
        "measured_3d": stereo.not_run_summary(),
    }

    return {
        "schema": SCHEMA,
        "job_id": job_id,
        "fps": fps,
        "frames": video.get("frames_analysed"),
        "duration_s": video.get("duration_s"),
        "mode": mode,
        "players": list(identities),
        "court": {
            "status": court.get("status"),
            "reason": court.get("reason"),
            "score": court.get("score"),
            "coverage": court.get("coverage"),
            "template": court.get("template"),
            "dimensions_m": COURT,
            "map_available": calibrated,
            "approximation": "flat floor; feet assumed on the floor" if calibrated else None,
        },
        "speed": assess_speed(court.get("status") or "failed", len(available_3d)),
        "positions": {
            "court_available": calibrated,
            "reason": None if calibrated else "Court map unavailable: the court is not calibrated.",
            "step_frames": positions["step_frames"],
            "series": positions["series"],
        },
        "observed_2d": {**track.summary(), **track.compact()},
        "contacts": {
            "method": CONTACT_METHOD.format(turn=params.min_turn_deg, window=params.window_frames, reach=params.reach_ratio, dedupe=params.dedupe_s),
            "status": "candidates",
            "validated": all(contact["validated"] for contact in counted) if counted else False,
            "dedupe_window_frames": window,
            "turns_without_player": turns_without_player,
            "items": contacts,
            "rejected": rejected_contacts,
        },
        "annotations": {
            "transferred": [_transfer_summary(item) for item in transferred],
            "unmatched": unmatched_annotations,
            "rule": "earlier corrections of the same video are transferred only when a candidate lies within 0.5 s and the player agrees",
        },
        "rallies": {
            "status": "contact_sequence_v1" if any(item.get("source") == "contact_sequence" for item in rallies) else (rallies_doc or {}).get("status", "unavailable"),
            "validated": all(rally["validated"] for rally in rallies) if rallies else False,
            "method": (rallies_doc or {}).get("method"),
            "items": rallies,
        },
        "shots": {
            "classifier": {"available": False, "model_version": None, "reason": "No shot classifier evaluated against ground truth is part of this build."},
            "types": list(SHOT_TYPES),
            "items": shots,
        },
        "summary": {
            "rallies": rally_summary,
            "contacts": {
                "counted": len(counted),
                "candidates": sum(1 for contact in contacts if contact["status"] == "candidate"),
                "confirmed": sum(1 for contact in contacts if contact["status"] == "confirmed"),
                "rejected": sum(1 for contact in contacts if contact["status"] == "rejected"),
                "turns_without_player": turns_without_player,
                "rejected_automatic": len(rejected_contacts),
                "same_player_twice": repeats,
            },
            "shots": {
                "by_type": by_type,
                "labelled": sum(1 for shot in shots if shot["validation"] == "manual"),
                "unknown": by_type["unknown"],
                "person_notes": sum(1 for shot in shots if shot.get("person_label_note")),
                "estimates_by_type": estimates_by_type,
                "estimate_label_kind": "trajectory_estimate_unverified",
                "interval_within_rally": {
                    "mean_s": interval_mean,
                    "count": len(intervals),
                    "basis": "consecutive contacts inside the same rally candidate; gaps between rallies are excluded",
                },
            },
            "speed": speed_summary,
            "players": player_summary,
        },
        "dashboard": {
            "note": "Every value here is computed by the backend from the same sanitized track and timeline as the rest of this document.",
            "players": dashboard_players,
            "speed_panel": {
                "unit": "px/s",
                "official_count": len(official_values),
                "official_mean_px_per_s": speed_summary["official"]["mean_px_per_s"],
                "official_max_px_per_s": speed_summary["official"]["max_px_per_s"],
                "candidate_count": len(candidate_values),
                "candidate_mean_px_per_s": speed_summary["candidates"]["mean_px_per_s"],
                "rally_mean_duration_s": rally_summary.get("mean_duration_s"),
                "shot_interval_mean_s": interval_mean,
                "shot_interval_basis": "within_rally",
            },
            "distance_chart": {
                "unit": "m" if calibrated else "px",
                "basis": "floor-plane metres of the foot point" if calibrated else "image pixels of the foot point",
                "series": distance_chart,
            },
            "contact_positions": contact_positions,
        },
        "measured_3d": stereo.not_run_summary(),
        "ai": _ai_block(results, metrics, model_execution),
    }

TRANSFERABLE_TYPES = ("contact_review", "shot_label", "hit_frame")
TRANSFER_TOLERANCE_S = 0.5


def reconcile_session_corrections(session_corrections: list, candidates: list, fps: float) -> tuple[list, list]:
    """Transfer earlier corrections of the same video to the active analysis, or report them as unmatched.

    A correction moves only when a candidate lies within TRANSFER_TOLERANCE_S and, for a player-specific annotation,
    the candidate's player is the same. Anything else stays listed for review; nothing is dropped.
    """
    tolerance = round(TRANSFER_TOLERANCE_S * fps)
    transferred: list[dict] = []
    unmatched: list[dict] = []
    for entry in session_corrections:
        kind = entry.get("type")
        if kind not in TRANSFERABLE_TYPES:
            unmatched.append(_unmatched(entry, f"'{kind}' belongs to its own analysis and is not transferred"))
            continue
        if entry.get("frame") is None:
            unmatched.append(_unmatched(entry, "no frame"))
            continue
        nearest = min(candidates, key=lambda item: abs(item["frame"] - int(entry["frame"])), default=None)
        if nearest is None or abs(nearest["frame"] - int(entry["frame"])) > tolerance:
            unmatched.append(_unmatched(entry, f"no candidate within {TRANSFER_TOLERANCE_S} s in the active analysis"))
            continue
        if entry.get("player") and nearest.get("player") != entry["player"]:
            unmatched.append(_unmatched(entry, f"player differs: the candidate is {nearest.get('player')}, the annotation {entry['player']}"))
            continue
        transferred.append({**entry, "original_frame": entry["frame"], "frame": nearest["frame"]})
    return transferred, unmatched


def _unmatched(entry: dict, reason: str) -> dict:
    return {"type": entry.get("type"), "frame": entry.get("frame"), "player": entry.get("player"),
            "decision": entry.get("decision"), "shot_type": entry.get("shot_type"), "hit_frame": entry.get("hit_frame"),
            "source_job_id": entry.get("source_job_id"), "correction_id": entry.get("id"), "reason": reason}


def _transfer_summary(entry: dict) -> dict:
    return {"type": entry.get("type"), "frame": entry.get("frame"), "original_frame": entry.get("original_frame"),
            "player": entry.get("player"), "decision": entry.get("decision"), "shot_type": entry.get("shot_type"),
            "source_job_id": entry.get("source_job_id"), "correction_id": entry.get("id")}
