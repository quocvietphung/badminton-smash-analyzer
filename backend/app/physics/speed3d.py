"""Experimental monocular 3D shuttle-speed fitting with explicit quality gates.

This is an original implementation based on published equations, not copied code. It
uses a pinhole camera, quadratic drag, RK4, robust nonlinear least squares and multiple
initialisations. A result is deliberately unavailable unless all evidence gates pass.
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

LABEL = "Experimental 3D Speed Estimate — Not Radar Validated"
UNAVAILABLE_LABEL = "Physical speed unavailable"
METHOD = "monocular pinhole projection + quadratic drag RK4 + robust soft-L1 least squares"
NET_Y_M = 6.70

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


def unavailable(reasons: list[str], *, evidence: Optional[dict] = None, calibration: Optional[dict] = None, runtime_ms: float = 0.0) -> dict:
    return {
        "status": "unavailable",
        "label": UNAVAILABLE_LABEL,
        "not_radar_validated": True,
        "reason_codes": list(dict.fromkeys(reasons)),
        "speed_first_observed_kmh": None,
        "speed_at_net_kmh": None,
        "speed_at_contact_extrapolated_kmh": None,
        "uncertainty_kmh": None,
        "method": METHOD,
        "evidence": evidence or {},
        "calibration": calibration or {},
        "assumptions": _assumptions(),
        "quality": {"passed": False},
        "runtime_ms": round(runtime_ms, 2),
    }


def _assumptions(terminal_velocity_m_s: float = DEFAULT_TERMINAL_VELOCITY_M_S) -> dict:
    return {
        "gravity_m_s2": 9.80665,
        "quadratic_drag": True,
        "terminal_velocity_m_s": terminal_velocity_m_s,
        "drag_k_per_m": round(drag_coefficient(terminal_velocity_m_s), 6),
        "camera_model": "pinhole; lens distortion must already be corrected or included in calibration uncertainty",
        "court_coordinates": "x across court, y along court, z upward; net plane y=6.70 m",
    }


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


def estimate_shot_speed(
    *,
    contact: Optional[dict],
    shuttle_doc: Optional[dict],
    court_doc: Optional[dict],
    width: int,
    height: int,
    next_contact_frame: Optional[int] = None,
    terminal_velocity_m_s: float = DEFAULT_TERMINAL_VELOCITY_M_S,
    run_sensitivity: bool = True,
) -> dict:
    began = time.perf_counter()
    reasons = []
    if contact is None or contact.get("status") != "confirmed":
        reasons.append("contact_not_confirmed")
    frames = (shuttle_doc or {}).get("frames", [])
    contact_frame = int((contact or {}).get("frame", -1))
    observations, evidence = select_observations(frames, contact_frame, next_contact_frame) if contact_frame >= 0 else ([], {})
    timing_source = (shuttle_doc or {}).get("timestamp_source", "frame_rate_derived")
    evidence["timestamp_source"] = timing_source
    if timing_source != "presentation_timestamp":
        reasons.append("actual_presentation_timestamps_unavailable")
    if len(observations) < MIN_OBSERVATIONS:
        reasons.append("too_few_reliable_observations")
    if evidence.get("interpolated_fraction") is not None and evidence["interpolated_fraction"] > MAX_INTERPOLATED_FRACTION:
        reasons.append("interpolation_dominates")
    if evidence.get("tracking_gap_fraction") is not None and evidence["tracking_gap_fraction"] > MAX_TRACKING_GAP_FRACTION:
        reasons.append("tracking_gaps_dominate")

    camera, calibration = camera_from_document(court_doc, width, height)
    if camera is None:
        reasons.append("insufficient_3d_camera_calibration")
    if reasons:
        return unavailable(reasons, evidence=evidence, calibration=calibration, runtime_ms=(time.perf_counter() - began) * 1000)

    times = np.asarray([item.time_s for item in observations])
    pixels = np.asarray([[item.x, item.y] for item in observations])
    drag_k = drag_coefficient(terminal_velocity_m_s)
    candidates = fit_free_monocular(camera, times, pixels, drag_k)
    valid = [item for item in candidates if item.success and not item.at_bounds and np.isfinite(item.rms_px)]
    if not valid:
        return unavailable(["optimizer_failed_or_hit_bounds"], evidence=evidence, calibration=calibration, runtime_ms=(time.perf_counter() - began) * 1000)
    valid.sort(key=lambda item: item.cost)
    best = valid[0]
    competitive = [item for item in valid if item.cost <= best.cost * 1.25 + 1e-9]
    speeds = [item.speed_first_kmh for item in competitive]
    multistart_spread = _relative_spread(speeds)
    quality_reasons = []
    if best.rms_px > MAX_REPROJECTION_RMS_PX or best.p95_px > MAX_REPROJECTION_P95_PX:
        quality_reasons.append("excessive_reprojection_error")
    if multistart_spread > MAX_MULTISTART_SPEED_SPREAD:
        quality_reasons.append("inconsistent_valid_initializations")
    if not MIN_SPEED_KMH <= best.speed_first_kmh <= MAX_SPEED_KMH:
        quality_reasons.append("physically_implausible_speed")

    sensitivity_speeds = list(speeds)
    sensitivity = {}
    if run_sensitivity:
        sensitivity_speeds, sensitivity = _sensitivity(camera, times, pixels, terminal_velocity_m_s, best)
        if _relative_spread(sensitivity_speeds) > MAX_SENSITIVITY_SPEED_SPREAD:
            quality_reasons.append("camera_or_drag_sensitivity_unstable")
    if quality_reasons:
        evidence.update(_fit_evidence(best, len(valid), multistart_spread, sensitivity))
        return unavailable(quality_reasons, evidence=evidence, calibration=calibration, runtime_ms=(time.perf_counter() - began) * 1000)

    state_series = integrate_state(best.state, best.reference_time_s, times, drag_k)
    net_state, net_time = _net_crossing(best.state, best.reference_time_s, float(times[0]), float(times[-1]) + 0.35, drag_k)
    contact_time = evidence.get("contact_time_s")
    contact_state = None
    if contact_time is not None and abs(float(times[0]) - float(contact_time)) <= 2.0 / max(1.0, _estimated_fps(observations)):
        contact_state = integrate_state(best.state, best.reference_time_s, np.array([float(contact_time)]), drag_k)[0]
    uncertainty_values = sensitivity_speeds or speeds
    lower, upper = min(uncertainty_values), max(uncertainty_values)
    evidence.update(_fit_evidence(best, len(valid), multistart_spread, sensitivity))
    evidence["measurement_time_s"] = float(times[0])
    evidence["measurement_frame"] = observations[0].frame
    evidence["fitted_positions_m"] = [
        {"time_s": round(float(t), 5), "x": round(float(state[0]), 4), "y": round(float(state[1]), 4), "z": round(float(state[2]), 4)}
        for t, state in zip(times[:: max(1, len(times) // 8)], state_series[:: max(1, len(times) // 8)])
    ]
    return {
        "status": "available",
        "label": LABEL,
        "not_radar_validated": True,
        "reason_codes": [],
        "speed_first_observed_kmh": round(best.speed_first_kmh, 1),
        "speed_at_net_kmh": None if net_state is None else round(speed_kmh(net_state), 1),
        "speed_at_net_time_s": None if net_time is None else round(net_time, 5),
        "speed_at_contact_extrapolated_kmh": None if contact_state is None else round(speed_kmh(contact_state), 1),
        "uncertainty_kmh": [round(lower, 1), round(upper, 1)],
        "method": METHOD,
        "evidence": evidence,
        "calibration": calibration,
        "assumptions": _assumptions(terminal_velocity_m_s),
        "quality": {
            "passed": True,
            "reprojection_rms_px": round(best.rms_px, 3),
            "reprojection_p95_px": round(best.p95_px, 3),
            "multistart_speed_spread_fraction": round(multistart_spread, 4),
            "sensitivity_speed_spread_fraction": round(_relative_spread(sensitivity_speeds), 4),
        },
        "runtime_ms": round((time.perf_counter() - began) * 1000, 2),
    }


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


def _sensitivity(camera, times, pixels, terminal_velocity, best) -> tuple[list[float], dict]:
    scenarios = {
        "drag_minus_15pct": (camera, terminal_velocity / math.sqrt(0.85)),
        "drag_plus_15pct": (camera, terminal_velocity / math.sqrt(1.15)),
        "focal_minus_1pct": (camera.with_focal_scale(0.99), terminal_velocity),
        "focal_plus_1pct": (camera.with_focal_scale(1.01), terminal_velocity),
    }
    speeds = [best.speed_first_kmh]
    values = {"baseline_kmh": round(best.speed_first_kmh, 3)}
    for name, (scenario_camera, scenario_terminal) in scenarios.items():
        fitted = fit_free_monocular(
            scenario_camera,
            times,
            pixels,
            drag_coefficient(scenario_terminal),
            initial_parameters=best.parameters,
        )
        valid = [item for item in fitted if item.success and not item.at_bounds and np.isfinite(item.cost)]
        if not valid:
            values[name] = None
            continue
        value = min(valid, key=lambda item: item.cost).speed_first_kmh
        speeds.append(value)
        values[name] = round(value, 3)
    values["spread_fraction"] = round(_relative_spread(speeds), 5)
    return speeds, values


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
