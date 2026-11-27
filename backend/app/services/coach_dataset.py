"""coach-dataset/v1: one JSON document per analysis, for the AI Coach and for the single export.

It holds only values this analysis measured: the player movement on the court map (floor metres when the court is
calibrated, image pixels otherwise), the shot timeline of every logical identity (P1 and P2 in singles, P1 to P4 in
doubles) with trajectory estimates, image-space speeds in px/s from the shared observed-2d/v1 track, and the evidence
behind each estimate. Official speed values use confirmed contacts only. Nothing is evaluated against ground truth, and
speeds are never converted to km/h.

Built deterministically from this job's files only. A person's shot label is reported as a person's label, and an
estimate is reported as an unverified estimate.
"""

from __future__ import annotations

import math
from statistics import median
from typing import Mapping, Optional, Sequence

from app.analytics import trajectory_rules as R

SCHEMA = "smashlab.coach-dataset/v1"
NET_Y_M = 6.70
IMAGE_JUMP_PX = 200.0       # centre jumps larger than this between two observations are tracker jumps
IMAGE_MAX_GAP_FRAMES = 5    # observations further apart than this do not join a path
PLAYERS = ("P1", "P2")
DOUBLES_PLAYERS = ("P1", "P2", "P3", "P4")


def _zone(y: float) -> str:
    distance = abs(y - NET_Y_M)
    if distance <= 2.0:
        return "front_court"
    if distance <= 4.0:
        return "mid_court"
    return "back_court"


def players_of(match_doc: Mapping) -> tuple[str, ...]:
    """The logical identities of this analysis: P1 and P2 in singles, P1 to P4 in doubles."""
    return DOUBLES_PLAYERS if match_doc.get("mode") == "doubles" else PLAYERS


def _image_paths(tracks_doc: Mapping, fps: float, players: Sequence[str] = PLAYERS) -> dict[str, dict]:
    """Per player: image-space path length (px) and number of observations, from this job's tracks only."""
    out: dict[str, dict] = {player: {"path_px": 0.0, "observations": 0, "jumps_skipped": 0} for player in players}
    for track in tracks_doc.get("tracks", []):
        for obs in track.get("observations", []):
            identity = obs.get("identity")
            if identity not in out:
                continue
            out[identity]["observations"] += 1
    grouped: dict[str, list[tuple[int, float, float]]] = {player: [] for player in players}
    for track in tracks_doc.get("tracks", []):
        for obs in track.get("observations", []):
            identity = obs.get("identity")
            if identity not in grouped or obs.get("x1") is None or obs.get("x2") is None:
                continue
            cx = (float(obs["x1"]) + float(obs["x2"])) / 2
            cy = (float(obs["y1"]) + float(obs["y2"])) / 2
            grouped[identity].append((int(obs["frame"]), cx, cy))
    for player, points in grouped.items():
        points.sort()
        for (fa, xa, ya), (fb, xb, yb) in zip(points, points[1:]):
            gap = fb - fa
            if gap <= 0 or gap > IMAGE_MAX_GAP_FRAMES:
                continue
            step = math.hypot(xb - xa, yb - ya)
            if step > IMAGE_JUMP_PX:
                out[player]["jumps_skipped"] += 1
                continue
            out[player]["path_px"] += step
    for player in players:
        out[player]["path_px"] = round(out[player]["path_px"], 1)
    return out


def _zone_shares(series: Sequence[Sequence]) -> dict[str, Optional[float]]:
    counts = {"front_court": 0, "mid_court": 0, "back_court": 0}
    total = 0
    for item in series:
        y = item[2]
        if y is None:
            continue
        counts[_zone(float(y))] += 1
        total += 1
    if total == 0:
        return {key: None for key in counts}
    return {key: round(value / total, 3) for key, value in counts.items()}


def build(*, job_id: str, match_doc: Mapping, records: Sequence[Mapping], tracks_doc: Optional[Mapping],
          results: Mapping, fps: float) -> dict:
    calibrated = match_doc.get("court", {}).get("status") == "calibrated"
    players = players_of(match_doc)
    image = _image_paths(tracks_doc or {}, fps, players)
    players_block = (match_doc.get("summary", {}) or {}).get("players", {}) or {}
    positions = (match_doc.get("positions", {}) or {}).get("series", {}) or {}

    per_player: dict[str, dict] = {}
    for player in players:
        player_shots = [r for r in records if r.get("player") == player]
        labels: dict[str, int] = {cls: 0 for cls in R.CLASSES}
        manual: dict[str, int] = {}
        for r in player_shots:
            labels[r["best_guess_label"]] += 1  # every contact has an estimate; a person's label is counted apart
            if r.get("manual_label") in R.CLASSES:
                manual[r["manual_label"]] = manual.get(r["manual_label"], 0) + 1
        official = [float(r["image_speed"]["px_per_s"]) for r in player_shots
                    if (r.get("image_speed") or {}).get("px_per_s") is not None and r.get("contact_status") == "confirmed"]
        candidate = [float(r["image_speed"]["px_per_s"]) for r in player_shots
                     if (r.get("image_speed") or {}).get("px_per_s") is not None and r.get("contact_status") != "confirmed"]
        stats = players_block.get(player, {})
        distance = stats.get("distance_m") if calibrated else None
        per_player[player] = {
            "contacts": len(player_shots),
            "confirmed_contacts": sum(1 for r in player_shots if r.get("contact_status") == "confirmed"),
            "shot_estimates": labels,
            "shot_estimates_kind": "trajectory_estimate_unverified",
            "manual_labels": manual,
            "image_speed_official_px_s": {"basis": "confirmed contacts only", "count": len(official),
                                          "max": round(max(official), 1) if official else None,
                                          "median": round(median(official), 1) if official else None},
            "image_speed_candidates_px_s": {"basis": "automatic candidates, not official", "count": len(candidate),
                                            "max": round(max(candidate), 1) if candidate else None,
                                            "median": round(median(candidate), 1) if candidate else None},
            "movement": {
                "court_distance_m": distance,
                "court_distance_basis": "floor-plane metres, flat-floor approximation" if calibrated else None,
                "distance": stats.get("distance"),
                "image_path_px": image[player]["path_px"],
                "image_observations": image[player]["observations"],
                "image_jumps_skipped": image[player]["jumps_skipped"],
                "court_zone_share": _zone_shares(positions.get(player, [])) if calibrated else None,
                "tracking_coverage": stats.get("coverage"),
            },
        }

    if calibrated and all(per_player[p]["movement"]["court_distance_m"] is not None for p in players):
        values = {p: per_player[p]["movement"]["court_distance_m"] for p in players}
        metric, basis = "court_distance_m", "floor-plane metres (approximate)"
    else:
        values = {p: per_player[p]["movement"]["image_path_px"] for p in players}
        metric, basis = "image_path_px", "image pixels (court not calibrated)"
    # Singles: P1 against P2. Doubles: the identity that moved most against the one that moved least.
    leader = max(players, key=lambda p: (values[p] or 0.0, p == "P1"))
    other = min(players, key=lambda p: (values[p] or 0.0, p))
    difference = None
    if values[leader] and values[other] is not None and values[other] > 0:
        difference = round((values[leader] - values[other]) / values[other] * 100, 1)
    movement = {
        "metric": metric,
        "basis": basis,
        "values": {p: values[p] for p in players},
        "compared": [leader, other],
        "more_movement": leader if values[leader] and values[leader] != values[other] else None,
        "difference_percent": difference,
        "note": "Movement is a measured quantity. It says nothing about shot quality.",
    }

    shots = []
    timeline = {item.get("frame"): item for item in (match_doc.get("shots", {}) or {}).get("items", [])}
    for r in records:
        shot = timeline.get(r["frame"]) or {}
        shots.append({
            "shot_id": r.get("shot_id"),
            "time_s": r["timestamp_s"],
            "frame": r["frame"],
            "player": r.get("player"),
            "contact_status": r.get("contact_status"),
            "estimate_label": r["best_guess_label"],
            "label_kind": "trajectory_estimate_unverified",
            "manual_label": r.get("manual_label"),
            "person_label_note": r.get("person_label_note"),
            "image_speed_px_s": (r.get("image_speed") or {}).get("px_per_s"),
            "image_speed_basis": (r.get("image_speed") or {}).get("basis"),
            "estimated_3d_status": (shot.get("estimated_3d") or {}).get("status"),
            "estimated_3d_reasons": (shot.get("estimated_3d") or {}).get("rejection_reasons", []),
            "speed_after_median_px_s": r["features"].get("speed_after_median_px_s"),
            "speed_after_max_px_s": r["features"].get("speed_after_max_px_s"),
            "initial_direction": r["features"].get("initial_direction"),
            "apex_time_s": r["features"].get("apex_time_s"),
            "observed_flight_s": r["features"].get("observed_flight_s"),
            "evidence_tier": r["evidence_tier"],
            "evidence_quality": r["evidence_quality"],
            "review_status": r["review_status"],
            "top3": r["top3"],
            "review_reasons": r["review_reasons"],
            "player_zone": (r.get("player_court_context") or {}).get("relative_to_net"),
        })
    shots.sort(key=lambda item: (item["time_s"], item["frame"]))

    speed = (match_doc.get("summary", {}) or {}).get("speed", {}) or {}
    return {
        "schema": SCHEMA,
        "job_id": job_id,
        "rule_version": R.RULE_VERSION,
        "observed_2d_version": (match_doc.get("observed_2d") or {}).get("version"),
        "speed_summary": {
            "unit": "px/s",
            "official": speed.get("official"),
            "candidates": speed.get("candidates"),
            "estimated_3d": speed.get("estimated_3d"),
            "measured_3d": speed.get("measured_3d"),
        },
        "source": {
            "name": results.get("source", {}).get("name") if isinstance(results.get("source"), dict) else None,
            "fps": fps,
            "frames": (results.get("video") or {}).get("frames") or (results.get("video") or {}).get("frames_analysed"),
            "duration_s": (results.get("video") or {}).get("duration_s"),
            "court_status": match_doc.get("court", {}).get("status"),
            "court_template": match_doc.get("court", {}).get("template"),
        },
        "players": per_player,
        "movement_comparison": movement,
        "shots": shots,
        "shot_counts": {
            "rows": len(shots),
            "accepted_by_gate": sum(1 for s in shots if s["review_status"] == "accepted_by_gate"),
            "needs_review": sum(1 for s in shots if s["review_status"] == "needs_review"),
            "person_labelled": sum(1 for s in shots if s["manual_label"] in R.CLASSES),
        },
        "limitations": [
            "Shot labels are rule-based trajectory estimates, not validated. Do not treat them as facts.",
            "Speeds are image-space pixels per second. They are not physical speeds and are never km/h.",
            "Official speed values use confirmed contacts only; automatic candidates are listed apart.",
            "Estimated 3D is a one-camera experiment and is rejected unless every gate passes; Measured 3D needs two cameras.",
            "Player movement uses floor-plane metres only when the court is calibrated; otherwise image pixels.",
            "Nothing here is a technique or form score.",
        ],
    }
