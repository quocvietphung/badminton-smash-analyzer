"""Measured 3D — stereo: shuttle positions triangulated from two synchronised, calibrated cameras.

The built-in samples come from one camera each, so this tier is reported as NOT RUN for them, and a second camera is
never simulated for real footage. This module holds the interface and the algorithms; synthetic ground-truth tests
exercise them (backend/tests/test_stereo.py):

- camera intrinsics with Brown-Conrady distortion (k1, k2, p1, p2, k3) and extrinsics (world-to-camera rotation, centre);
- timestamp synchronisation of the two streams with a known clock offset and a tolerance;
- epipolar matching of candidate detections with the fundamental matrix of the two cameras;
- linear triangulation (DLT) on undistorted, normalised coordinates;
- checks per point: positive depth in both cameras, a minimum angle between the two rays, reprojection error in both
  images (with distortion);
- physics smoothing: one gravity + quadratic-drag flight fitted to the accepted 3D points.

Units: metres and seconds in the court frame (x across, y along, z up). Speeds in km/h appear only from accepted
triangulated points.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Optional, Sequence

import numpy as np
from scipy.optimize import least_squares

from app.physics.trajectory import DEFAULT_TERMINAL_VELOCITY_M_S, drag_coefficient, integrate_state, speed_kmh

SCHEMA = "smashlab.measured-3d/v1"
MODE = "measured_stereo"
LABEL = "Measured 3D — stereo"
NOT_RUN_LABEL = "Measured 3D: NOT RUN — stereo input unavailable"
NOT_RUN_REASON = "stereo input unavailable: this analysis has one camera; two synchronised, calibrated cameras are required"


@dataclass(frozen=True)
class StereoCamera:
    """``q = K * distort(R (p - C))``, distortion (k1, k2, p1, p2, k3) on normalised coordinates."""

    name: str
    intrinsic: np.ndarray
    rotation_world_to_camera: np.ndarray
    camera_center_m: np.ndarray
    width: int
    height: int
    distortion: tuple = (0.0, 0.0, 0.0, 0.0, 0.0)

    def __post_init__(self) -> None:
        object.__setattr__(self, "intrinsic", np.asarray(self.intrinsic, dtype=float).reshape(3, 3))
        object.__setattr__(self, "rotation_world_to_camera", np.asarray(self.rotation_world_to_camera, dtype=float).reshape(3, 3))
        object.__setattr__(self, "camera_center_m", np.asarray(self.camera_center_m, dtype=float).reshape(3))
        object.__setattr__(self, "distortion", tuple(float(value) for value in self.distortion) + (0.0,) * (5 - len(self.distortion)))

    def to_camera(self, points_world) -> np.ndarray:
        points = np.atleast_2d(np.asarray(points_world, dtype=float))
        return (self.rotation_world_to_camera @ (points - self.camera_center_m).T).T

    def project(self, points_world) -> tuple[np.ndarray, np.ndarray]:
        camera = self.to_camera(points_world)
        depth = camera[:, 2]
        pixels = np.full((len(camera), 2), np.nan)
        valid = depth > 1e-9
        normalised = camera[valid, :2] / camera[valid, 2:3]
        distorted = distort(normalised, self.distortion)
        homogeneous = np.column_stack([distorted, np.ones(len(distorted))]) @ self.intrinsic.T
        pixels[valid] = homogeneous[:, :2]
        return pixels, depth

    def undistorted_normalised(self, pixels) -> np.ndarray:
        points = np.atleast_2d(np.asarray(pixels, dtype=float))
        homogeneous = np.column_stack([points, np.ones(len(points))]) @ np.linalg.inv(self.intrinsic).T
        return undistort(homogeneous[:, :2], self.distortion)

    def ideal_pixels(self, pixels) -> np.ndarray:
        """Pixels with the lens distortion removed (as a perfect pinhole camera would have seen them)."""
        normalised = self.undistorted_normalised(pixels)
        return (np.column_stack([normalised, np.ones(len(normalised))]) @ self.intrinsic.T)[:, :2]

    def ray(self, pixel) -> np.ndarray:
        normalised = self.undistorted_normalised(pixel)[0]
        direction = self.rotation_world_to_camera.T @ np.array([normalised[0], normalised[1], 1.0])
        return direction / np.linalg.norm(direction)


def distort(normalised: np.ndarray, coefficients: Sequence[float]) -> np.ndarray:
    k1, k2, p1, p2, k3 = coefficients
    x, y = normalised[:, 0], normalised[:, 1]
    r2 = x * x + y * y
    radial = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 ** 3
    xd = x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x)
    yd = y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y
    return np.column_stack([xd, yd])


def undistort(distorted: np.ndarray, coefficients: Sequence[float], iterations: int = 30) -> np.ndarray:
    """Fixed-point inversion of ``distort``; converges for the moderate distortion of sports cameras."""
    k1, k2, p1, p2, k3 = coefficients
    x, y = distorted[:, 0].copy(), distorted[:, 1].copy()
    for _ in range(iterations):
        r2 = x * x + y * y
        radial = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 ** 3
        dx = 2 * p1 * x * y + p2 * (r2 + 2 * x * x)
        dy = p1 * (r2 + 2 * y * y) + 2 * p2 * x * y
        x = (distorted[:, 0] - dx) / radial
        y = (distorted[:, 1] - dy) / radial
    return np.column_stack([x, y])


def _skew(vector: np.ndarray) -> np.ndarray:
    return np.array([[0.0, -vector[2], vector[1]], [vector[2], 0.0, -vector[0]], [-vector[1], vector[0], 0.0]])


def fundamental_matrix(camera_a: StereoCamera, camera_b: StereoCamera) -> np.ndarray:
    """F with ``x_b^T F x_a = 0`` for ideal (undistorted) pixels of the same world point."""
    rotation = camera_b.rotation_world_to_camera @ camera_a.rotation_world_to_camera.T
    translation = camera_b.rotation_world_to_camera @ (camera_a.camera_center_m - camera_b.camera_center_m)
    essential = _skew(translation) @ rotation
    return np.linalg.inv(camera_b.intrinsic).T @ essential @ np.linalg.inv(camera_a.intrinsic)


def epipolar_distance(fundamental: np.ndarray, ideal_a, ideal_b) -> float:
    """Symmetric point-to-epipolar-line distance in ideal pixels (the larger of the two images)."""
    a = np.array([ideal_a[0], ideal_a[1], 1.0])
    b = np.array([ideal_b[0], ideal_b[1], 1.0])
    line_b = fundamental @ a
    line_a = fundamental.T @ b
    distance_b = abs(float(b @ line_b)) / max(1e-12, math.hypot(line_b[0], line_b[1]))
    distance_a = abs(float(a @ line_a)) / max(1e-12, math.hypot(line_a[0], line_a[1]))
    return max(distance_a, distance_b)


def synchronize(times_a: Sequence[float], times_b: Sequence[float], *, offset_s: float = 0.0,
                tolerance_s: float) -> list[tuple[int, int, float]]:
    """Pairs (index a, index b, time difference) after shifting b by ``offset_s``; each index is used once."""
    shifted = [float(value) + offset_s for value in times_b]
    candidates = sorted(
        ((abs(float(ta) - tb), ia, ib, float(ta) - tb) for ia, ta in enumerate(times_a) for ib, tb in enumerate(shifted)
         if abs(float(ta) - tb) <= tolerance_s),
        key=lambda item: item[0],
    )
    used_a: set[int] = set()
    used_b: set[int] = set()
    pairs = []
    for _distance, ia, ib, difference in candidates:
        if ia in used_a or ib in used_b:
            continue
        used_a.add(ia)
        used_b.add(ib)
        pairs.append((ia, ib, difference))
    return sorted(pairs)


def match_epipolar(camera_a: StereoCamera, camera_b: StereoCamera, candidates_a, candidates_b,
                   max_px: float) -> list[tuple[int, int, float]]:
    """Greedy one-to-one matches of candidate detections by epipolar distance, at most ``max_px``."""
    if not len(candidates_a) or not len(candidates_b):
        return []
    fundamental = fundamental_matrix(camera_a, camera_b)
    ideal_a = camera_a.ideal_pixels(candidates_a)
    ideal_b = camera_b.ideal_pixels(candidates_b)
    scored = sorted(
        (epipolar_distance(fundamental, ideal_a[ia], ideal_b[ib]), ia, ib)
        for ia in range(len(ideal_a)) for ib in range(len(ideal_b))
    )
    used_a: set[int] = set()
    used_b: set[int] = set()
    matches = []
    for distance, ia, ib in scored:
        if distance > max_px:
            break
        if ia in used_a or ib in used_b:
            continue
        used_a.add(ia)
        used_b.add(ib)
        matches.append((ia, ib, distance))
    return matches


def triangulate(camera_a: StereoCamera, camera_b: StereoCamera, pixel_a, pixel_b) -> dict:
    """DLT triangulation of one correspondence, with depth, ray angle and reprojection errors."""
    rows = []
    for camera, pixel in ((camera_a, pixel_a), (camera_b, pixel_b)):
        x, y = camera.undistorted_normalised(pixel)[0]
        projection = np.hstack([camera.rotation_world_to_camera, (-camera.rotation_world_to_camera @ camera.camera_center_m)[:, None]])
        rows.append(x * projection[2] - projection[0])
        rows.append(y * projection[2] - projection[1])
    _u, _s, vt = np.linalg.svd(np.asarray(rows))
    homogeneous = vt[-1]
    point = homogeneous[:3] / homogeneous[3] if abs(homogeneous[3]) > 1e-12 else np.full(3, np.nan)
    depth_a = float(camera_a.to_camera(point)[0, 2])
    depth_b = float(camera_b.to_camera(point)[0, 2])
    ray_a = point - camera_a.camera_center_m
    ray_b = point - camera_b.camera_center_m
    cosine = float(np.dot(ray_a, ray_b) / max(1e-12, np.linalg.norm(ray_a) * np.linalg.norm(ray_b)))
    angle = math.degrees(math.acos(max(-1.0, min(1.0, cosine))))
    errors = []
    for camera, pixel in ((camera_a, pixel_a), (camera_b, pixel_b)):
        projected, depth = camera.project(point)
        errors.append(float(np.linalg.norm(projected[0] - np.asarray(pixel, dtype=float))) if depth[0] > 0 else math.inf)
    return {"point": point, "depth_a": depth_a, "depth_b": depth_b, "ray_angle_deg": angle, "reprojection_px": errors}


@dataclass(frozen=True)
class StereoConfig:
    sync_tolerance_s: float = 0.004       # pairs further apart in time than this are not used
    max_epipolar_px: float = 3.0          # candidates further from the epipolar line are not a match
    min_ray_angle_deg: float = 2.0        # rays closer to parallel than this give no usable depth
    max_reprojection_px: float = 2.0      # a triangulated point must reproject within this in both images
    min_points: int = 8                   # accepted 3D points needed for a flight
    max_physics_rms_m: float = 0.05       # the gravity + drag flight must pass within this of the points
    terminal_velocity_m_s: float = DEFAULT_TERMINAL_VELOCITY_M_S


@dataclass
class StereoObservation:
    time_s: float
    candidates: list = field(default_factory=list)  # [(x, y), ...] detections of one frame


def physics_smooth(times: np.ndarray, points: np.ndarray, terminal_velocity_m_s: float) -> dict:
    """One gravity + quadratic-drag flight through the 3D points (least squares on the state at the first time)."""
    drag = drag_coefficient(terminal_velocity_m_s)
    reference = float(times[0])
    span = max(1e-3, float(times[min(2, len(times) - 1)] - times[0]))
    start = np.concatenate([points[0], (points[min(2, len(points) - 1)] - points[0]) / span])

    def residual(state: np.ndarray) -> np.ndarray:
        return (integrate_state(state, reference, times, drag)[:, :3] - points).reshape(-1)

    fitted = least_squares(residual, start, method="lm", max_nfev=2000)
    states = integrate_state(fitted.x, reference, times, drag)
    errors = np.linalg.norm(states[:, :3] - points, axis=1)
    return {"state": fitted.x, "positions": states[:, :3], "rms_m": float(np.sqrt(np.mean(errors ** 2))),
            "speed_first_kmh": speed_kmh(fitted.x), "success": bool(fitted.success)}


def measure_stereo(camera_a: StereoCamera, camera_b: StereoCamera, stream_a: Sequence[StereoObservation],
                   stream_b: Sequence[StereoObservation], *, offset_s: float = 0.0, config: StereoConfig = StereoConfig()) -> dict:
    """The Measured 3D result of one flight from two streams: "available" or "rejected" with reasons."""
    reasons: list[str] = []
    pairs = synchronize([item.time_s for item in stream_a], [item.time_s for item in stream_b], offset_s=offset_s,
                        tolerance_s=config.sync_tolerance_s)
    rejected = {"no_epipolar_match": 0, "non_positive_depth": 0, "ray_angle_below_minimum": 0, "reprojection_error": 0}
    accepted_times: list[float] = []
    accepted_points: list[np.ndarray] = []
    reprojection: list[float] = []
    angles: list[float] = []
    for ia, ib, _difference in pairs:
        matches = match_epipolar(camera_a, camera_b, stream_a[ia].candidates, stream_b[ib].candidates, config.max_epipolar_px)
        if not matches:
            rejected["no_epipolar_match"] += 1
            continue
        ma, mb, _distance = matches[0]
        result = triangulate(camera_a, camera_b, stream_a[ia].candidates[ma], stream_b[ib].candidates[mb])
        if result["depth_a"] <= 0 or result["depth_b"] <= 0 or not np.all(np.isfinite(result["point"])):
            rejected["non_positive_depth"] += 1
            continue
        if result["ray_angle_deg"] < config.min_ray_angle_deg:
            rejected["ray_angle_below_minimum"] += 1
            continue
        if max(result["reprojection_px"]) > config.max_reprojection_px:
            rejected["reprojection_error"] += 1
            continue
        accepted_times.append(float(stream_a[ia].time_s))
        accepted_points.append(result["point"])
        reprojection.extend(result["reprojection_px"])
        angles.append(result["ray_angle_deg"])
    base = {
        "schema": SCHEMA,
        "mode": MODE,
        "label": LABEL,
        "sync": {"pairs": len(pairs), "offset_s": offset_s, "tolerance_s": config.sync_tolerance_s},
        "points": {"accepted": len(accepted_points), "rejected": rejected},
        "reprojection_rms_px": round(float(np.sqrt(np.mean(np.square(reprojection)))), 4) if reprojection else None,
        "ray_angle_min_deg": round(min(angles), 3) if angles else None,
        "trajectory_xyz_m": [],
        "speed_kmh": None,
    }
    if not pairs:
        reasons.append("no_synchronised_pairs")
    if len(accepted_points) < config.min_points:
        reasons.append("too_few_triangulated_points")
    if reasons:
        return {**base, "status": "rejected", "rejection_reasons": reasons}
    times = np.asarray(accepted_times)
    points = np.asarray(accepted_points)
    smooth = physics_smooth(times, points, config.terminal_velocity_m_s)
    if not smooth["success"] or smooth["rms_m"] > config.max_physics_rms_m:
        return {**base, "status": "rejected", "rejection_reasons": ["physics_fit_residual_too_large"],
                "physics": {"rms_m": round(smooth["rms_m"], 4)}}
    trajectory = [{"time_s": round(float(t), 5), "x": round(float(p[0]), 4), "y": round(float(p[1]), 4), "z": round(float(p[2]), 4)}
                  for t, p in zip(times, smooth["positions"])]
    return {**base, "status": "available", "rejection_reasons": [], "trajectory_xyz_m": trajectory,
            "speed_kmh": round(smooth["speed_first_kmh"], 1), "physics": {"rms_m": round(smooth["rms_m"], 4)}}


def not_run_summary(reason: str = NOT_RUN_REASON) -> dict:
    """What every analysis without a second synchronised camera reports for this tier. No value is invented."""
    return {"schema": SCHEMA, "mode": MODE, "status": "not_run", "label": NOT_RUN_LABEL, "reason": reason,
            "trajectory_xyz_m": [], "speed_kmh": None}


def camera_from_dict(name: str, block: dict, width: int, height: int) -> Optional[StereoCamera]:
    try:
        return StereoCamera(name, block["intrinsic"], block["rotation_world_to_camera"], block["camera_center_m"], width, height,
                            tuple(block.get("distortion") or (0.0, 0.0, 0.0, 0.0, 0.0)))
    except (KeyError, TypeError, ValueError):
        return None
