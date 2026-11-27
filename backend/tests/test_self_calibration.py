"""Self-calibration from the court lines with the net tape as an independent check above the floor.

Synthetic scenes only: a known pinhole camera renders a court and a net; the calibration must recover the camera from
the floor and confirm it with the net, and must refuse when the net does not agree. No real clip has ground truth.
"""

import cv2
import numpy as np

from app.ai.court_detection.court import DOUBLES
from app.physics import self_calibration as S
from app.physics.camera import CameraCalibration, camera_from_document, look_at_camera

W, H = 1920, 1080


def broadcast_camera(focal=1600.0, center=(3.05, -7.5, 6.5), target=(3.05, 6.7, 0.0)) -> CameraCalibration:
    return look_at_camera(center, target, W, H, focal)


def homography_of(camera: CameraCalibration) -> np.ndarray:
    court = S.court_line_points(11)
    pixels, _depth = camera.project(S.to_physics_frame(court))
    homography, _mask = cv2.findHomography(court, pixels, 0)
    return homography / homography[2, 2]


def render(camera: CameraCalibration, *, net_height_scale=1.0, draw_net=True, seed=3) -> np.ndarray:
    image = np.full((H, W, 3), (40, 70, 48), np.uint8)
    floor = np.array([[-2.0, -2.0], [8.1, -2.0], [8.1, 15.4], [-2.0, 15.4]])
    corners, _ = camera.project(S.to_physics_frame(floor))
    cv2.fillPoly(image, [corners.round().astype(np.int32)], (58, 112, 74))
    for (x1, y1), (x2, y2) in DOUBLES.lines:
        ends, _ = camera.project(S.to_physics_frame(np.array([[x1, y1], [x2, y2]])))
        cv2.line(image, tuple(ends[0].round().astype(int)), tuple(ends[1].round().astype(int)), (236, 236, 236), 4, cv2.LINE_AA)
    if draw_net:
        xs = np.linspace(0.0, S.COURT_WIDTH_M, 80)
        top = S.net_top_height_m(xs) * net_height_scale
        tape, _ = camera.project(np.column_stack([xs, np.full(len(xs), S.NET_Y_M), top - S.NET_TAPE_HALF_WIDTH_M]))
        base, _ = camera.project(np.column_stack([xs, np.full(len(xs), S.NET_Y_M), np.zeros(len(xs))]))
        mesh = np.vstack([tape, base[::-1]]).round().astype(np.int32)
        overlay = image.copy()
        cv2.fillPoly(overlay, [mesh], (30, 34, 32))
        image = cv2.addWeighted(overlay, 0.45, image, 0.55, 0)
        cv2.polylines(image, [tape.round().astype(np.int32)], False, (246, 246, 246), 5, cv2.LINE_AA)
    noise = np.random.default_rng(seed).normal(0.0, 3.0, image.shape)
    return np.clip(image.astype(float) + noise, 0, 255).astype(np.uint8)


def test_a_floor_camera_that_predicts_the_net_is_validated_and_accepted_as_3d():
    camera = broadcast_camera()
    block = S.self_calibrate(homography_of(camera), render(camera), W, H)
    assert block["status"] == "validated" and block["independent_3d"] is True, block.get("reason")
    checks = block["checks"]
    assert abs(checks["focal_from_floor_px"] - 1600.0) / 1600.0 < 0.01
    assert checks["floor_reprojection_rms_px"] < 0.5
    assert checks["net_tape_residual_rms_px"] < 1.5 and checks["net_tape_coverage"] >= 0.9
    assert abs(block["camera_center_m"][2] - 6.5) < 0.1
    assert block["label"] == "Estimated 3D — monocular experimental"
    loaded, diagnostic = camera_from_document({"camera_3d": block}, W, H)
    assert loaded is not None and diagnostic["valid"] is True
    assert loaded.focal_uncertainty_fraction >= S.MIN_FOCAL_UNCERTAINTY


def test_a_net_that_disagrees_with_the_floor_camera_is_refused():
    camera = broadcast_camera()
    block = S.self_calibrate(homography_of(camera), render(camera, net_height_scale=0.8), W, H)
    assert block["status"] == "failed" and block["independent_3d"] is False
    assert "net tape" in block["reason"]
    loaded, diagnostic = camera_from_document({"camera_3d": block}, W, H)
    assert loaded is None and "not independently constrained" in diagnostic["reason"]


def test_without_a_visible_net_the_camera_is_not_validated():
    camera = broadcast_camera()
    block = S.self_calibrate(homography_of(camera), render(camera, draw_net=False), W, H)
    assert block["status"] == "failed" and "was not found" in block["reason"]
    assert block["checks"]["net_tape_on_one_curve"] == 0


def test_a_second_camera_position_and_focal_length_is_recovered():
    camera = broadcast_camera(focal=1250.0, center=(1.2, -5.0, 4.2), target=(3.4, 7.5, 0.0))
    block = S.self_calibrate(homography_of(camera), render(camera, seed=7), W, H)
    assert block["status"] == "validated", block.get("reason")
    assert abs(block["checks"]["focal_from_floor_px"] - 1250.0) / 1250.0 < 0.01


def test_missing_inputs_fail_without_raising():
    camera = broadcast_camera()
    assert S.self_calibrate(None, None, W, H)["status"] == "failed"
    no_image = S.self_calibrate(homography_of(camera), None, W, H)
    assert no_image["status"] == "failed" and no_image["independent_3d"] is False
    assert "background" in no_image["reason"]


def test_the_net_height_follows_the_laws_of_badminton():
    assert S.net_top_height_m(np.array([0.0]))[0] == 1.55
    assert S.net_top_height_m(np.array([6.10]))[0] == 1.55
    assert abs(S.net_top_height_m(np.array([3.05]))[0] - 1.524) < 1e-12


def test_a_block_that_stopped_before_a_camera_reports_its_own_reason_to_the_3d_gate():
    block = S.self_calibrate(None, None, W, H)
    loaded, diagnostic = camera_from_document({"camera_3d": block}, W, H)
    assert loaded is None and diagnostic["reason"] == "no court homography"


def test_the_symmetric_broadcast_view_no_longer_picks_a_degenerate_focal_length():
    from app.physics.camera import decompose_floor_homography

    diagnostic = decompose_floor_homography(homography_of(broadcast_camera()), W, H)
    assert diagnostic["solved"] and abs(diagnostic["estimated_focal_px"] - 1600.0) < 1.0
