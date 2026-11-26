"""Ground-truth, gate and sensitivity tests for Estimated 3D — monocular experimental.

The synthetic flights test the algorithm. They are not evidence for real footage and are never shown as video results.
"""

import numpy as np
import pytest

from app.analytics import observed2d as O
from app.physics.camera import approximate_camera_from_floor_homography, look_at_camera
from app.physics.speed3d import estimate_monocular, fit_free_monocular, fit_net_plane
from app.physics.trajectory import drag_coefficient, integrate_state, speed_kmh


def synthetic_shot(fps=60, noise_px=0.0, missing=(), seed=7, focal_uncertainty=0.01):
    camera = look_at_camera((3.05, -8.0, 6.0), (3.05, 6.70, 1.5))
    if focal_uncertainty != 0.01:
        camera = type(camera)(camera.intrinsic, camera.rotation_world_to_camera, camera.camera_center_m, camera.width,
                              camera.height, camera.source, camera.independent_3d, camera.reprojection_rms_px,
                              focal_uncertainty, camera.notes)
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


def track_of(frames, fps=60, timestamps=True):
    doc = {"source_width": 1920, "source_height": 1080, "fps": fps, "frames": frames}
    if timestamps:
        doc["timestamp_source"] = "presentation_timestamp"
    return O.sanitize(doc)


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
    result = estimate_monocular(contact={"frame": 0, "status": "confirmed"}, track=track_of(frames),
                                court_doc=camera_document(camera), run_sensitivity=False)
    assert result["mode"] == "estimated_monocular" and result["status"] == "available"
    assert result["speed_candidate_kmh"] == pytest.approx(speed_kmh(truth), abs=0.2)
    assert result["reprojection_rms_px"] < 0.01
    assert result["trajectory_xyz_m"] and set(result["trajectory_xyz_m"][0]) == {"time_s", "x", "y", "z"}
    assert result["not_measured"] is True and result["rejection_reasons"] == []
    assert set(result) >= {"trajectory_xyz_m", "speed_candidate_kmh", "speed_range_kmh", "reprojection_rms_px",
                           "reprojection_p95_px", "parameter_spread_percent", "quality", "assumptions", "rejection_reasons"}


def test_noisy_30_fps_trajectory_is_still_close_but_explicitly_experimental():
    camera, truth, _, _, frames = synthetic_shot(fps=30, noise_px=1.0, missing={7, 11})
    result = estimate_monocular(contact={"frame": 0, "status": "confirmed"}, track=track_of(frames, fps=30),
                                court_doc=camera_document(camera), run_sensitivity=False)
    assert result["status"] == "available"
    assert result["not_radar_validated"] is True and result["label"].startswith("Estimated 3D")
    assert result["speed_candidate_kmh"] == pytest.approx(speed_kmh(truth), rel=0.08)


def test_available_result_has_a_speed_range_from_every_sensitivity_scenario():
    camera, _truth, _, _, frames = synthetic_shot()
    result = estimate_monocular(contact={"frame": 0, "status": "confirmed"}, track=track_of(frames),
                                court_doc=camera_document(camera), run_sensitivity=True)
    assert result["status"] == "available", result["rejection_reasons"]
    low, high = result["speed_range_kmh"]
    assert low <= result["speed_candidate_kmh"] <= high
    scenarios = result["sensitivity"]["scenarios"]
    for name in ("contact_-2_frames", "contact_-1_frames", "contact_+1_frames", "contact_+2_frames", "drag_minus_15pct",
                 "drag_plus_15pct", "principal_point_x_plus", "missing_every_third_point", "missing_first_two_points"):
        assert name in scenarios
    assert any(name.startswith("focal_plus") for name in scenarios)
    assert result["parameter_spread_percent"] <= 20.0


def test_a_large_camera_uncertainty_makes_the_sensitivity_too_wide_and_the_estimate_is_rejected():
    camera, _truth, _, _, frames = synthetic_shot(focal_uncertainty=0.35)
    result = estimate_monocular(contact={"frame": 0, "status": "confirmed"}, track=track_of(frames),
                                court_doc=camera_document(camera), run_sensitivity=True)
    assert result["status"] == "rejected"
    assert "camera_or_drag_sensitivity_unstable" in result["rejection_reasons"]
    assert result["parameter_spread_percent"] > 20.0
    assert result["speed_candidate_kmh"] is None and result["speed_range_kmh"] is None and result["trajectory_xyz_m"] == []
    assert result["label"] == "Physical trajectory unavailable" and result["quality"] == "low"


def test_net_plane_parameterisation_reprojects_the_same_synthetic_flight():
    camera, _, times, pixels, _ = synthetic_shot()
    free = [item for item in fit_free_monocular(camera, times, pixels, drag_coefficient()) if item.success and not item.at_bounds]
    assert free
    constrained = [item for item in fit_net_plane(camera, times, pixels, drag_coefficient(), min(free, key=lambda item: item.cost)) if item.success]
    assert constrained
    assert min(item.rms_px for item in constrained) < 0.05


def test_gates_reject_floor_homography_frame_timing_and_unconfirmed_contact_before_any_fit():
    homography = [[120.0, -27.0, 593.0], [0.0, 7.2, 530.0], [0.0, -0.028, 1.0]]
    camera = approximate_camera_from_floor_homography(homography, 1920, 1080)
    assert camera is not None and camera.independent_3d is False
    _, _, _, _, frames = synthetic_shot()
    result = estimate_monocular(contact={"frame": 0, "status": "candidate"}, track=track_of(frames, timestamps=False),
                                court_doc={"homography_image_from_court": homography})
    assert result["status"] == "rejected"
    assert set(result["rejection_reasons"]) >= {
        "contact_not_confirmed",
        "actual_presentation_timestamps_unavailable",
        "insufficient_3d_camera_calibration",
    }
    assert result["speed_candidate_kmh"] is None and result["reprojection_rms_px"] is None
    assert all(set(gate) == {"id", "passed", "value", "limit"} for gate in result["gates"])


def test_tracking_gap_stress_case_is_rejected_before_optimisation():
    camera, _, _, _, frames = synthetic_shot(fps=30, missing={3, 5, 7, 9, 11, 13})
    result = estimate_monocular(contact={"frame": 0, "status": "confirmed"}, track=track_of(frames, fps=30),
                                court_doc=camera_document(camera))
    assert result["status"] == "rejected"
    assert "tracking_gaps_dominate" in result["rejection_reasons"]
    assert result["runtime_ms"] < 100


def test_rejected_frames_never_become_observations():
    camera, _truth, _, _, frames = synthetic_shot()
    jumped = [dict(item) for item in frames]
    jumped[5] = {**jumped[5], "x": jumped[5]["x"] + 900.0, "y": jumped[5]["y"] - 400.0}  # a one-frame tracker jump
    track = track_of(jumped)
    assert 5 in {item.frame for item in track.rejected if item.reason == "tracker_jump"}
    result = estimate_monocular(contact={"frame": 0, "status": "confirmed"}, track=track, court_doc=camera_document(camera),
                                run_sensitivity=False)
    assert result["evidence"]["rejected_by_sanitizer"] >= 1
    assert result["status"] == "available"
