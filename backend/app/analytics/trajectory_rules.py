"""trajectory-rules/v2: deterministic rule engine for the six-class stroke estimate of a contact candidate.

Not a neural network and not a trained model. The same inputs always give the same output: no randomness, no
timestamps, no per-video or per-sample constants. Every label is a best guess from the rule scores. Nothing here is a
ground-truth label or a validated statistic.

Inputs per contact
- The observed-2d/v1 track (app/analytics/observed2d.py): the raw TrackNetV3 / InpaintNet output after the shared
  sanitizer. A point is measured ("detected") when it is a TrackNet detection that passed the sanitizer; an InpaintNet
  fill is "interpolated". Tracker jumps are already removed there, with their reasons, and speeds come only from valid
  steps between detections.
- The contact frame, the player identity, and, when the court calibration is valid, the player's foot position on the
  floor plane in metres. The shuttle is never mapped to floor metres.

Evidence tiers (the same scorer runs for all three)
- full_trajectory: enough measured points before and after the contact.
- partial_trajectory: some points before or after, enough for some features.
- contact_fallback: only a local window around the contact. Requires at least two points within the local window and
  a usable local speed and direction. Below that the contact is an integrity error, not a silent default.

Units: speeds are image pixels per second. Positions are normalised by the frame size. No km/h is derived.

v2 differs from v1 only in its input: v1 read the raw file and dropped steps above a fixed 5000 px/s; v2 reads the shared
sanitized track (frame-diagonal-normalised jump rule, detected/interpolated kept apart, real timestamps for durations).
The memberships, weights, tiers and gates are unchanged.
"""

from __future__ import annotations

import dataclasses
import math
from typing import Mapping, Optional, Sequence

from app.analytics import observed2d as O

RULE_VERSION = "trajectory-rules/v2"
CLASSES = ("smash", "clear", "drop", "drive", "net_shot", "lift")
NET_Y_M = 6.70  # the net lies across the middle of the floor plane (court origin at the far edge, see court_coordinates)

CONFIG: dict = {
    "window_before": 12,       # frames before contact (0.4 s at 30 fps)
    "window_after": 45,        # frames after contact (1.5 s at 30 fps)
    "fallback_window": 6,      # frames either side for the contact fallback
    "offsets": (-2, 0, 2),     # contact shifts for the stability check
    "full_min_before": 6,
    "full_min_after": 12,
    "partial_min_total": 3,
    "fallback_min_points": 2,
    "min_margin": 0.08,        # best minus second best rule share
    "high_quality_min_valid_ratio": 0.7,          # evidence quality "high": the smaller valid ratio reaches this
    "high_quality_max_interpolated_ratio": 0.2,   # ... and at most this share of the window is interpolated
    "medium_partial_min_valid_ratio": 0.3,        # a partial trajectory is "medium" from this valid ratio
}
# The confidence threshold, the jump rule and the smoothing belong to the shared sanitizer (observed2d.Config).

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


Point = O.ObservedPoint  # a point of the sanitized track


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


def build_track(shuttle_doc: Mapping, *, conf_threshold: Optional[float] = None, smoothing: Optional[int] = None,
                width: Optional[int] = None, height: Optional[int] = None, fps: Optional[float] = None) -> O.ObservedTrack:
    """The shared sanitized track (observed-2d/v1). Overrides exist for the sensitivity tool only."""
    config = O.DEFAULT_CONFIG
    overrides = {}
    if conf_threshold is not None:
        overrides["conf_threshold"] = float(conf_threshold)
    if smoothing is not None:
        overrides["smoothing_window"] = int(smoothing)
    if overrides:
        config = dataclasses.replace(config, **overrides)
    return O.sanitize(shuttle_doc, width=width, height=height, fps=fps, config=config)


def video_speed_reference(track: O.ObservedTrack, fps: Optional[float] = None) -> Optional[float]:
    """95th percentile of the valid step speeds of the whole video: the reference for relative speeds."""
    return O.speed_reference(track)


def _speeds(track: O.ObservedTrack, points: Sequence[O.ObservedPoint]) -> list[float]:
    return [step.speed_px_s for step in O.steps(track, points)]


def _percentile(values: Sequence[float], q: float) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    k = (len(ordered) - 1) * q / 100.0
    lo, hi = math.floor(k), math.ceil(k)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (k - lo)


def _median(values: Sequence[float]) -> Optional[float]:
    return _percentile(values, 50) if values else None


def _runs_missing(lo: int, hi: int, track: O.ObservedTrack) -> int:
    runs, inside = 0, False
    for f in range(lo, hi + 1):
        if f in track.points:
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


def extract(track: O.ObservedTrack, contact_frame: int, *, fps: Optional[float] = None, width: Optional[int] = None,
            height: Optional[int] = None, speed_ref: Optional[float], player_foot: Optional[tuple[float, float]],
            court_calibrated: bool, config: Mapping = CONFIG, window_before: Optional[int] = None,
            window_after: Optional[int] = None) -> dict:
    """Feature values for one contact, read from the sanitized track. Missing features are None, never guessed."""
    before_n = int(window_before if window_before is not None else config["window_before"])
    after_n = int(window_after if window_after is not None else config["window_after"])
    W = float(width or track.width)
    H = float(height or track.height)
    diagonal = math.hypot(W, H)
    lo, hi = contact_frame - before_n, contact_frame + after_n

    before = track.window(lo, contact_frame - 1)
    after = track.window(contact_frame + 1, hi)
    contact = O.contact_point(track, contact_frame)
    feats: dict = {}
    measured_before = sum(1 for p in before if not p.interpolated)
    measured_after = sum(1 for p in after if not p.interpolated)
    feats["valid_points_before"] = measured_before
    feats["valid_points_after"] = measured_after
    feats["valid_ratio_before"] = round(measured_before / before_n, 4) if before_n else None
    feats["valid_ratio_after"] = round(measured_after / after_n, 4) if after_n else None
    feats["missing_runs_after"] = _runs_missing(contact_frame + 1, hi, track)
    interpolated_total = sum(1 for p in before + after if p.interpolated)
    span = before_n + after_n
    feats["detected_points"] = measured_before + measured_after
    feats["detected_ratio"] = round((measured_before + measured_after) / span, 4) if span else None
    feats["interpolated_points"] = interpolated_total
    feats["interpolated_ratio"] = round(interpolated_total / span, 4) if span else None
    feats["contact_point_present"] = contact is not None
    rejected = track.rejected_in(lo, hi)
    feats["tracker_jumps_removed"] = sum(1 for item in rejected if item.reason == "tracker_jump")
    feats["low_confidence_removed"] = sum(1 for item in rejected if item.reason == "low_confidence")
    feats["implausible_steps"] = len(track.invalid_steps_in(lo, hi))

    sp_before = _speeds(track, before + ([contact] if contact else []))
    sp_after = _speeds(track, ([contact] if contact else []) + after)
    feats["speed_steps_before"] = len(sp_before)
    feats["speed_steps_after"] = len(sp_after)
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
        dt = track.duration(contact_frame, first[-1].frame)
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
        feats["apex_time_s"] = round(track.duration(contact_frame, min_y_point.frame), 4)
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
        last_run_end = _observed_flight_end(contact_frame, after, track.config.max_missing_frames + 1)
        feats["flight_s"] = round(track.duration(contact_frame, last_run_end), 4)
        feats["flight_truncated_by_window"] = last_run_end >= hi
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


def _observed_flight_end(contact_frame: int, after: Sequence[Point], link: int) -> int:
    """Last frame of the flight: a frame step of at most ``link`` is bridged (3 missing frames), a longer gap ends it."""
    last = contact_frame
    for p in after:
        if p.frame - last > link:
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
    if (tier == "full_trajectory" and valid >= config["high_quality_min_valid_ratio"]
            and (features.get("interpolated_ratio") or 0.0) <= config["high_quality_max_interpolated_ratio"]):
        return "high"
    if tier == "full_trajectory" or (tier == "partial_trajectory" and valid >= config["medium_partial_min_valid_ratio"]):
        return "medium"
    return "low"


def classify_contact(
    track: O.ObservedTrack,
    contact_frame: int,
    *,
    fps: Optional[float] = None,
    width: Optional[int] = None,
    height: Optional[int] = None,
    speed_ref: Optional[float],
    player_foot: Optional[tuple[float, float]],
    court_calibrated: bool,
    contact_status: str = "candidate",
    config: Mapping = CONFIG,
) -> dict:
    """The full record payload for one contact: tier, scores, top 3, review status, reasons and warnings."""
    kwargs = dict(fps=fps, width=width, height=height, speed_ref=speed_ref, player_foot=player_foot,
                  court_calibrated=court_calibrated, config=config)
    local = track.window(contact_frame - config["fallback_window"], contact_frame + config["fallback_window"])
    local_speeds = _speeds(track, local)
    anchor = track.points.get(contact_frame)
    later = track.window(contact_frame + 1, contact_frame + config["fallback_window"])
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
        features["valid_points_before"] = len(track.window(contact_frame - config["fallback_window"], contact_frame - 1))
        features["valid_points_after"] = len(track.window(contact_frame + 1, contact_frame + config["fallback_window"]))
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
    if features.get("tracker_jumps_removed"):
        warnings.append(f"{features['tracker_jumps_removed']} tracker-jump point(s) removed by the observed-2D sanitizer "
                        f"(entry faster than {track.config.max_speed_diag_per_s} frame diagonals per second, "
                        f"{track.max_speed_px_s:.0f} px/s here)")
    if features.get("implausible_steps"):
        warnings.append(f"{features['implausible_steps']} implausible step(s) without a return are kept out of the speeds")
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
