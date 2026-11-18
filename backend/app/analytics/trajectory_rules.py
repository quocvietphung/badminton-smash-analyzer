"""trajectory-rules/v1: deterministic rule engine for the six-class stroke estimate of a contact candidate.

Not a neural network and not a trained model. The same inputs always give the same output: no randomness, no
timestamps, no per-video or per-sample constants. Every label is a best guess from the rule scores. Nothing here is a
ground-truth label or a validated statistic.

Inputs per contact
- The shuttle trajectory from TrackNetV3 (raw, unchanged). A point is measured when it is visible, not refined and its
  confidence reaches the threshold. A visible refined point is an InpaintNet interpolation.
- The contact frame, the player identity, and, when the court calibration is valid, the player's foot position on the
  floor plane in metres. The shuttle is never mapped to floor metres.

Evidence tiers (the same scorer runs for all three)
- full_trajectory: enough measured points before and after the contact.
- partial_trajectory: some points before or after, enough for some features.
- contact_fallback: only a local window around the contact. Requires at least two points within the local window and
  a usable local speed and direction. Below that the contact is an integrity error, not a silent default.

Units: speeds are image pixels per second. Positions are normalised by the frame size. No km/h is derived.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Mapping, Optional, Sequence

RULE_VERSION = "trajectory-rules/v1"
CLASSES = ("smash", "clear", "drop", "drive", "net_shot", "lift")
NET_Y_M = 6.70  # the net lies across the middle of the floor plane (court origin at the far edge, see court_coordinates)

CONFIG: dict = {
    "window_before": 12,       # frames before contact (0.4 s at 30 fps)
    "window_after": 45,        # frames after contact (1.5 s at 30 fps)
    "fallback_window": 6,      # frames either side for the contact fallback
    "conf_threshold": 0.5,     # measured points below this are not used
    "smoothing": 1,            # 1 = none; odd values average neighbouring points
    "offsets": (-2, 0, 2),     # contact shifts for the stability check
    "full_min_before": 6,
    "full_min_after": 12,
    "partial_min_total": 3,
    "fallback_min_points": 2,
    "min_margin": 0.08,        # best minus second best rule share
    "accept_min_valid_ratio": 0.6,
    "accept_max_interpolated_ratio": 0.2,
    "max_plausible_px_s": 5000.0,  # faster steps are tracker jumps: left out of the speed features and counted
}

# (feature, membership, weight). Memberships: ("ramp", lo, hi) rises 0->1; ("ramp_down", lo, hi) falls 1->0;
# ("bump", a, b, c, d) trapezoid. A missing feature contributes nothing (it is listed in missing_features).
RULES: dict[str, list[tuple[str, tuple, float]]] = {
    "smash": [
        ("rel_speed_after_max", ("ramp", 0.75, 1.0), 2.0),
        ("speed_change_ratio", ("ramp", 1.0, 1.8), 1.0),
        ("descent_norm", ("ramp", 0.03, 0.15), 2.0),
        ("straightness", ("ramp", 0.75, 0.95), 1.0),
        ("flight_s", ("ramp_down", 0.5, 1.0), 1.0),
        ("apex_time_s", ("ramp_down", 0.1, 0.4), 1.0),
        ("contact_net_m", ("ramp", 2.5, 5.0), 1.0),
    ],
    "clear": [
        ("rise_norm", ("ramp", 0.08, 0.2), 2.5),
        ("apex_time_s", ("ramp", 0.25, 0.7), 1.5),
        ("flight_s", ("ramp", 0.8, 1.6), 2.0),
        ("rel_speed_after_median", ("ramp_down", 0.6, 0.9), 1.0),
        ("contact_net_m", ("ramp", 3.0, 5.5), 1.0),
    ],
    "drop": [
        ("speed_change_ratio", ("ramp_down", 0.6, 1.0), 2.5),
        ("rel_speed_after_median", ("bump", 0.15, 0.3, 0.55, 0.75), 1.5),
        ("descent_norm", ("ramp", 0.02, 0.12), 1.5),
        ("flight_s", ("bump", 0.3, 0.6, 1.0, 1.4), 1.0),
        ("contact_net_m", ("ramp_down", 2.0, 4.0), 1.0),
    ],
    "drive": [
        ("rel_speed_after_median", ("ramp", 0.6, 0.9), 2.0),
        ("straightness", ("ramp", 0.8, 0.95), 2.0),
        ("vertical_travel_norm", ("ramp_down", 0.04, 0.12), 1.5),
        ("curvature_rad", ("ramp_down", 0.04, 0.12), 1.0),
        ("rise_norm", ("ramp_down", 0.02, 0.08), 1.0),
    ],
    "net_shot": [
        ("contact_net_m", ("ramp_down", 1.5, 3.5), 2.0),
        ("rel_speed_after_median", ("bump", 0.1, 0.3, 0.6, 0.8), 1.5),
        ("rise_norm", ("ramp_down", 0.02, 0.08), 2.0),
        ("flight_s", ("ramp_down", 0.5, 1.0), 1.5),
        ("length_norm", ("ramp_down", 0.15, 0.35), 1.0),
    ],
    "lift": [
        ("contact_net_m", ("ramp_down", 2.0, 4.0), 2.0),
        ("rise_norm", ("ramp", 0.08, 0.2), 2.0),
        ("apex_time_s", ("ramp", 0.2, 0.6), 1.0),
        ("rel_speed_after_median", ("bump", 0.2, 0.4, 0.7, 0.9), 1.0),
        ("flight_s", ("ramp", 0.6, 1.2), 1.0),
    ],
}

FEATURE_ORDER = sorted({name for rules in RULES.values() for name, _spec, _w in rules})


class PipelineIntegrityError(RuntimeError):
    """A contact candidate has no data for even the fallback tier. The pipeline reports this; it never picks a default."""

    def __init__(self, frame: int, reason: str) -> None:
        super().__init__(f"contact at frame {frame}: {reason}")
        self.code = "shot_trajectory_insufficient_data"
        self.frame = frame
        self.reason = reason


@dataclass(frozen=True)
class Point:
    frame: int
    x: float
    y: float
    interpolated: bool
    confidence: float = 1.0


def _clip(value: float) -> float:
    return max(0.0, min(1.0, value))


def membership(value: Optional[float], spec: tuple) -> Optional[float]:
    if value is None:
        return None
    kind = spec[0]
    if kind == "ramp":
        return _clip((value - spec[1]) / (spec[2] - spec[1]))
    if kind == "ramp_down":
        return _clip((spec[2] - value) / (spec[2] - spec[1]))
    if kind == "bump":
        a, b, c, d = spec[1:]
        if value <= a or value >= d:
            return 0.0
        if value < b:
            return (value - a) / (b - a)
        if value <= c:
            return 1.0
        return (d - value) / (d - c)
    raise ValueError(f"unknown membership {kind}")


def build_track(shuttle_doc: Mapping, *, conf_threshold: float, smoothing: int = 1) -> dict[int, Point]:
    """frame -> Point for every visible point. Measured points need confidence; interpolated points do not."""
    points: dict[int, Point] = {}
    for item in shuttle_doc.get("frames", []):
        if not item.get("visible") or item.get("x") is None or item.get("y") is None:
            continue
        frame = int(item["frame"])
        refined = bool(item.get("refined"))
        if not refined and float(item.get("confidence") or 0.0) < conf_threshold:
            continue
        points[frame] = Point(frame, float(item["x"]), float(item["y"]), refined, float(item.get("confidence") or 0.0))
    if smoothing > 1:
        half = smoothing // 2
        ordered = sorted(points)
        smoothed: dict[int, Point] = {}
        for index, frame in enumerate(ordered):
            window = [points[f] for f in ordered[max(0, index - half): index + half + 1]]
            smoothed[frame] = Point(frame, sum(p.x for p in window) / len(window), sum(p.y for p in window) / len(window),
                                    points[frame].interpolated, points[frame].confidence)
        points = smoothed
    return points


def video_speed_reference(track: Mapping[int, Point], fps: float, cap: float = CONFIG["max_plausible_px_s"]) -> Optional[float]:
    """95th percentile of measured speeds across the whole video: the reference for relative speed (deterministic)."""
    speeds, _skipped = _speeds_counted([p for p in track.values() if not p.interpolated], fps, cap)
    return _percentile(speeds, 95) if speeds else None


def _speeds_counted(points: Sequence[Point], fps: float, cap: float = CONFIG["max_plausible_px_s"]) -> tuple[list[float], int]:
    """Speeds of consecutive points with at most a two-frame gap. Steps above the plausible cap are counted, not used."""
    out: list[float] = []
    skipped = 0
    for a, b in zip(points, points[1:]):
        gap = b.frame - a.frame
        if 0 < gap <= 2:
            speed = math.hypot(b.x - a.x, b.y - a.y) / gap * fps
            if speed > cap:
                skipped += 1
            else:
                out.append(speed)
    return out, skipped


def _speeds(points: Sequence[Point], fps: float) -> list[float]:
    return _speeds_counted(points, fps)[0]


def _percentile(values: Sequence[float], q: float) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    k = (len(ordered) - 1) * q / 100.0
    lo, hi = math.floor(k), math.ceil(k)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (k - lo)


def _median(values: Sequence[float]) -> Optional[float]:
    return _percentile(values, 50) if values else None


def _window_points(track: Mapping[int, Point], lo: int, hi: int) -> list[Point]:
    return [track[f] for f in range(lo, hi + 1) if f in track]


def _runs_missing(lo: int, hi: int, track: Mapping[int, Point]) -> int:
    runs, inside = 0, False
    for f in range(lo, hi + 1):
        if f in track:
            inside = False
        elif not inside:
            runs += 1
            inside = True
    return runs


def _direction_label(vx: float, vy: float) -> str:
    """Image direction: down means towards the bottom of the frame. Level when the vertical part is small."""
    if abs(vx) < 1e-9 and abs(vy) < 1e-9:
        return "none"
    horizontal = "right" if vx > 0 else "left"
    if abs(vy) < 0.35 * abs(vx):
        return f"level-{horizontal}"
    vertical = "down" if vy > 0 else "up"
    return f"{vertical}-{horizontal}"


def extract(track: Mapping[int, Point], contact_frame: int, *, fps: float, width: int, height: int,
            speed_ref: Optional[float], player_foot: Optional[tuple[float, float]], court_calibrated: bool,
            config: Mapping = CONFIG, window_before: Optional[int] = None, window_after: Optional[int] = None) -> dict:
    """Feature values for one contact. Missing features are None, never guessed."""
    before_n = int(window_before if window_before is not None else config["window_before"])
    after_n = int(window_after if window_after is not None else config["window_after"])
    W, H = float(width), float(height)
    diagonal = math.hypot(W, H)

    before = _window_points(track, contact_frame - before_n, contact_frame - 1)
    after = _window_points(track, contact_frame + 1, contact_frame + after_n)
    contact = track.get(contact_frame)
    if contact is None:
        near = [track[f] for f in (contact_frame - 2, contact_frame - 1, contact_frame + 1, contact_frame + 2) if f in track]
        contact = near[0] if near else None
    feats: dict = {}
    measured_before = sum(1 for p in before if not p.interpolated)
    measured_after = sum(1 for p in after if not p.interpolated)
    feats["valid_points_before"] = measured_before
    feats["valid_points_after"] = measured_after
    feats["valid_ratio_before"] = round(measured_before / before_n, 4) if before_n else None
    feats["valid_ratio_after"] = round(measured_after / after_n, 4) if after_n else None
    feats["missing_runs_after"] = _runs_missing(contact_frame + 1, contact_frame + after_n, track)
    interpolated_total = sum(1 for p in before + after if p.interpolated)
    span = before_n + after_n
    feats["interpolated_points"] = interpolated_total
    feats["interpolated_ratio"] = round(interpolated_total / span, 4) if span else None
    feats["contact_point_present"] = contact is not None

    sp_before, skipped_before = _speeds_counted(before + ([contact] if contact else []), fps)
    sp_after, skipped_after = _speeds_counted(([contact] if contact else []) + after, fps)
    feats["implausible_steps_removed"] = skipped_before + skipped_after
    feats["speed_before_median_px_s"] = _round(_median(sp_before))
    feats["speed_before_max_px_s"] = _round(max(sp_before) if sp_before else None)
    feats["speed_after_median_px_s"] = _round(_median(sp_after))
    feats["speed_after_max_px_s"] = _round(max(sp_after) if sp_after else None)
    feats["speed_change_ratio"] = _ratio(feats["speed_after_median_px_s"], feats["speed_before_median_px_s"])
    feats["rel_speed_before_median"] = _ratio(feats["speed_before_median_px_s"], speed_ref)
    feats["rel_speed_after_median"] = _ratio(feats["speed_after_median_px_s"], speed_ref)
    feats["rel_speed_after_max"] = _ratio(feats["speed_after_max_px_s"], speed_ref)

    if contact is not None and after:
        first = after[: min(3, len(after))]
        dt = (first[-1].frame - contact_frame) / fps
        vx = (first[-1].x - contact.x) / dt if dt > 0 else 0.0
        vy = (first[-1].y - contact.y) / dt if dt > 0 else 0.0
        feats["initial_vx_px_s"] = round(vx, 1)
        feats["initial_vy_px_s"] = round(vy, 1)
        feats["initial_speed_px_s"] = round(math.hypot(vx, vy), 1)
        feats["initial_direction"] = _direction_label(vx, vy)
        feats["horizontal_component_px_s"] = round(vx, 1)
        feats["vertical_component_px_s"] = round(vy, 1)
        ys = [p.y for p in after] + [contact.y]
        min_y_point = min(after + [contact], key=lambda p: (p.y, p.frame))
        max_y = max(p.y for p in after)
        feats["apex_time_s"] = round((min_y_point.frame - contact_frame) / fps, 4)
        feats["rise_norm"] = round((contact.y - min(ys)) / H, 4)
        feats["descent_norm"] = round((max_y - contact.y) / H, 4)
        end = after[-1]
        feats["vertical_travel_norm"] = round(abs(end.y - contact.y) / H, 4)
        feats["horizontal_travel_norm"] = round(abs(end.x - contact.x) / W, 4)
        chain = [contact] + after
        length = sum(math.hypot(b.x - a.x, b.y - a.y) for a, b in zip(chain, chain[1:]))
        disp = math.hypot(end.x - contact.x, end.y - contact.y)
        feats["length_norm"] = round(length / diagonal, 4) if length > 0 else 0.0
        feats["straightness"] = round(disp / length, 4) if length > 0 else None
        feats["curvature_rad"] = _curvature(chain)
        last_run_end = _observed_flight_end(contact_frame, after, track)
        feats["flight_s"] = round((last_run_end - contact_frame) / fps, 4)
        feats["flight_truncated_by_window"] = last_run_end >= contact_frame + after_n
    else:
        for key in ("initial_vx_px_s", "initial_vy_px_s", "initial_speed_px_s", "initial_direction",
                    "horizontal_component_px_s", "vertical_component_px_s", "apex_time_s", "rise_norm", "descent_norm",
                    "vertical_travel_norm", "horizontal_travel_norm", "length_norm", "straightness", "curvature_rad",
                    "flight_s", "flight_truncated_by_window"):
            feats[key] = None

    feats["player_foot_available"] = player_foot is not None and court_calibrated
    if player_foot is not None and court_calibrated:
        feats["player_foot_x_m"] = round(player_foot[0], 3)
        feats["player_foot_y_m"] = round(player_foot[1], 3)
        feats["contact_net_m"] = round(abs(player_foot[1] - NET_Y_M), 3)
        feats["player_side"] = "far" if player_foot[1] < NET_Y_M else "near"
    else:
        feats["player_foot_x_m"] = None
        feats["player_foot_y_m"] = None
        feats["contact_net_m"] = None
        feats["player_side"] = None
    feats["contact_x_norm"] = round(contact.x / W, 4) if contact is not None else None
    feats["contact_y_norm"] = round(contact.y / H, 4) if contact is not None else None
    feats["speed_ref_px_s"] = _round(speed_ref)
    return feats


def _round(value: Optional[float]) -> Optional[float]:
    return None if value is None or (isinstance(value, float) and math.isnan(value)) else round(value, 2)


def _ratio(a: Optional[float], b: Optional[float]) -> Optional[float]:
    if a is None or b is None or b <= 0:
        return None
    return round(a / b, 4)


def _curvature(chain: Sequence[Point]) -> Optional[float]:
    headings = []
    for a, b in zip(chain, chain[1:]):
        if (b.x, b.y) != (a.x, a.y):
            headings.append(math.atan2(b.y - a.y, b.x - a.x))
    if len(headings) < 2:
        return None
    turns = []
    for h0, h1 in zip(headings, headings[1:]):
        d = abs(h1 - h0)
        turns.append(min(d, 2 * math.pi - d))
    return round(sum(turns) / len(turns), 4)


def _observed_flight_end(contact_frame: int, after: Sequence[Point], track: Mapping[int, Point]) -> int:
    """Last frame of the flight: gaps of up to three frames between points are bridged, a longer gap ends it."""
    last = contact_frame
    for p in after:
        if p.frame - last > 4:
            break
        last = p.frame
    return last


def score(features: Mapping) -> dict:
    """Rule scores per class. Each class = weighted mean of the memberships of its available features."""
    raw: dict[str, float] = {}
    contributions: dict[str, list[dict]] = {}
    for cls in CLASSES:
        total, weights = 0.0, 0.0
        rows = []
        for name, spec, weight in RULES[cls]:
            value = features.get(name)
            m = membership(value, spec)
            if m is not None:
                total += weight * m
                weights += weight
            rows.append({"feature": name, "value": value, "membership": None if m is None else round(m, 4),
                         "weight": weight, "used": m is not None})
        raw[cls] = total / weights if weights > 0 else 0.0
        contributions[cls] = rows
    total_raw = sum(raw.values())
    shares = {cls: (raw[cls] / total_raw if total_raw > 0 else 0.0) for cls in CLASSES}
    return {"raw": {c: round(raw[c], 4) for c in CLASSES}, "scores": {c: round(shares[c], 4) for c in CLASSES},
            "contributions": contributions}


def rank(scores: Mapping[str, float]) -> list[tuple[str, float]]:
    order = {cls: index for index, cls in enumerate(CLASSES)}
    return sorted(scores.items(), key=lambda item: (-item[1], order[item[0]]))


def missing_features(features: Mapping) -> list[str]:
    needed = {name for rules in RULES.values() for name, _spec, _w in rules}
    return sorted(name for name in needed if features.get(name) is None)


def evidence_tier(features: Mapping, *, has_local_points: int, has_speed_local: bool, has_direction_local: bool,
                  config: Mapping = CONFIG) -> str:
    if features["valid_points_before"] >= config["full_min_before"] and features["valid_points_after"] >= config["full_min_after"]:
        return "full_trajectory"
    if features["valid_points_before"] + features["valid_points_after"] >= config["partial_min_total"]:
        return "partial_trajectory"
    if has_local_points >= config["fallback_min_points"] and has_speed_local and has_direction_local:
        return "contact_fallback"
    return ""


def evidence_quality(tier: str, features: Mapping, config: Mapping = CONFIG) -> str:
    valid = min(features.get("valid_ratio_before") or 0.0, features.get("valid_ratio_after") or 0.0)
    if tier == "full_trajectory" and valid >= 0.7 and (features.get("interpolated_ratio") or 0.0) <= config["accept_max_interpolated_ratio"]:
        return "high"
    if tier == "full_trajectory" or (tier == "partial_trajectory" and valid >= 0.3):
        return "medium"
    return "low"


def classify_contact(
    track: Mapping[int, Point],
    contact_frame: int,
    *,
    fps: float,
    width: int,
    height: int,
    speed_ref: Optional[float],
    player_foot: Optional[tuple[float, float]],
    court_calibrated: bool,
    contact_status: str = "candidate",
    config: Mapping = CONFIG,
) -> dict:
    """The full record payload for one contact: tier, scores, top 3, review status, reasons and warnings."""
    kwargs = dict(fps=fps, width=width, height=height, speed_ref=speed_ref, player_foot=player_foot,
                  court_calibrated=court_calibrated, config=config)
    local = [track[f] for f in range(contact_frame - config["fallback_window"], contact_frame + config["fallback_window"] + 1)
             if f in track]
    local_speeds = _speeds(local, fps)
    anchor = track.get(contact_frame)
    later = [track[f] for f in range(contact_frame + 1, contact_frame + config["fallback_window"] + 1) if f in track]
    # A direction exists when a later local point differs from the contact point (or the contact has no point of its own).
    local_direction = bool(later) and (anchor is None or any((p.x, p.y) != (anchor.x, anchor.y) for p in later))
    main = extract(track, contact_frame, **kwargs)
    tier = evidence_tier(main, has_local_points=len(local), has_speed_local=bool(local_speeds),
                         has_direction_local=bool(local_direction), config=config)
    if tier == "":
        raise PipelineIntegrityError(contact_frame, "no usable trajectory even in the local window")
    if tier == "contact_fallback":
        features = extract(track, contact_frame, window_before=config["fallback_window"],
                           window_after=config["fallback_window"], **kwargs)
        features["valid_points_before"] = sum(1 for f in range(contact_frame - config["fallback_window"], contact_frame) if f in track)
        features["valid_points_after"] = sum(1 for f in range(contact_frame + 1, contact_frame + config["fallback_window"] + 1) if f in track)
    else:
        features = main

    scored = score(features)
    ranked = rank(scored["scores"])
    best = ranked[0][0]
    margin = round(ranked[0][1] - ranked[1][1], 4)

    offset_labels: dict[str, str] = {}
    for off in config["offsets"]:
        if off == 0:
            offset_labels["0"] = best
            continue
        shifted = _classify_features(track, contact_frame + off, tier, kwargs, config)
        offset_labels[str(off)] = shifted

    quality = evidence_quality(tier, features, config)
    reasons = []
    if contact_status != "confirmed":
        reasons.append("contact is not confirmed by a person")
    if tier != "full_trajectory":
        reasons.append(f"evidence tier is {tier}, not full_trajectory")
    if quality != "high":
        reasons.append(f"evidence quality is {quality}")
    if margin < float(config["min_margin"]):
        reasons.append(f"small margin between the best and second class ({margin})")
    if len(set(offset_labels.values())) > 1:
        reasons.append("candidate changes when the contact is shifted by two frames")
    warnings = []
    if features.get("implausible_steps_removed"):
        warnings.append(f"{features['implausible_steps_removed']} implausible shuttle step(s) above "
                        f"{int(config['max_plausible_px_s'])} px/s left out of the speed features (tracker jump)")
    if features.get("flight_truncated_by_window"):
        warnings.append("flight continues to the end of the window; flight duration is a lower bound")
    if features.get("missing_runs_after", 0) > 0 and features.get("valid_ratio_after", 0) < 0.5:
        warnings.append("gaps in the trajectory after the contact")
    if not court_calibrated:
        warnings.append("no court calibration: player-to-net distance unavailable")
    review_status = "accepted_by_gate" if not reasons else "needs_review"
    if contact_status != "confirmed":
        review_status = "needs_review"
    return {
        "best_guess_label": best,
        "review_status": review_status,
        "review_reasons": reasons,
        "quality_warnings": warnings,
        "evidence_tier": tier,
        "evidence_quality": quality,
        "scores": scored["scores"],
        "raw_scores": scored["raw"],
        "top3": [[cls, score_value] for cls, score_value in ranked[:3]],
        "margin": margin,
        "features": features,
        "missing_features": missing_features(features),
        "rule_contributions": scored["contributions"],
        "offset_labels": offset_labels,
        "rule_version": RULE_VERSION,
    }


def _classify_features(track, frame, tier, kwargs, config) -> str:
    if tier == "contact_fallback":
        features = extract(track, frame, window_before=config["fallback_window"], window_after=config["fallback_window"], **kwargs)
    else:
        features = extract(track, frame, **kwargs)
    return rank(score(features)["scores"])[0][0]
