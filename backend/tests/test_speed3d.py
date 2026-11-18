"""Ground-truth and refusal tests for the experimental 3D speed estimator."""

import numpy as np
import pytest

from app.physics.camera import approximate_camera_from_floor_homography, look_at_camera
from app.physics.speed3d import estimate_shot_speed, fit_free_monocular, fit_net_plane
from app.physics.trajectory import drag_coefficient, integrate_state, speed_kmh


def synthetic_shot(fps=60, noise_px=0.0, missing=(), seed=7):
    camera = look_at_camera((3.05, -8.0, 6.0), (3.05, 6.70, 1.5))
    truth = np.array([3.0, 2.0, 2.2, 1.5, 28.0, 7.0])
    times = np.arange(0.0, 0.60, 1.0 / fps)
    states = integrate_state(truth, 0.0, times, drag_coefficient())
    pixels, depth = camera.project(states[:, :3])
    assert np.all(depth > 0)
    pixels += np.random.default_rng(seed).normal(0.0, noise_px, pixels.shape)
    frames = [
        {
            "frame": index,
            "time_s": float(timestamp),
            "x": float(pixel[0]),
            "y": float(pixel[1]),
            "visible": True,
            "confidence": 0.95,
            "refined": False,
        }
        for index, (timestamp, pixel) in enumerate(zip(times, pixels))
        if index not in set(missing)
    ]
    return camera, truth, times, pixels, frames


def camera_document(camera):
    return {"camera_3d": camera.as_dict()}


def test_rk4_zero_drag_matches_constant_horizontal_velocity_and_gravity():
    initial = np.array([0.0, 0.0, 2.0, 3.0, 4.0, 5.0])
    state = integrate_state(initial, 0.0, np.array([0.5]), drag_k=0.0)[0]
    assert state[0] == pytest.approx(1.5, abs=1e-8)
    assert state[1] == pytest.approx(2.0, abs=1e-8)
    assert state[2] == pytest.approx(2.0 + 2.5 - 0.5 * 9.80665 * 0.25, abs=1e-7)
    assert state[5] == pytest.approx(5.0 - 9.80665 * 0.5, abs=1e-8)


def test_exact_synthetic_trajectory_recovers_ground_truth_speed():
    camera, truth, _, _, frames = synthetic_shot()
    result = estimate_shot_speed(
        contact={"frame": 0, "status": "confirmed"},
        shuttle_doc={"timestamp_source": "presentation_timestamp", "frames": frames},
        court_doc=camera_document(camera),
        width=1920,
        height=1080,
        run_sensitivity=False,
    )
    assert result["status"] == "available"
    assert result["speed_first_observed_kmh"] == pytest.approx(speed_kmh(truth), abs=0.2)
    assert result["quality"]["reprojection_rms_px"] < 0.01


def test_noisy_30_fps_trajectory_is_still_close_but_explicitly_experimental():
    camera, truth, _, _, frames = synthetic_shot(fps=30, noise_px=1.0, missing={7, 11})
    result = estimate_shot_speed(
        contact={"frame": 0, "status": "confirmed"},
        shuttle_doc={"timestamp_source": "presentation_timestamp", "frames": frames},
        court_doc=camera_document(camera),
        width=1920,
        height=1080,
        run_sensitivity=False,
    )
    assert result["status"] == "available"
    assert result["not_radar_validated"] is True
    assert result["speed_first_observed_kmh"] == pytest.approx(speed_kmh(truth), rel=0.08)


def test_net_plane_parameterisation_reprojects_the_same_synthetic_flight():
    camera, _, times, pixels, _ = synthetic_shot()
    free = [item for item in fit_free_monocular(camera, times, pixels, drag_coefficient()) if item.success and not item.at_bounds]
    assert free
    constrained = [item for item in fit_net_plane(camera, times, pixels, drag_coefficient(), min(free, key=lambda item: item.cost)) if item.success]
    assert constrained
    assert min(item.rms_px for item in constrained) < 0.05


def test_production_gate_rejects_floor_homography_frame_timing_and_unconfirmed_contact():
    homography = [[120.0, -27.0, 593.0], [0.0, 7.2, 530.0], [0.0, -0.028, 1.0]]
    camera = approximate_camera_from_floor_homography(homography, 1920, 1080)
    assert camera is not None and camera.independent_3d is False
    _, _, _, _, frames = synthetic_shot()
    result = estimate_shot_speed(
        contact={"frame": 0, "status": "candidate"},
        shuttle_doc={"frames": frames},
        court_doc={"homography_image_from_court": homography},
        width=1920,
        height=1080,
    )
    assert result["status"] == "unavailable"
    assert set(result["reason_codes"]) >= {
        "contact_not_confirmed",
        "actual_presentation_timestamps_unavailable",
        "insufficient_3d_camera_calibration",
    }


def test_tracking_gap_stress_case_is_rejected_before_optimisation():
    camera, _, _, _, frames = synthetic_shot(fps=30, missing={3, 5, 7, 9, 11, 13})
    result = estimate_shot_speed(
        contact={"frame": 0, "status": "confirmed"},
        shuttle_doc={"timestamp_source": "presentation_timestamp", "frames": frames},
        court_doc=camera_document(camera),
        width=1920,
        height=1080,
    )
    assert result["status"] == "unavailable"
    assert "tracking_gaps_dominate" in result["reason_codes"]
    assert result["runtime_ms"] < 100
