"""Pinhole-camera geometry used by the experimental 3D speed estimator.

The production estimator accepts only an independently supplied 3D camera calibration.
A floor homography can be decomposed under strong assumptions, but that diagnostic is
not accepted as enough evidence for physical speed: a homography does not constrain lens
distortion or validate the camera away from the floor plane.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np


@dataclass(frozen=True)
class CameraCalibration:
    """World-to-camera pinhole model ``q = K R (p - C)``."""

    intrinsic: np.ndarray
    rotation_world_to_camera: np.ndarray
    camera_center_m: np.ndarray
    width: int
    height: int
    source: str
    independent_3d: bool
    reprojection_rms_px: Optional[float] = None
    focal_uncertainty_fraction: Optional[float] = None
    notes: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "intrinsic", np.asarray(self.intrinsic, dtype=float).reshape(3, 3))
        object.__setattr__(self, "rotation_world_to_camera", np.asarray(self.rotation_world_to_camera, dtype=float).reshape(3, 3))
        object.__setattr__(self, "camera_center_m", np.asarray(self.camera_center_m, dtype=float).reshape(3))

    def project(self, points_world: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        points = np.atleast_2d(np.asarray(points_world, dtype=float))
        camera = (self.rotation_world_to_camera @ (points - self.camera_center_m).T).T
        homogeneous = (self.intrinsic @ camera.T).T
        depth = camera[:, 2]
        pixels = np.full((len(points), 2), np.nan, dtype=float)
        valid = depth > 1e-6
        pixels[valid] = homogeneous[valid, :2] / homogeneous[valid, 2:3]
        return pixels, depth

    def world_ray(self, pixel: tuple[float, float]) -> np.ndarray:
        image = np.array([pixel[0], pixel[1], 1.0], dtype=float)
        direction_camera = np.linalg.solve(self.intrinsic, image)
        direction_world = self.rotation_world_to_camera.T @ direction_camera
        return direction_world / np.linalg.norm(direction_world)

    def with_focal_scale(self, scale: float) -> "CameraCalibration":
        intrinsic = self.intrinsic.copy()
        intrinsic[0, 0] *= scale
        intrinsic[1, 1] *= scale
        return CameraCalibration(
            intrinsic,
            self.rotation_world_to_camera,
            self.camera_center_m,
            self.width,
            self.height,
            self.source,
            self.independent_3d,
            self.reprojection_rms_px,
            self.focal_uncertainty_fraction,
            self.notes,
        )

    def with_principal_shift(self, dx_px: float, dy_px: float) -> "CameraCalibration":
        intrinsic = self.intrinsic.copy()
        intrinsic[0, 2] += dx_px
        intrinsic[1, 2] += dy_px
        return CameraCalibration(
            intrinsic,
            self.rotation_world_to_camera,
            self.camera_center_m,
            self.width,
            self.height,
            self.source,
            self.independent_3d,
            self.reprojection_rms_px,
            self.focal_uncertainty_fraction,
            self.notes,
        )

    def as_dict(self) -> dict:
        return {
            "source": self.source,
            "independent_3d": self.independent_3d,
            "intrinsic": self.intrinsic.round(8).tolist(),
            "rotation_world_to_camera": self.rotation_world_to_camera.round(8).tolist(),
            "camera_center_m": self.camera_center_m.round(8).tolist(),
            "reprojection_rms_px": self.reprojection_rms_px,
            "focal_uncertainty_fraction": self.focal_uncertainty_fraction,
            "notes": list(self.notes),
        }


def camera_from_document(court_doc: Optional[dict], width: int, height: int) -> tuple[Optional[CameraCalibration], dict]:
    """Load an explicit camera model and return a diagnostic for weaker inputs."""
    block = (court_doc or {}).get("camera_3d")
    if isinstance(block, dict):
        try:
            camera = CameraCalibration(
                intrinsic=block["intrinsic"],
                rotation_world_to_camera=block["rotation_world_to_camera"],
                camera_center_m=block["camera_center_m"],
                width=width,
                height=height,
                source=str(block.get("source") or "explicit"),
                independent_3d=bool(block.get("independent_3d")),
                reprojection_rms_px=_optional_float(block.get("reprojection_rms_px")),
                focal_uncertainty_fraction=_optional_float(block.get("focal_uncertainty_fraction")),
                notes=tuple(str(item) for item in block.get("notes", [])),
            )
            diagnostic = validate_camera(camera)
            return (camera if diagnostic["valid"] else None), diagnostic
        except (KeyError, TypeError, ValueError, np.linalg.LinAlgError) as exc:
            return None, {"valid": False, "source": "camera_3d", "reason": f"invalid explicit camera calibration: {exc}"}

    homography = (court_doc or {}).get("homography_image_from_court")
    floor_diagnostic = decompose_floor_homography(homography, width, height) if homography is not None else None
    return None, {
        "valid": False,
        "source": "floor_homography" if homography is not None else "none",
        "reason": "A floor-plane homography is not an independent 3D camera calibration.",
        "floor_homography_diagnostic": floor_diagnostic,
    }


def validate_camera(camera: CameraCalibration) -> dict:
    rotation_error = float(np.linalg.norm(camera.rotation_world_to_camera @ camera.rotation_world_to_camera.T - np.eye(3)))
    determinant = float(np.linalg.det(camera.rotation_world_to_camera))
    fx, fy = float(camera.intrinsic[0, 0]), float(camera.intrinsic[1, 1])
    principal = (float(camera.intrinsic[0, 2]), float(camera.intrinsic[1, 2]))
    reasons = []
    if not camera.independent_3d:
        reasons.append("calibration is not independently constrained in 3D")
    if fx <= 0 or fy <= 0:
        reasons.append("focal length is not positive")
    if rotation_error > 1e-3 or abs(determinant - 1.0) > 1e-3:
        reasons.append("rotation matrix is not orthonormal")
    if not (-0.25 * camera.width <= principal[0] <= 1.25 * camera.width and -0.25 * camera.height <= principal[1] <= 1.25 * camera.height):
        reasons.append("principal point is implausible")
    if camera.reprojection_rms_px is None:
        reasons.append("3D calibration reprojection error is missing")
    elif camera.reprojection_rms_px > 3.0:
        reasons.append("3D calibration reprojection error exceeds 3 px")
    return {
        "valid": not reasons,
        "source": camera.source,
        "reason": None if not reasons else "; ".join(reasons),
        "rotation_error": round(rotation_error, 8),
        "determinant": round(determinant, 8),
        "fx_px": round(fx, 3),
        "fy_px": round(fy, 3),
        "principal_point_px": [round(principal[0], 3), round(principal[1], 3)],
        "reprojection_rms_px": camera.reprojection_rms_px,
    }


def decompose_floor_homography(homography, width: int, height: int) -> Optional[dict]:
    """Approximate one pinhole camera from a floor homography for diagnostics only.

    The principal point is fixed to the image centre and square pixels are assumed. The
    result is deliberately marked unusable for physical speed because only the floor plane
    supplied the constraints.
    """
    try:
        h = np.asarray(homography, dtype=float).reshape(3, 3)
        h = h / h[2, 2]
        cx, cy = width / 2.0, height / 2.0
        columns = []
        for index in (0, 1):
            column = h[:, index]
            columns.append(np.array([column[0] - cx * column[2], column[1] - cy * column[2], column[2]]))
        a, b = columns
        estimates = []
        denominator = a[2] * b[2]
        numerator = a[0] * b[0] + a[1] * b[1]
        if abs(denominator) > 1e-12:
            value = -numerator / denominator
            if value > 0:
                estimates.append(value)
        denominator = a[2] ** 2 - b[2] ** 2
        numerator = a[0] ** 2 + a[1] ** 2 - b[0] ** 2 - b[1] ** 2
        if abs(denominator) > 1e-12:
            value = -numerator / denominator
            if value > 0:
                estimates.append(value)
        if not estimates:
            return {"solved": False, "reason": "the planar constraints do not yield a positive focal length"}
        focal = float(np.sqrt(np.median(estimates)))
        spread = float(np.ptp(np.sqrt(estimates)) / focal) if len(estimates) > 1 else None
        return {
            "solved": True,
            "assumed_principal_point_px": [round(cx, 3), round(cy, 3)],
            "estimated_focal_px": round(focal, 3),
            "constraint_count": len(estimates),
            "focal_constraint_spread_fraction": None if spread is None else round(spread, 5),
            "usable_for_physical_speed": False,
            "reason": "planar decomposition has no independent vertical or lens-distortion validation",
        }
    except (TypeError, ValueError, np.linalg.LinAlgError):
        return {"solved": False, "reason": "invalid homography"}


def approximate_camera_from_floor_homography(
    homography,
    width: int,
    height: int,
    *,
    focal_scale: float = 1.0,
    principal_offset_fraction: tuple[float, float] = (0.0, 0.0),
) -> Optional[CameraCalibration]:
    """Research-only camera decomposition from the court floor homography.

    Square pixels, zero skew, image-centre principal point (plus an explicit sensitivity
    offset) and zero lens distortion are assumptions. The returned camera is marked
    ``independent_3d=False`` and therefore cannot pass the production speed gate.
    """
    diagnostic = decompose_floor_homography(homography, width, height)
    if not diagnostic or not diagnostic.get("solved"):
        return None
    h = np.asarray(homography, dtype=float).reshape(3, 3)
    # Existing SmashLab court coordinates increase from the far baseline toward the
    # camera. Reverse that axis so x/y/z-up form the right-handed physics frame used by
    # the integrator. The net remains y=6.70 m under this transform.
    h = h @ np.array([[1.0, 0.0, 0.0], [0.0, -1.0, 13.40], [0.0, 0.0, 1.0]])
    cx = width * (0.5 + principal_offset_fraction[0])
    cy = height * (0.5 + principal_offset_fraction[1])
    focal = float(diagnostic["estimated_focal_px"]) * focal_scale
    intrinsic = np.array([[focal, 0.0, cx], [0.0, focal, cy], [0.0, 0.0, 1.0]])
    inverse = np.linalg.inv(intrinsic)
    first = inverse @ h[:, 0]
    second = inverse @ h[:, 1]
    scale = 2.0 / (np.linalg.norm(first) + np.linalg.norm(second))

    candidates = []
    for sign in (1.0, -1.0):
        r1 = sign * scale * first
        r2 = sign * scale * second
        r3 = np.cross(r1, r2)
        raw_rotation = np.column_stack([r1, r2, r3])
        u, _, vt = np.linalg.svd(raw_rotation)
        rotation = u @ vt
        if np.linalg.det(rotation) < 0:
            u[:, -1] *= -1
            rotation = u @ vt
        translation = sign * scale * (inverse @ h[:, 2])
        center = -rotation.T @ translation
        camera = CameraCalibration(
            intrinsic,
            rotation,
            center,
            width,
            height,
            source="research_floor_homography_assumption",
            independent_3d=False,
            reprojection_rms_px=None,
            focal_uncertainty_fraction=None,
            notes=(
                "floor homography only",
                "court y axis reversed to form a right-handed x/y/z-up frame",
                "square pixels and zero skew assumed",
                "zero lens distortion assumed",
                "not accepted by production speed gate",
            ),
        )
        _, depth = camera.project(np.array([[3.05, 6.70, 1.55], [0.0, 0.0, 0.0], [6.10, 13.40, 0.0]]))
        score = int(np.all(depth > 0)) + int(center[2] > 0)
        candidates.append((score, camera))
    best = max(candidates, key=lambda item: item[0])[1]
    return best


def look_at_camera(
    center: tuple[float, float, float],
    target: tuple[float, float, float],
    width: int = 1920,
    height: int = 1080,
    focal_px: float = 1600.0,
) -> CameraCalibration:
    """Deterministic synthetic camera used by the ground-truth benchmark."""
    c = np.asarray(center, dtype=float)
    forward = np.asarray(target, dtype=float) - c
    forward /= np.linalg.norm(forward)
    right = np.cross(forward, np.array([0.0, 0.0, 1.0]))
    right /= np.linalg.norm(right)
    down = np.cross(forward, right)
    rotation = np.vstack([right, down, forward])
    intrinsic = np.array([[focal_px, 0.0, width / 2], [0.0, focal_px, height / 2], [0.0, 0.0, 1.0]])
    return CameraCalibration(
        intrinsic,
        rotation,
        c,
        width,
        height,
        source="synthetic_ground_truth",
        independent_3d=True,
        reprojection_rms_px=0.0,
        focal_uncertainty_fraction=0.01,
        notes=("synthetic pinhole camera; zero lens distortion",),
    )


def _optional_float(value) -> Optional[float]:
    return None if value is None else float(value)
