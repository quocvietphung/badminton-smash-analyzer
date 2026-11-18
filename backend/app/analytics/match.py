"""Match intelligence derived from the saved outputs of one analysis.

The inputs are files the pipeline already wrote: the shuttle trajectory and the player tracks (image pixels, logical
identities P1 to P4, and floor-plane metres when the court is calibrated), the rally candidates, the court
calibration, the metrics and the manual corrections. No model runs here, and nothing is written back.

Rules that keep the numbers honest:
- A contact is a candidate: a sharp turn of the detected shuttle close to a tracked player. A turn alone does not
  prove racket contact, so a candidate stays unvalidated until a person confirms it.
- Shot types are either manual labels or the trajectory-rules/v1 estimate (labelled "Trajectory estimate · unverified")
  from the per-shot dataset of this analysis. A manual label always wins. An estimate is never a validated statistic.
- Shuttle motion is reported only in image pixels per second. It is not physical shuttle speed. One camera does not
  observe the shuttle's height, so projecting an airborne shuttle onto the floor plane would misstate km/h.
- Court positions come from floor-plane metres, which exist only for a calibrated court.
"""

from __future__ import annotations

import math

from app.analytics.rallies import derive_rallies, merge_with_human_boundaries, summarise as summarise_rallies
from app.physics.speed3d import estimate_shot_speed
from dataclasses import dataclass
from typing import Optional

SCHEMA = "smashlab.match/v1"
COURT = {"length_m": 13.40, "doubles_width_m": 6.10, "singles_width_m": 5.18}
SHOT_TYPES = ("smash", "clear", "drop", "drive", "net_shot", "lift", "unknown")
# Labels from before the taxonomy was narrowed. They are kept in corrections.json for traceability, but the product
# shows them as Unknown and never exports them as a stroke type.
LEGACY_SHOT_TYPES = ("push", "defensive_block", "serve")
IDENTITIES = {"singles": ("P1", "P2"), "doubles": ("P1", "P2", "P3", "P4")}
# A foot point that moves faster than this between frames is an identity switch or a calibration error, not movement.
MAX_PLAYER_SPEED_M_S = 8.0
POSITION_RATE_HZ = 15.0
SMOOTHING_FRAMES = 7
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


def _points(shuttle_frames: list) -> dict:
    """frame -> (x, y, confidence, interpolated) for frames with a shuttle position."""
    points = {}
    for item in shuttle_frames:
        if item.get("visible") and item.get("x") is not None and item.get("y") is not None:
            points[int(item["frame"])] = (
                float(item["x"]),
                float(item["y"]),
                float(item.get("confidence") or 0.0),
                bool(item.get("refined")),
            )
    return points


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


def detect_contacts(shuttle_frames: list, tracks: list, fps: float, params: ContactParams = ContactParams()):
    """Automatic contact candidates and every rejected turn with its reason. Nothing here is validated.

    A candidate needs a sharp, sustained turn of detected (not interpolated) shuttle points, a tracked player whose
    box is within reach of the shuttle, and no stronger turn within the de-duplication window. The score is a
    heuristic blend of turn size, box proximity and shuttle confidence. It is not calibrated and not a probability.
    """
    points = _points(shuttle_frames)
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
                "time_s": round(frame / fps, 3),
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
            "time_s": round(frame / fps, 3),
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


def contact_candidates(shuttle_frames: list, tracks: list, fps: float, params: ContactParams = ContactParams()):
    """Candidate contacts and the number of turns that had no tracked player nearby."""
    contacts, rejected = detect_contacts(shuttle_frames, tracks, fps, params)
    return contacts, sum(1 for item in rejected if item["reason"] == NO_PLAYER_REASON)


def _nearest(items: list, frame: int, window: int) -> Optional[dict]:
    best = None
    for item in items:
        gap = abs(item["frame"] - frame)
        if gap <= window and (best is None or gap < abs(best["frame"] - frame)):
            best = item
    return best


def apply_contact_reviews(contacts: list, reviews: list, fps: float, window: int) -> list:
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
                "time_s": round(frame / fps, 3),
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
        legacy = label["shot_type"] in LEGACY_SHOT_TYPES
        if legacy:
            # Old label outside the six product classes: keep it visible as unmapped, never as a stroke.
            target.update(type="unknown", type_source="manual", type_reason=f"Legacy label '{label['shot_type']}' is not a product class.",
                          validation="manual", label_id=label.get("id"), legacy_label=label["shot_type"])
        else:
            target.update(type=label["shot_type"], type_source="manual", type_reason="Labelled by a person.", validation="manual", label_id=label.get("id"))
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


def _distance_m(samples: dict, fps: float) -> tuple:
    """Approximate floor-plane distance from smoothed foot points, and the number of implausible jumps skipped."""
    points = sorted((frame, value[0], value[1]) for frame, value in samples.items() if value[0] is not None and value[1] is not None)
    total, skipped = 0.0, 0
    previous = None
    for frame, x, y in _smoothed(points):
        if previous is not None:
            gap = frame - previous[0]
            if gap <= 3:
                step = math.hypot(x - previous[1], y - previous[2])
                if step <= MAX_PLAYER_SPEED_M_S / fps * gap:
                    total += step
                else:
                    skipped += 1
        previous = (frame, x, y)
    return round(total, 2), skipped


def player_positions(tracks: list, identities: tuple, fps: float, calibrated: bool) -> dict:
    samples = {identity: {} for identity in identities}
    confidences = {identity: [] for identity in identities}
    for track in tracks:
        for obs in track.get("observations", []):
            identity = obs.get("identity")
            if identity not in samples:
                continue
            x = obs.get("court_x_m") if calibrated else None
            y = obs.get("court_y_m") if calibrated else None
            samples[identity][int(obs["frame"])] = (x, y, obs.get("identity_status"))
            if obs.get("identity_confidence") is not None:
                confidences[identity].append(float(obs["identity_confidence"]))
    step = max(1, round(fps / POSITION_RATE_HZ))
    series = {}
    players = {}
    for identity, by_frame in samples.items():
        series[identity] = [
            [frame, None if x is None else round(float(x), 3), None if y is None else round(float(y), 3), status]
            for frame, (x, y, status) in sorted(by_frame.items())
            if frame % step == 0
        ]
        distance, skipped = _distance_m(by_frame, fps) if calibrated else (None, 0)
        players[identity] = {
            "frames_with_identity": len(by_frame),
            "distance_m": distance,
            "jumps_skipped": skipped,
            "mean_identity_confidence": round(sum(confidences[identity]) / len(confidences[identity]), 3) if confidences[identity] else None,
        }
    return {"step_frames": step, "series": series, "players": players}


MOTION_WINDOW_FRAMES = 3
MOTION_MIN_POINTS = 4
MOTION_METHOD = (
    "Image-space shuttle motion: path length across detected, non-interpolated points within 3 frames of the contact "
    "divided by elapsed time. Units are pixels per second; this is not physical shuttle speed."
)



def detected_image_points(shuttle_frames: list) -> dict:
    """frame -> image (x, y) for detector observations only; interpolated points are not measurement evidence."""
    return {
        int(item["frame"]): (float(item["x"]), float(item["y"]))
        for item in shuttle_frames
        if item.get("visible") and not item.get("refined") and item.get("x") is not None and item.get("y") is not None
    }


def shot_motion(frame: int, image_points: dict, fps: float) -> dict:
    """Average image-space path rate around a contact. This deliberately does not return metres or km/h."""
    if fps <= 0:
        return {"kmh": None, "px_per_s": None, "kind": None, "reason": "The frame rate is unknown."}
    around = sorted(f for f in range(frame - MOTION_WINDOW_FRAMES, frame + MOTION_WINDOW_FRAMES + 1) if f in image_points)
    if len(around) < MOTION_MIN_POINTS:
        return {
            "kmh": None,
            "px_per_s": None,
            "kind": None,
            "reason": f"Only {len(around)} detected shuttle points lie within 3 frames of the contact; {MOTION_MIN_POINTS} are needed.",
        }
    first, last = around[0], around[-1]
    elapsed = (last - first) / fps
    path_px = sum(
        math.hypot(
            image_points[current][0] - image_points[previous][0],
            image_points[current][1] - image_points[previous][1],
        )
        for previous, current in zip(around, around[1:])
    )
    if elapsed <= 0 or path_px <= 0:
        return {"kmh": None, "px_per_s": None, "kind": None, "reason": "The detected points do not contain measurable image motion."}
    return {
        "kmh": None,
        "px_per_s": round(path_px / elapsed, 1),
        "kind": "image_space",
        "points": len(around),
        "method": MOTION_METHOD,
        "physical_speed_available": False,
    }


def shot_motion_for(contact: Optional[dict], image_points: dict, fps: float) -> Optional[dict]:
    """Image motion for a contact, with its human-confirmed or automatic-candidate basis."""
    if contact is None:
        return None
    result = shot_motion(contact["frame"], image_points, fps)
    result["basis"] = "confirmed_contact" if contact["status"] == "confirmed" else "automatic_candidate"
    return result


def assess_speed(_court_status: str, available_physical: int = 0) -> dict:
    """Match-level policy: px/s remains independent; 3D km/h is individually gated."""
    return {
        "status": "experimental_3d" if available_physical else "image_space",
        "kmh": None,
        "kind": "image_space",
        "label": "Experimental 3D Speed Estimate — Not Radar Validated" if available_physical else "Physical speed unavailable",
        "reason": (
            f"{available_physical} confirmed shot(s) passed the experimental 3D evidence gates. Image-space px/s remains separate."
            if available_physical
            else "No confirmed shot passed the 3D camera, timestamp, tracking, reprojection and sensitivity gates."
        ),
        "conditions": [
            {"id": "contact_confirmed", "checked": "per shot", "detail": "only confirmed contacts enter headline and player maxima"},
            {
                "id": "detected_points",
                "checked": "per shot",
                "detail": f"at least {MOTION_MIN_POINTS} detected (not interpolated) shuttle points within {MOTION_WINDOW_FRAMES} frames of the contact",
            },
            {"id": "physical_speed", "checked": "always", "detail": "km/h is not derived from monocular image pixels"},
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

    def entries(kind: str) -> list:
        return [entry for entry in corrections if entry.get("type") == kind]

    candidates, rejected_contacts = detect_contacts((shuttle_doc or {}).get("frames", []), tracks, fps, params)
    turns_without_player = sum(1 for item in rejected_contacts if item["reason"] == NO_PLAYER_REASON)
    # Annotations from earlier analyses of the same video are transferred only when they match a candidate reliably.
    transferred, unmatched_annotations = reconcile_session_corrections(session_corrections or [], candidates, fps)
    corrections = transferred + corrections
    contacts = apply_contact_reviews(candidates, entries("contact_review"), fps, window)
    counted_contacts = [contact for contact in contacts if contact["status"] != "rejected"]
    shuttle_list = (shuttle_doc or {}).get("frames", [])
    total_frames = int(video.get("frames") or 0) or None
    derived = derive_rallies(counted_contacts, fps, shuttle_list, total_frames)
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
    shuttle_frames = (shuttle_doc or {}).get("frames", [])
    image_points = detected_image_points(shuttle_frames)
    contact_by_id = {contact["id"]: contact for contact in contacts}
    video_width = int(video.get("width") or 0)
    video_height = int(video.get("height") or 0)
    for shot_index, shot in enumerate(shots):
        contact = contact_by_id.get(shot["contact_id"])
        shot["speed"] = shot_motion_for(contact, image_points, fps)
        next_contact_frame = shots[shot_index + 1]["frame"] if shot_index + 1 < len(shots) else None
        shot["physical_speed"] = estimate_shot_speed(
            contact=contact,
            shuttle_doc=shuttle_doc,
            court_doc=court_doc,
            width=video_width,
            height=video_height,
            next_contact_frame=next_contact_frame,
        )
        record = (trajectory or {}).get(int(shot["frame"]))
        if shot["validation"] == "manual":
            # A person's label is never replaced; the estimate is kept beside it for comparison only.
            shot["trajectory"] = None if record is None else {
                "best_guess_label": record["best_guess_label"], "evidence_tier": record["evidence_tier"],
                "evidence_quality": record["evidence_quality"], "review_status": record["review_status"],
                "shot_id": record["shot_id"]}
            continue
        if record is not None:
            shot.update(
                type=record["best_guess_label"], type_source="trajectory_estimate",
                type_reason=f"Trajectory estimate · unverified ({record['evidence_tier']}, {record['evidence_quality']} quality)",
                validation="trajectory_unverified", model_version=record["rule_version"],
                classifier={"top3": record["top3"], "review_status": record["review_status"]},
                trajectory={"best_guess_label": record["best_guess_label"], "evidence_tier": record["evidence_tier"],
                            "evidence_quality": record["evidence_quality"], "review_status": record["review_status"],
                            "shot_id": record["shot_id"]},
            )
        else:
            shot.update(type="unknown", type_source="none", type_reason="No trajectory dataset row for this contact.",
                        validation="unclassified", model_version=None, classifier=None, trajectory=None)
    measured = [shot["speed"]["px_per_s"] for shot in shots if shot["speed"] and shot["speed"]["px_per_s"] is not None]
    measured_by_basis = {
        basis: sum(1 for shot in shots if shot["speed"] and shot["speed"].get("basis") == basis and shot["speed"]["px_per_s"] is not None)
        for basis in ("confirmed_contact", "automatic_candidate")
    }
    confirmed_motion = [
        shot["speed"]["px_per_s"] for shot in shots
        if shot["speed"] and shot["speed"].get("basis") == "confirmed_contact" and shot["speed"]["px_per_s"] is not None
    ]
    candidate_motion = [
        shot["speed"]["px_per_s"] for shot in shots
        if shot["speed"] and shot["speed"].get("basis") == "automatic_candidate" and shot["speed"]["px_per_s"] is not None
    ]
    physical_results = [
        shot["physical_speed"] for shot in shots if shot.get("physical_speed", {}).get("status") == "available"
    ]
    positions = player_positions(tracks, identities, fps, calibrated)

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

    # Statistics count a person's labels only. Trajectory estimates are shown beside each contact, never as statistics.
    by_type = {kind: sum(1 for shot in shots if shot["type"] == kind and shot["type_source"] == "manual") for kind in SHOT_TYPES}
    player_summary = {}
    for identity in identities:
        player_summary[identity] = {
            **positions["players"][identity],
            "hits": sum(1 for shot in shots if shot["player"] == identity),
            "coverage": ((results.get("identity") or {}).get("coverage") or {}).get(identity),
            "shots_by_type": {kind: sum(1 for shot in shots if shot["player"] == identity and shot["type"] == kind) for kind in SHOT_TYPES},
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
        "speed": assess_speed(court.get("status") or "failed", len(physical_results)),
        "positions": {
            "court_available": calibrated,
            "reason": None if calibrated else "Court map unavailable: the court is not calibrated.",
            "step_frames": positions["step_frames"],
            "series": positions["series"],
        },
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
            "classifier": {"available": False, "model_version": None, "reason": "No validated shot classifier is part of this build."},
            "types": list(SHOT_TYPES),
            "items": shots,
        },
        "summary": {
            "rallies": summarise_rallies(
                rallies,
                {rally["id"]: [shot for shot in shots if shot["rally_id"] == rally["id"]] for rally in rallies},
                tuple(identities),
            ),
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
            },
            "speed": {
                "max_kmh": max((item["speed_first_observed_kmh"] for item in physical_results), default=None),
                "physical_measurements": len(physical_results),
                "physical_label": "Experimental 3D Speed Estimate — Not Radar Validated" if physical_results else "Physical speed unavailable",
                "max_px_per_s": max(confirmed_motion) if confirmed_motion else None,
                "candidate_max_px_per_s": max(candidate_motion) if candidate_motion else None,
                "measured_shots": len(measured),
                "by_basis": measured_by_basis,
                "method": MOTION_METHOD,
            },
            "players": player_summary,
        },
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
