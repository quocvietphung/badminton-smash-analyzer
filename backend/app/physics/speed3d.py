"""Estimated 3D — monocular experimental: shuttle flight fitted from one camera, with explicit quality gates.

This is an original implementation based on published equations, not copied code. It uses a pinhole camera, gravity
with quadratic drag (RK4), robust nonlinear least squares and multiple initialisations, on the TrackNet detections that
passed the shared observed-2d/v1 sanitizer, with the video's presentation timestamps.

A result is "available" only when every gate passes; otherwise it is "rejected" with its reasons and no speed. Even an
available result is an estimate from one camera under stated assumptions: it is not a measurement, not radar-checked and
not ground truth. The Measured 3D tier (two synchronised cameras) is app/physics/stereo.py.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass
from typing import Optional

import numpy as np
from scipy.optimize import least_squares

from app.physics.camera import CameraCalibration, camera_from_document
from app.physics.trajectory import DEFAULT_TERMINAL_VELOCITY_M_S, drag_coefficient, integrate_state, speed_kmh

SCHEMA = "smashlab.estimated-3d/v1"
MODE = "estimated_monocular"
LABEL = "Estimated 3D — monocular experimental"
UNAVAILABLE_LABEL = "Physical trajectory unavailable"
METHOD = "monocular pinhole projection + gravity and quadratic drag (RK4) + robust soft-L1 least squares, multistart"
NET_Y_M = 6.70
MAX_OBSERVATION_SECONDS = 0.70
CONTACT_SHIFTS = (-2, -1, 1, 2)
DRAG_SCALES = {"drag_minus_15pct": 0.85, "drag_plus_15pct": 1.15}
DEFAULT_FOCAL_UNCERTAINTY = 0.01
PRINCIPAL_SHIFT_FRACTION = 0.005
HIGH_QUALITY_MAX_SPREAD = 0.10
HIGH_QUALITY_MAX_RMS_PX = 2.0

# These gates are exercised by backend/tools/benchmark_speed3d.py. They are intentionally
# conservative for 30 FPS data and are reported in every result rather than hidden in a score.
MIN_OBSERVATIONS = 10
MAX_INTERPOLATED_FRACTION = 0.20
MAX_TRACKING_GAP_FRACTION = 0.25
MAX_REPROJECTION_RMS_PX = 4.0
MAX_REPROJECTION_P95_PX = 8.0
MAX_MULTISTART_SPEED_SPREAD = 0.12
MAX_SENSITIVITY_SPEED_SPREAD = 0.20
MIN_SPEED_KMH = 18.0
MAX_SPEED_KMH = 500.0


@dataclass(frozen=True)
class Observation:
    frame: int
    time_s: float
    x: float
    y: float
    confidence: float


@dataclass
class FitCandidate:
    parameters: np.ndarray
    state: np.ndarray
    reference_time_s: float
    rms_px: float
    p95_px: float
    cost: float
    success: bool
    at_bounds: bool
    speed_first_kmh: float
    message: str


def assumptions(terminal_velocity_m_s: float = DEFAULT_TERMINAL_VELOCITY_M_S) -> list[str]:
    return [
        "one pinhole camera from an independent 3D calibration; lens distortion corrected or inside its uncertainty",
        f"gravity {9.80665} m/s2 and quadratic air drag, terminal velocity {terminal_velocity_m_s} m/s "
        f"(drag k {drag_coefficient(terminal_velocity_m_s):.4f} per m; varied by 15 percent in the sensitivity run)",
        "free flight from the contact to the next contact: no wind, no spin, no collision",
        "observations are TrackNet detections that passed observed-2d/v1; InpaintNet fills are never observations",
        "presentation timestamps of the video for time; frame-rate times are not accepted",
        "court frame: x across the court, y along it, z up; net plane y = 6.70 m",
    ]


def _result(status: str, reasons: list[str], gates: list[dict], evidence: dict, calibration: dict, began: float,
            terminal_velocity_m_s: float, *, best: Optional["FitCandidate"] = None, spread: Optional[float] = None,
            sensitivity: Optional[dict] = None, speeds: Optional[list[float]] = None,
            trajectory: Optional[list[dict]] = None, quality: str = "low") -> dict:
    available = status == "available"
    return {
        "schema": SCHEMA,
        "mode": MODE,
        "status": status,
        "label": LABEL if available else UNAVAILABLE_LABEL,
        "trajectory_xyz_m": trajectory if available and trajectory else [],
        "speed_candidate_kmh": round(best.speed_first_kmh, 1) if available and best is not None else None,
        "speed_range_kmh": [round(min(speeds), 1), round(max(speeds), 1)] if available and speeds else None,
        "reprojection_rms_px": None if best is None or not np.isfinite(best.rms_px) else round(best.rms_px, 3),
        "reprojection_p95_px": None if best is None or not np.isfinite(best.p95_px) else round(best.p95_px, 3),
        "parameter_spread_percent": None if spread is None or not np.isfinite(spread) else round(100.0 * spread, 1),
        "quality": quality if available else "low",
        "assumptions": assumptions(terminal_velocity_m_s),
        "rejection_reasons": list(dict.fromkeys(reasons)),
        "gates": gates,
        "sensitivity": sensitivity or {},
        "observations": evidence.get("usable_observations", 0),
        "evidence": evidence,
        "calibration": calibration,
        "method": METHOD,
        "not_measured": True,
        "not_radar_validated": True,
        "runtime_ms": round((time.perf_counter() - began) * 1000, 2),
    }


def observations_from_track(track, contact_frame: int, next_contact_frame: Optional[int] = None,
                            max_seconds: float = MAX_OBSERVATION_SECONDS) -> tuple[list[Observation], dict]:
    """TrackNet detections of the sanitized track from the contact until the next contact or max_seconds later."""
    if contact_frame < 0 or track is None:
        return [], {}
    contact_time = track.time_of(contact_frame)
    last = track.last_frame if track.last_frame is not None else contact_frame
    detected: list[Observation] = []
    kept = interpolated = 0
    end_frame = contact_frame
    for frame in range(contact_frame, last + 1):
        if next_contact_frame is not None and frame >= next_contact_frame:
            break
        if track.time_of(frame) - contact_time > max_seconds + 1e-9:
            break
        end_frame = frame
        point = track.points.get(frame)
        if point is None:
            continue
        kept += 1
        if point.interpolated:
            interpolated += 1
            continue
        detected.append(Observation(frame, track.time_of(frame), point.x, point.y, point.confidence))
    evidence = {
        "contact_frame": contact_frame,
        "contact_time_s": round(contact_time, 6),
        "usable_observations": len(detected),
        "kept_points": kept,
        "interpolated_observations": interpolated,
        "interpolated_fraction": round(interpolated / kept, 4) if kept else None,
        "rejected_by_sanitizer": len(track.rejected_in(contact_frame, end_frame)),
        "first_frame": detected[0].frame if detected else None,
        "last_frame": detected[-1].frame if detected else None,
        "first_time_s": detected[0].time_s if detected else None,
        "last_time_s": detected[-1].time_s if detected else None,
        "timestamp_source": track.timestamp_source,
    }
    if detected:
        expected = detected[-1].frame - detected[0].frame + 1
        evidence["tracking_gap_fraction"] = round(1.0 - len(detected) / expected, 4) if expected > 0 else None
    else:
        evidence["tracking_gap_fraction"] = None
    return detected, evidence


def estimate_monocular(
    *,
    contact: Optional[dict],
    track,
    court_doc: Optional[dict],
    next_contact_frame: Optional[int] = None,
    terminal_velocity_m_s: float = DEFAULT_TERMINAL_VELOCITY_M_S,
    run_sensitivity: bool = True,
) -> dict:
    """The Estimated 3D result of one shot: "available" only when every gate passes, else "rejected" with reasons."""
    began = time.perf_counter()
    gates: list[dict] = []
    reasons: list[str] = []

    def gate(code: str, gate_id: str, passed: bool, value=None, limit=None) -> None:
        gates.append({"id": gate_id, "passed": bool(passed), "value": value, "limit": limit})
        if not passed:
            reasons.append(code)

    status = (contact or {}).get("status")
    contact_frame = int((contact or {}).get("frame", -1))
    gate("contact_not_confirmed", "contact_confirmed", status == "confirmed", status, "confirmed")
    observations, evidence = observations_from_track(track, contact_frame, next_contact_frame)
    timestamp_source = getattr(track, "timestamp_source", None)
    gate("actual_presentation_timestamps_unavailable", "presentation_timestamps", timestamp_source == "presentation_timestamp",
         timestamp_source, "presentation_timestamp")
    gate("too_few_reliable_observations", "min_observations", len(observations) >= MIN_OBSERVATIONS, len(observations), MIN_OBSERVATIONS)
    fraction = evidence.get("interpolated_fraction")
    gate("interpolation_dominates", "max_interpolated_fraction", fraction is None or fraction <= MAX_INTERPOLATED_FRACTION,
         fraction, MAX_INTERPOLATED_FRACTION)
    gap = evidence.get("tracking_gap_fraction")
    gate("tracking_gaps_dominate", "max_tracking_gap_fraction", gap is None or gap <= MAX_TRACKING_GAP_FRACTION, gap,
         MAX_TRACKING_GAP_FRACTION)
    width = int(getattr(track, "width", 0) or 0)
    height = int(getattr(track, "height", 0) or 0)
    camera, calibration = camera_from_document(court_doc, width, height)
    gate("insufficient_3d_camera_calibration", "independent_3d_camera", camera is not None, calibration.get("source"),
         "explicit camera_3d block, independently constrained in 3D")
    if reasons:
        return _result("rejected", reasons, gates, evidence, calibration, began, terminal_velocity_m_s)

    times = np.asarray([item.time_s for item in observations])
    pixels = np.asarray([[item.x, item.y] for item in observations])
    drag_k = drag_coefficient(terminal_velocity_m_s)
    candidates = fit_free_monocular(camera, times, pixels, drag_k)
    valid = [item for item in candidates if item.success and not item.at_bounds and np.isfinite(item.rms_px)]
    gate("optimizer_failed_or_hit_bounds", "optimizer", bool(valid), len(valid), ">= 1 converged start inside the bounds")
    if not valid:
        return _result("rejected", reasons, gates, evidence, calibration, began, terminal_velocity_m_s)
    valid.sort(key=lambda item: item.cost)
    best = valid[0]
    competitive = [item for item in valid if item.cost <= best.cost * 1.25 + 1e-9]
    multistart_spread = _relative_spread([item.speed_first_kmh for item in competitive])
    gate("excessive_reprojection_error", "reprojection_rms_px", best.rms_px <= MAX_REPROJECTION_RMS_PX, round(best.rms_px, 3),
         MAX_REPROJECTION_RMS_PX)
    gate("excessive_reprojection_error", "reprojection_p95_px", best.p95_px <= MAX_REPROJECTION_P95_PX, round(best.p95_px, 3),
         MAX_REPROJECTION_P95_PX)
    gate("inconsistent_valid_initializations", "multistart_spread", multistart_spread <= MAX_MULTISTART_SPEED_SPREAD,
         round(multistart_spread, 4), MAX_MULTISTART_SPEED_SPREAD)
    gate("physically_implausible_speed", "plausible_speed", MIN_SPEED_KMH <= best.speed_first_kmh <= MAX_SPEED_KMH,
         round(best.speed_first_kmh, 1), [MIN_SPEED_KMH, MAX_SPEED_KMH])

    speeds = [best.speed_first_kmh]
    sensitivity: dict = {"run": False}
    if run_sensitivity:
        speeds, sensitivity = _sensitivity_scenarios(camera, track, contact_frame, next_contact_frame, times, pixels,
                                                     terminal_velocity_m_s, best)
        spread = _relative_spread(speeds)
        gate("camera_or_drag_sensitivity_unstable", "sensitivity_spread",
             spread <= MAX_SENSITIVITY_SPEED_SPREAD and not sensitivity["failed"], round(spread, 4), MAX_SENSITIVITY_SPEED_SPREAD)
    spread = _relative_spread(speeds)
    evidence.update(_fit_evidence(best, len(valid), multistart_spread, sensitivity))
    if reasons:
        return _result("rejected", reasons, gates, evidence, calibration, began, terminal_velocity_m_s, best=best, spread=spread,
                       sensitivity=sensitivity)

    series = integrate_state(best.state, best.reference_time_s, times, drag_k)
    stride = max(1, len(times) // 12)
    trajectory = [
        {"time_s": round(float(t), 5), "x": round(float(state[0]), 4), "y": round(float(state[1]), 4), "z": round(float(state[2]), 4)}
        for t, state in zip(times[::stride], series[::stride])
    ]
    net_state, net_time = _net_crossing(best.state, best.reference_time_s, float(times[0]), float(times[-1]) + 0.35, drag_k)
    evidence["speed_at_net_kmh"] = None if net_state is None else round(speed_kmh(net_state), 1)
    evidence["speed_at_net_time_s"] = None if net_time is None else round(net_time, 5)
    quality = "high" if spread <= HIGH_QUALITY_MAX_SPREAD and best.rms_px <= HIGH_QUALITY_MAX_RMS_PX else "medium"
    return _result("available", [], gates, evidence, calibration, began, terminal_velocity_m_s, best=best, spread=spread,
                   sensitivity=sensitivity, speeds=speeds, trajectory=trajectory, quality=quality)


def _sensitivity_scenarios(camera, track, contact_frame, next_contact_frame, times, pixels, terminal_velocity, best):
    """Refits under changed assumptions. Every speed is taken at the baseline's first observation time."""
    reference_time = float(times[0])
    focal = float(camera.focal_uncertainty_fraction or DEFAULT_FOCAL_UNCERTAINTY)
    dx, dy = PRINCIPAL_SHIFT_FRACTION * camera.width, PRINCIPAL_SHIFT_FRACTION * camera.height
    runs: dict[str, tuple] = {
        f"focal_minus_{focal * 100:g}pct": (camera.with_focal_scale(1.0 - focal), times, pixels, terminal_velocity),
        f"focal_plus_{focal * 100:g}pct": (camera.with_focal_scale(1.0 + focal), times, pixels, terminal_velocity),
        "principal_point_x_minus": (camera.with_principal_shift(-dx, 0.0), times, pixels, terminal_velocity),
        "principal_point_x_plus": (camera.with_principal_shift(dx, 0.0), times, pixels, terminal_velocity),
        "principal_point_y_minus": (camera.with_principal_shift(0.0, -dy), times, pixels, terminal_velocity),
        "principal_point_y_plus": (camera.with_principal_shift(0.0, dy), times, pixels, terminal_velocity),
    }
    for name, scale in DRAG_SCALES.items():
        runs[name] = (camera, times, pixels, terminal_velocity / math.sqrt(scale))
    not_applicable: list[str] = []
    first_frame = min(track.points) if getattr(track, "points", None) else 0
    for shift in CONTACT_SHIFTS:
        name = f"contact_{shift:+d}_frames"
        if contact_frame + shift < min(0, first_frame) or contact_frame + shift < 0:
            not_applicable.append(name)  # the video has no frame there: nothing to test, nothing unstable
            continue
        shifted, _evidence = observations_from_track(track, contact_frame + shift, next_contact_frame)
        if len(shifted) < MIN_OBSERVATIONS:
            runs[name] = None
            continue
        runs[name] = (camera, np.asarray([item.time_s for item in shifted]), np.asarray([[item.x, item.y] for item in shifted]),
                      terminal_velocity)
    keep = [index for index in range(len(times)) if index % 3 != 2]
    runs["missing_every_third_point"] = (camera, times[keep], pixels[keep], terminal_velocity) if len(keep) >= 4 else None
    runs["missing_first_two_points"] = (camera, times[2:], pixels[2:], terminal_velocity) if len(times) >= 6 else None

    speeds = [best.speed_first_kmh]
    values: dict = {"baseline_kmh": round(best.speed_first_kmh, 3)}
    failed: list[str] = []
    for name, run in runs.items():
        if run is None:
            values[name] = None
            failed.append(name)
            continue
        scenario_camera, scenario_times, scenario_pixels, scenario_terminal = run
        drag = drag_coefficient(scenario_terminal)
        fitted = fit_free_monocular(scenario_camera, scenario_times, scenario_pixels, drag, initial_parameters=best.parameters)
        valid = [item for item in fitted if item.success and not item.at_bounds and np.isfinite(item.cost)]
        if not valid:
            fitted = fit_free_monocular(scenario_camera, scenario_times, scenario_pixels, drag)
            valid = [item for item in fitted if item.success and not item.at_bounds and np.isfinite(item.cost)]
        if not valid:
            values[name] = None
            failed.append(name)
            continue
        chosen = min(valid, key=lambda item: item.cost)
        state = integrate_state(chosen.state, chosen.reference_time_s, np.array([reference_time]), drag)[0]
        value = speed_kmh(state)
        speeds.append(value)
        values[name] = round(value, 3)
    for name in not_applicable:
        values[name] = "not_applicable"
    return speeds, {"run": True, "reference_time_s": round(reference_time, 6), "scenarios": values, "failed": failed,
                    "not_applicable": not_applicable, "spread_fraction": round(_relative_spread(speeds), 5)}


def select_observations(shuttle_frames: list, contact_frame: int, next_contact_frame: Optional[int], max_seconds: float = 0.70) -> tuple[list[Observation], dict]:
    detected = []
    visible = 0
    refined = 0
    contact_time = None
    for item in shuttle_frames:
        frame = int(item.get("frame", -1))
        if frame == contact_frame:
            contact_time = item.get("time_s")
        if frame < contact_frame:
            continue
        if next_contact_frame is not None and frame >= next_contact_frame:
            break
        time_s = item.get("time_s")
        if contact_time is not None and time_s is not None and float(time_s) - float(contact_time) > max_seconds:
            break
        if not item.get("visible") or item.get("x") is None or item.get("y") is None or time_s is None:
            continue
        visible += 1
        if item.get("refined"):
            refined += 1
            continue
        detected.append(Observation(frame, float(time_s), float(item["x"]), float(item["y"]), float(item.get("confidence") or 0.0)))
    details = {
        "contact_frame": contact_frame,
        "contact_time_s": None if contact_time is None else float(contact_time),
        "usable_observations": len(detected),
        "visible_observations": visible,
        "interpolated_observations": refined,
        "interpolated_fraction": round(refined / visible, 4) if visible else None,
        "first_frame": detected[0].frame if detected else None,
        "last_frame": detected[-1].frame if detected else None,
        "first_time_s": detected[0].time_s if detected else None,
        "last_time_s": detected[-1].time_s if detected else None,
    }
    if detected:
        expected = detected[-1].frame - detected[0].frame + 1
        details["tracking_gap_fraction"] = round(1.0 - len(detected) / expected, 4) if expected > 0 else None
    else:
        details["tracking_gap_fraction"] = None
    return detected, details


def fit_free_monocular(
    camera: CameraCalibration,
    times: np.ndarray,
    pixels: np.ndarray,
    drag_k: float,
    initial_parameters: Optional[np.ndarray] = None,
) -> list[FitCandidate]:
    reference_time = float(times[0])
    first_ray = camera.world_ray(tuple(pixels[0]))
    last_ray = camera.world_ray(tuple(pixels[-1]))
    elapsed = max(1e-3, float(times[-1] - times[0]))
    lower = np.array([2.0, -120.0, -120.0, -60.0])
    upper = np.array([60.0, 120.0, 120.0, 80.0])
    if initial_parameters is not None:
        starts = [np.clip(np.asarray(initial_parameters, dtype=float), lower + 1e-5, upper - 1e-5)]
    else:
        starts = []
        for distance in (5.0, 10.0, 20.0, 40.0):
            displacement = distance * (last_ray - first_ray)
            velocity = displacement / elapsed
            starts.append(np.concatenate([[distance], np.clip(velocity, lower[1:] + 1, upper[1:] - 1)]))
        starts.extend([
            np.array([10.0, 0.0, 22.0 if first_ray[1] >= 0 else -22.0, 5.0]),
            np.array([24.0, 0.0, 35.0 if first_ray[1] >= 0 else -35.0, 8.0]),
        ])

    def state_from(params: np.ndarray) -> np.ndarray:
        position = camera.camera_center_m + params[0] * first_ray
        return np.concatenate([position, params[1:]])

    def residual(params: np.ndarray) -> np.ndarray:
        states = integrate_state(state_from(params), reference_time, times, drag_k)
        projected, depth = camera.project(states[:, :3])
        errors = (projected - pixels).reshape(-1)
        if np.any(depth <= 0) or not np.all(np.isfinite(errors)):
            return np.full(pixels.size, 1e4)
        return errors

    return [_optimise(start, lower, upper, state_from, residual, reference_time, pixels) for start in starts]


def fit_net_plane(camera: CameraCalibration, times: np.ndarray, pixels: np.ndarray, drag_k: float, seed: FitCandidate) -> list[FitCandidate]:
    """Fit a state constrained to the badminton net plane ``y=6.70 m``."""
    crossing, crossing_time = _net_crossing(seed.state, seed.reference_time_s, float(times[0]) - 0.4, float(times[-1]) + 0.4, drag_k)
    if crossing is None or crossing_time is None:
        return []
    lower = np.array([0.0, 0.5, -120.0, -120.0, -60.0, float(times[0]) - 0.8])
    upper = np.array([6.10, 6.0, 120.0, 120.0, 80.0, float(times[-1]) + 0.8])
    base = np.array([crossing[0], crossing[2], crossing[3], crossing[4], crossing[5], crossing_time])
    starts = [base]
    for dx in (-0.4, 0.4):
        for dz in (-0.35, 0.35):
            starts.append(np.clip(base + np.array([dx, dz, 0, 0, 0, 0]), lower + 1e-5, upper - 1e-5))

    def state_from(params: np.ndarray) -> np.ndarray:
        return np.array([params[0], NET_Y_M, params[1], params[2], params[3], params[4]])

    def residual(params: np.ndarray) -> np.ndarray:
        states = integrate_state(state_from(params), float(params[5]), times, drag_k)
        projected, depth = camera.project(states[:, :3])
        errors = (projected - pixels).reshape(-1)
        if np.any(depth <= 0) or not np.all(np.isfinite(errors)):
            return np.full(pixels.size, 1e4)
        return errors

    results = []
    for start in starts:
        candidate = _optimise(start, lower, upper, state_from, residual, float(start[5]), pixels)
        candidate.reference_time_s = float(candidate.parameters[5])
        results.append(candidate)
    return results


def _optimise(start, lower, upper, state_from, residual, reference_time, pixels) -> FitCandidate:
    try:
        result = least_squares(
            residual,
            np.asarray(start, dtype=float),
            bounds=(lower, upper),
            method="trf",
            loss="soft_l1",
            f_scale=4.0,
            x_scale="jac",
            max_nfev=350,
        )
        errors = residual(result.x).reshape(-1, 2)
        norms = np.linalg.norm(errors, axis=1)
        state = state_from(result.x)
        tolerance = 1e-3 * np.maximum(1.0, upper - lower)
        at_bounds = bool(np.any(result.x - lower <= tolerance) or np.any(upper - result.x <= tolerance))
        return FitCandidate(
            parameters=result.x,
            state=state,
            reference_time_s=reference_time,
            rms_px=float(np.sqrt(np.mean(norms**2))),
            p95_px=float(np.percentile(norms, 95)),
            cost=float(result.cost),
            success=bool(result.success),
            at_bounds=at_bounds,
            speed_first_kmh=speed_kmh(state),
            message=str(result.message),
        )
    except (ValueError, np.linalg.LinAlgError, FloatingPointError) as exc:
        return FitCandidate(np.asarray(start), np.zeros(6), reference_time, math.inf, math.inf, math.inf, False, False, math.inf, str(exc))


def _net_crossing(state, reference_time, start_time, end_time, drag_k):
    times = np.linspace(start_time, end_time, max(20, int((end_time - start_time) * 480)))
    states = integrate_state(state, reference_time, times, drag_k)
    values = states[:, 1] - NET_Y_M
    for index in range(len(values) - 1):
        if values[index] == 0 or values[index] * values[index + 1] < 0:
            ratio = abs(values[index]) / max(1e-12, abs(values[index]) + abs(values[index + 1]))
            time_value = float(times[index] + ratio * (times[index + 1] - times[index]))
            crossing = integrate_state(state, reference_time, np.array([time_value]), drag_k)[0]
            return crossing, time_value
    return None, None


def _fit_evidence(best, valid_starts, spread, sensitivity):
    return {
        "optimizer": "scipy.optimize.least_squares (TRF, soft_l1, f_scale=4 px)",
        "valid_initializations": valid_starts,
        "reprojection_rms_px": round(best.rms_px, 4),
        "reprojection_p95_px": round(best.p95_px, 4),
        "multistart_speed_spread_fraction": round(spread, 5),
        "sensitivity": sensitivity,
    }


def _relative_spread(values: list[float]) -> float:
    finite = [float(value) for value in values if np.isfinite(value)]
    if len(finite) < 2:
        return 0.0
    median = float(np.median(finite))
    return (max(finite) - min(finite)) / median if median > 0 else math.inf


def _estimated_fps(observations: list[Observation]) -> float:
    if len(observations) < 2:
        return 0.0
    delta = np.diff([item.time_s for item in observations])
    positive = delta[delta > 0]
    return 1.0 / float(np.median(positive)) if len(positive) else 0.0
