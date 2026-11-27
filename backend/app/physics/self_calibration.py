"""Self-calibration of one camera from the court, with an independent check above the floor (court-self-calibration/v1).

Floor: the court homography found from the white lines gives the camera's rotation, position and focal length under
stated assumptions: square pixels, zero skew, principal point at the image centre and no lens distortion
(camera.approximate_camera_from_floor_homography). The court-line reprojection of that pinhole camera is measured
against the homography itself.

Above the floor: the top of the net is 1.55 m high at the posts and 1.524 m at the centre (BWF Laws of Badminton,
Law 1). The floor-only camera predicts where the net tape must appear, and the tape is searched in the median
background image near that prediction. Nothing above the floor was used to build the camera, so agreement is an
independent 3D check. Only when every check passes is the camera marked independent_3d. A camera that passes is
still used only for "Estimated 3D — monocular experimental": the 3D estimator keeps all of its own gates (a confirmed
contact, enough reliable points, reprojection, multistart and sensitivity limits).

This module never claims accuracy. There is no ground truth for the sample clips; the synthetic tests in
backend/tests/test_self_calibration.py are the only measured cases.
"""

from __future__ import annotations

from typing import Optional

import cv2
import numpy as np

from app.physics.camera import CameraCalibration, approximate_camera_from_floor_homography

VERSION = "court-self-calibration/v1"
COURT_LENGTH_M = 13.40
COURT_WIDTH_M = 6.10
NET_Y_M = 6.70
NET_POST_HEIGHT_M = 1.55
NET_CENTRE_HEIGHT_M = 1.524
NET_TAPE_HALF_WIDTH_M = 0.0375  # the tape is 75 mm wide, folded over the cord: its centre is 37.5 mm below the top
NET_SAMPLES = 25
# Limits are written for 1080 image rows and scale with the image height.
FLOOR_TOLERANCE_PX = 3.0
NET_TOLERANCE_PX = 3.0
NET_SPREAD_PX = 2.0
MIN_NET_SPAN_PX = 6.0
MIN_NET_COVERAGE = 0.6
MIN_RIDGE_CONTRAST = 12.0
SEARCH_FRACTION = 0.15
FOCAL_SCAN = np.linspace(0.85, 1.15, 61)
MIN_FOCAL_UNCERTAINTY = 0.03

ASSUMPTIONS = (
    "square pixels and zero skew",
    "principal point at the image centre",
    "no lens distortion",
    "flat floor; the net hangs 1.55 m at the posts and 1.524 m at the centre",
)


def _scale(height: int) -> float:
    return max(0.25, float(height) / 1080.0)


def net_top_height_m(x_m: np.ndarray) -> np.ndarray:
    """Height of the top of the net along the court width: 1.55 m at the posts, 1.524 m at the centre (parabolic sag)."""
    half = COURT_WIDTH_M / 2.0
    u = (np.asarray(x_m, dtype=float) - half) / half
    return NET_CENTRE_HEIGHT_M + (NET_POST_HEIGHT_M - NET_CENTRE_HEIGHT_M) * u ** 2


def court_line_points(samples_per_line: int = 21) -> np.ndarray:
    """Points along the doubles court lines, in court coordinates (x across, y from the far baseline), metres."""
    from app.ai.court_detection.court import DOUBLES

    points = []
    for (x1, y1), (x2, y2) in DOUBLES.lines:
        for t in np.linspace(0.0, 1.0, samples_per_line):
            points.append((x1 + (x2 - x1) * t, y1 + (y2 - y1) * t))
    return np.asarray(points, dtype=float)


def to_physics_frame(court_xy: np.ndarray, z_m: Optional[np.ndarray] = None) -> np.ndarray:
    """Court coordinates to the right-handed x/y/z-up frame of the camera (y reversed; the net stays at y = 6.70)."""
    xy = np.atleast_2d(np.asarray(court_xy, dtype=float))
    z = np.zeros(len(xy)) if z_m is None else np.asarray(z_m, dtype=float).reshape(-1)
    return np.column_stack([xy[:, 0], COURT_LENGTH_M - xy[:, 1], z])


def _apply_homography(homography: np.ndarray, court_xy: np.ndarray) -> np.ndarray:
    points = np.column_stack([court_xy, np.ones(len(court_xy))]) @ homography.T
    return points[:, :2] / points[:, 2:3]


def floor_reprojection_rms_px(camera: CameraCalibration, homography: np.ndarray) -> float:
    """RMS pixel distance between the camera's projection of the court lines and the homography's mapping of them."""
    court = court_line_points()
    expected = _apply_homography(np.asarray(homography, dtype=float).reshape(3, 3), court)
    projected, depth = camera.project(to_physics_frame(court))
    if not np.all(depth > 0):
        return float("inf")
    return float(np.sqrt(np.mean(np.sum((projected - expected) ** 2, axis=1))))


def _tape_points(x_samples: np.ndarray) -> np.ndarray:
    top = net_top_height_m(x_samples) - NET_TAPE_HALF_WIDTH_M
    return np.column_stack([x_samples, np.full(len(x_samples), NET_Y_M), top])


def _net_base_points(x_samples: np.ndarray) -> np.ndarray:
    return np.column_stack([x_samples, np.full(len(x_samples), NET_Y_M), np.zeros(len(x_samples))])


def _horizontal_ridges(gray: np.ndarray, height: int) -> np.ndarray:
    """Thin bright horizontal lines: a white top-hat with a vertical structuring element, then averaged along the row,
    so a long tape outweighs short bright strokes such as the letters of an advertising board."""
    size = max(7, int(round(15 * _scale(height))) | 1)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, size))
    ridges = cv2.morphologyEx(gray, cv2.MORPH_TOPHAT, kernel).astype(np.float32)
    length = max(9, int(round(31 * _scale(height))) | 1)
    return cv2.blur(ridges, (length, 1))


def _floor_line_mask(homography: Optional[np.ndarray], shape: tuple[int, int]) -> Optional[np.ndarray]:
    """Pixels of the painted court lines, from the floor homography. A painted line is never taken for the net tape."""
    if homography is None:
        return None
    from app.ai.court_detection.court import DOUBLES

    height, width = shape
    mask = np.zeros((height, width), np.uint8)
    thickness = max(7, int(round(9 * _scale(height))))
    for (x1, y1), (x2, y2) in DOUBLES.lines:
        ends = _apply_homography(homography, np.array([[x1, y1], [x2, y2]], dtype=float))
        if not np.all(np.isfinite(ends)) or np.any(np.abs(ends) > 1e6):
            continue
        cv2.line(mask, tuple(int(round(v)) for v in ends[0]), tuple(int(round(v)) for v in ends[1]), 255, thickness)
    return mask > 0


def detect_net_tape(camera: CameraCalibration, background_bgr: np.ndarray, homography: Optional[np.ndarray] = None) -> dict:
    """Searches the net tape near where the camera predicts it. Returns the detections and their predicted rows."""
    image = np.asarray(background_bgr)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image.astype(np.uint8)
    height, width = gray.shape[:2]
    ridges = _horizontal_ridges(gray, height)
    gray_f = gray.astype(np.float32)
    painted = _floor_line_mask(homography, (height, width))
    if painted is not None:
        ridges[painted] = 0.0
    xs = np.linspace(0.25, COURT_WIDTH_M - 0.25, NET_SAMPLES)
    tape, tape_depth = camera.project(_tape_points(xs))
    base, base_depth = camera.project(_net_base_points(xs))
    usable, detections = 0, []
    for index, x in enumerate(xs):
        if tape_depth[index] <= 0 or base_depth[index] <= 0 or not np.all(np.isfinite(tape[index])):
            continue
        u, v = float(tape[index, 0]), float(tape[index, 1])
        span = float(base[index, 1] - v)
        if span < MIN_NET_SPAN_PX * _scale(height) or not (2 <= u < width - 2):
            continue
        usable += 1
        # The tape is searched within 15 % of the net's image height around the prediction. A camera that misses it by
        # more fails the coverage check, which is the intended outcome.
        lo = int(max(0, np.floor(v - SEARCH_FRACTION * span)))
        hi = int(min(height - 1, np.ceil(v + SEARCH_FRACTION * span)))
        if hi - lo < 4:
            continue
        column = int(round(u))
        profile = ridges[lo:hi + 1, column - 2:column + 3].mean(axis=1)
        peak = int(np.argmax(profile))
        value = float(profile[peak])
        if value < MIN_RIDGE_CONTRAST or value < 3.0 * float(np.median(profile)) + 6.0:
            continue
        # The ridge filter finds the tape; its centre comes from the brightness itself (a centroid over the tape's
        # width), because the dark net mesh below the tape and the lighter floor above it bias a filter's peak.
        band = gray_f[lo:hi + 1, column - 2:column + 3].mean(axis=1)
        reach = max(2, int(round(3 * _scale(height))))
        first, last = max(0, peak - reach), min(len(band), peak + reach + 1)
        window = band[first:last] - band[first:last].min()
        row = lo + first + float((window * np.arange(len(window))).sum() / window.sum()) if window.sum() > 0 else float(lo + peak)
        detections.append({"x_m": round(float(x), 3), "u_px": u, "row_px": row, "predicted_row_px": v,
                           "contrast": round(value, 1)})
    return {"samples": NET_SAMPLES, "usable": usable, "detections": detections}


def _consistent_curve(detections: list[dict], spread_limit: float) -> tuple[list[dict], Optional[float]]:
    """The detections that lie on one smooth curve (a quadratic in the image column), and their spread around it."""
    if len(detections) < 5:
        return [], None
    u = np.array([item["u_px"] for item in detections])
    r = np.array([item["row_px"] for item in detections])
    keep = np.ones(len(u), dtype=bool)
    for _ in range(4):
        if keep.sum() < 5:
            return [], None
        coefficients = np.polyfit(u[keep], r[keep], 2)
        residual = r - np.polyval(coefficients, u)
        mad = float(np.median(np.abs(residual[keep] - np.median(residual[keep])))) * 1.4826
        limit = max(spread_limit, 2.5 * mad)
        updated = np.abs(residual) <= min(limit, 3.0 * spread_limit)
        if np.array_equal(updated, keep):
            break
        keep = updated
    inliers = [item for item, flag in zip(detections, keep) if flag]
    if len(inliers) < 5:
        return [], None
    coefficients = np.polyfit(u[keep], r[keep], 2)
    spread = float(np.sqrt(np.mean((r[keep] - np.polyval(coefficients, u[keep])) ** 2)))
    return inliers, spread


def _net_rms(camera: CameraCalibration, inliers: list[dict]) -> float:
    xs = np.array([item["x_m"] for item in inliers])
    projected, depth = camera.project(_tape_points(xs))
    if not np.all(depth > 0):
        return float("inf")
    rows = np.array([item["row_px"] for item in inliers])
    return float(np.sqrt(np.mean((projected[:, 1] - rows) ** 2)))


def self_calibrate(homography_image_from_court, background_bgr: Optional[np.ndarray], width: int, height: int) -> dict:
    """The camera_3d block for court_coordinates.json, with every check and its limit. Never raises on bad input."""
    scale = _scale(height)
    limits = {
        "floor_reprojection_rms_px": round(FLOOR_TOLERANCE_PX * scale, 3),
        "net_tape_residual_rms_px": round(NET_TOLERANCE_PX * scale, 3),
        "net_tape_spread_px": round(NET_SPREAD_PX * scale, 3),
        "net_tape_coverage": MIN_NET_COVERAGE,
    }
    block: dict = {"version": VERSION, "source": "court_lines_and_net_tape", "independent_3d": False,
                   "label": "Estimated 3D — monocular experimental", "assumptions": list(ASSUMPTIONS), "limits": limits}
    try:
        homography = np.asarray(homography_image_from_court, dtype=float).reshape(3, 3)
    except (TypeError, ValueError):
        return {**block, "status": "failed", "reason": "no court homography"}
    camera = approximate_camera_from_floor_homography(homography, width, height)
    if camera is None:
        return {**block, "status": "failed", "reason": "the court homography does not yield a pinhole camera with a positive focal length"}
    floor_rms = floor_reprojection_rms_px(camera, homography)
    checks: dict = {"floor_reprojection_rms_px": round(floor_rms, 3), "focal_from_floor_px": round(float(camera.intrinsic[0, 0]), 2),
                    "camera_height_m": round(float(camera.camera_center_m[2]), 3)}
    block.update(_camera_fields(camera))
    if background_bgr is None:
        return {**block, "status": "failed", "checks": checks, "reason": "no background image to search the net tape in"}
    found = detect_net_tape(camera, background_bgr, homography)
    inliers, spread = _consistent_curve(found["detections"], NET_SPREAD_PX * scale)
    coverage = len(inliers) / found["usable"] if found["usable"] else 0.0
    checks.update({"net_tape_samples": found["samples"], "net_tape_usable": found["usable"],
                   "net_tape_detected": len(found["detections"]), "net_tape_on_one_curve": len(inliers),
                   "net_tape_coverage": round(coverage, 3), "net_tape_spread_px": None if spread is None else round(spread, 3)})
    reasons: list[str] = []
    if not np.isfinite(floor_rms) or floor_rms > limits["floor_reprojection_rms_px"]:
        reasons.append("the court lines do not reproject within the limit")
    if not inliers or coverage < MIN_NET_COVERAGE:
        reasons.append("the net tape was not found along enough of the net")
    elif spread is not None and spread > limits["net_tape_spread_px"]:
        reasons.append("the net tape detections do not lie on one smooth line")
    net_rms = _net_rms(camera, inliers) if inliers else None
    if inliers:
        scan = [(float(s), _net_rms(approximate_camera_from_floor_homography(homography, width, height, focal_scale=float(s)), inliers))
                for s in FOCAL_SCAN]
        best_scale, best_rms = min(scan, key=lambda item: item[1])
        checks.update({"net_tape_residual_rms_px": round(float(net_rms), 3), "focal_best_fit_to_net_px": round(float(camera.intrinsic[0, 0]) * best_scale, 2),
                       "net_tape_residual_at_best_focal_px": round(best_rms, 3)})
        if net_rms > limits["net_tape_residual_rms_px"]:
            reasons.append("the camera built from the floor does not predict the net tape within the limit")
        block["focal_uncertainty_fraction"] = round(max(MIN_FOCAL_UNCERTAINTY, abs(best_scale - 1.0)), 4)
    block["checks"] = checks
    if reasons:
        return {**block, "status": "failed", "reason": "; ".join(reasons)}
    block.update({"status": "validated", "independent_3d": True,
                  "reprojection_rms_px": round(max(floor_rms, float(net_rms)), 3),
                  "reason": "the floor-only camera predicts the net tape within the limit",
                  "notes": [f"{VERSION}: built from the court lines, checked against the net tape", *ASSUMPTIONS]})
    return block


def _camera_fields(camera: CameraCalibration) -> dict:
    return {
        "intrinsic": camera.intrinsic.round(6).tolist(),
        "rotation_world_to_camera": camera.rotation_world_to_camera.round(8).tolist(),
        "camera_center_m": camera.camera_center_m.round(4).tolist(),
        "reprojection_rms_px": None,
        "focal_uncertainty_fraction": None,
        "notes": [f"{VERSION}: built from the court lines only", *ASSUMPTIONS],
    }
