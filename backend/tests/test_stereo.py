"""Measured 3D — stereo: synthetic ground truth only. Two cameras and a known flight; nothing here is real footage.

The built-in samples have one camera, so the product reports this tier as NOT RUN for them and never simulates a camera.
"""

import numpy as np
import pytest

from app.physics import stereo as S
from app.physics.camera import look_at_camera
from app.physics.trajectory import drag_coefficient, integrate_state, speed_kmh

TRUTH = np.array([3.0, 2.0, 2.2, 1.5, 22.0, 6.0])


def camera(name, centre, target=(3.05, 6.70, 1.5), distortion=(0.0, 0.0, 0.0, 0.0, 0.0)):
    base = look_at_camera(centre, target)
    return S.StereoCamera(name, base.intrinsic, base.rotation_world_to_camera, base.camera_center_m, base.width, base.height,
                          distortion)


def flight(fps=60.0, duration=0.5):
    times = np.arange(0.0, duration, 1.0 / fps)
    return times, integrate_state(TRUTH, 0.0, times, drag_coefficient())[:, :3]


def streams(cam_a, cam_b, *, clock_offset_b=0.002, noise_px=0.2, distractor=True, seed=3):
    times, points = flight()
    rng = np.random.default_rng(seed)
    pixels_a, depth_a = cam_a.project(points)
    pixels_b, depth_b = cam_b.project(points)
    assert np.all(depth_a > 0) and np.all(depth_b > 0)
    stream_a, stream_b = [], []
    for index, time_value in enumerate(times):
        a = pixels_a[index] + rng.normal(0.0, noise_px, 2)
        b = pixels_b[index] + rng.normal(0.0, noise_px, 2)
        extra_a = [a + np.array([40.0, 300.0])] if distractor else []
        extra_b = [b + np.array([-35.0, 280.0])] if distractor else []
        stream_a.append(S.StereoObservation(float(time_value), [tuple(a)] + [tuple(p) for p in extra_a]))
        # Camera B's clock runs 2 ms behind: its timestamp for the same instant is earlier.
        stream_b.append(S.StereoObservation(float(time_value) - clock_offset_b, [tuple(p) for p in extra_b] + [tuple(b)]))
    return times, points, stream_a, stream_b


LEFT = camera("left", (-3.0, -7.0, 5.0), distortion=(-0.08, 0.01, 0.0005, -0.0003, 0.0))
RIGHT = camera("right", (9.0, -7.0, 5.0), distortion=(-0.05, 0.005, 0.0, 0.0, 0.0))


def test_distortion_round_trip():
    normalised = np.array([[0.1, -0.2], [0.3, 0.25], [-0.4, 0.05]])
    back = S.undistort(S.distort(normalised, LEFT.distortion), LEFT.distortion)
    assert np.allclose(back, normalised, atol=1e-9)


def test_the_fundamental_matrix_holds_for_true_correspondences():
    _, points = flight()
    fundamental = S.fundamental_matrix(LEFT, RIGHT)
    ideal_a = LEFT.ideal_pixels(LEFT.project(points)[0])
    ideal_b = RIGHT.ideal_pixels(RIGHT.project(points)[0])
    for a, b in zip(ideal_a, ideal_b):
        assert S.epipolar_distance(fundamental, a, b) < 1e-6


def test_two_synchronised_cameras_triangulate_the_known_flight():
    times, points, stream_a, stream_b = streams(LEFT, RIGHT)
    result = S.measure_stereo(LEFT, RIGHT, stream_a, stream_b, offset_s=0.002)
    assert result["mode"] == "measured_stereo" and result["status"] == "available", result.get("rejection_reasons")
    assert result["points"]["accepted"] == len(times)
    assert result["reprojection_rms_px"] < 0.5
    assert result["ray_angle_min_deg"] >= 2.0
    fitted = np.array([[p["x"], p["y"], p["z"]] for p in result["trajectory_xyz_m"]])
    assert np.max(np.linalg.norm(fitted - points, axis=1)) < 0.02
    assert result["speed_kmh"] == pytest.approx(speed_kmh(TRUTH), rel=0.01)


def test_a_point_behind_a_camera_is_rejected_by_the_depth_check():
    _, points = flight()
    turned = S.StereoCamera("turned", RIGHT.intrinsic, np.diag([-1.0, 1.0, -1.0]) @ RIGHT.rotation_world_to_camera,
                            RIGHT.camera_center_m, RIGHT.width, RIGHT.height)
    pixel_a = LEFT.project(points[5])[0][0]
    behind = turned.to_camera(points[5])[0]
    assert behind[2] < 0
    homogeneous = turned.intrinsic @ np.array([behind[0] / behind[2], behind[1] / behind[2], 1.0])
    result = S.triangulate(LEFT, turned, pixel_a, homogeneous[:2])
    assert result["depth_b"] < 0


def test_nearly_parallel_rays_are_rejected():
    near = camera("near", (-2.95, -7.0, 5.0))
    _, _, stream_a, stream_b = streams(camera("left0", (-3.0, -7.0, 5.0)), near, distractor=False, noise_px=0.0)
    result = S.measure_stereo(camera("left0", (-3.0, -7.0, 5.0)), near, stream_a, stream_b, offset_s=0.002)
    assert result["status"] == "rejected"
    assert result["points"]["rejected"]["ray_angle_below_minimum"] > 0
    assert "too_few_triangulated_points" in result["rejection_reasons"]


def test_a_candidate_off_the_epipolar_line_is_never_matched():
    times, _points, stream_a, stream_b = streams(LEFT, RIGHT)
    only_true_a = [S.StereoObservation(item.time_s, item.candidates[:1]) for item in stream_a]  # the true point in camera A
    only_distractors = [S.StereoObservation(item.time_s, item.candidates[:1]) for item in stream_b]  # camera B: distractor only
    result = S.measure_stereo(LEFT, RIGHT, only_true_a, only_distractors, offset_s=0.002)
    assert result["status"] == "rejected"
    assert result["points"]["rejected"]["no_epipolar_match"] == len(times)


def test_streams_outside_the_sync_tolerance_give_no_pairs():
    _, _, stream_a, stream_b = streams(LEFT, RIGHT, clock_offset_b=0.008)
    unsynchronised = S.measure_stereo(LEFT, RIGHT, stream_a, stream_b, offset_s=0.0)
    assert unsynchronised["status"] == "rejected" and "no_synchronised_pairs" in unsynchronised["rejection_reasons"]
    synchronised = S.measure_stereo(LEFT, RIGHT, stream_a, stream_b, offset_s=0.008)
    assert synchronised["status"] == "available"


def test_one_camera_reports_not_run_and_invents_nothing():
    summary = S.not_run_summary()
    assert summary["status"] == "not_run" and summary["label"] == "Measured 3D: NOT RUN — stereo input unavailable"
    assert summary["trajectory_xyz_m"] == [] and summary["speed_kmh"] is None
