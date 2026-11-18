import numpy as np
import cv2
import pytest

from app.ai.analytics.movement import court_heatmap, court_player_movements, court_points
from app.ai.court_detection.court import (
    COURT_LENGTH_M,
    COURT_WIDTH_M,
    DOUBLES,
    estimate_court,
    floor_mask,
    image_to_court,
)
from app.ai.player_detection.tracker import TrackObservation


def _court_homography() -> np.ndarray:
    """Known floor-to-image homography: a doubles court in broadcast-like perspective."""
    court = np.float32([[0, 0], [COURT_WIDTH_M, 0], [COURT_WIDTH_M, COURT_LENGTH_M], [0, COURT_LENGTH_M]])
    image = np.float32([[330, 262], [630, 262], [772, 505], [188, 505]])
    return cv2.getPerspectiveTransform(court, image)


def _synthetic_court_frame() -> np.ndarray:
    """960x540 frame: blue backdrop, grey surround, green floor, white court lines."""
    rng = np.random.default_rng(3)
    frame = np.zeros((540, 960, 3), dtype=np.uint8)
    frame[:] = (150, 90, 40)  # blue-ish backdrop
    frame[200:, :] = (90, 90, 90)  # grey surround
    h = _court_homography()
    floor_quad = cv2.perspectiveTransform(
        np.float32([[[-1.5, -2.0]], [[COURT_WIDTH_M + 1.5, -2.0]], [[COURT_WIDTH_M + 1.5, COURT_LENGTH_M + 2.0]], [[-1.5, COURT_LENGTH_M + 2.0]]]),
        h,
    )
    cv2.fillPoly(frame, [floor_quad.astype(np.int32)], (60, 160, 60))  # green floor
    for (x1, y1), (x2, y2) in DOUBLES.lines:
        pts = cv2.perspectiveTransform(np.float32([[[x1, y1]], [[x2, y2]]]), h).reshape(-1, 2)
        cv2.line(frame, tuple(int(v) for v in pts[0]), tuple(int(v) for v in pts[1]), (250, 250, 250), 3, cv2.LINE_AA)
    noise = rng.integers(-6, 7, size=frame.shape, dtype=np.int16)
    return np.clip(frame.astype(np.int16) + noise, 0, 255).astype(np.uint8)


def test_floor_mask_keeps_the_court_colour_and_drops_the_backdrop():
    frame = _synthetic_court_frame()
    mask = floor_mask(frame)
    assert mask[400, 480] == 1  # centre of the court is floor
    assert mask[50, 480] == 0  # blue backdrop at the top is not floor


def test_estimate_court_recovers_a_synthetic_doubles_court():
    frame = _synthetic_court_frame()
    estimate = estimate_court(frame)
    assert estimate.status == "calibrated", estimate.reason
    assert estimate.template.startswith("doubles")
    truth = _court_homography()
    estimated = np.array(estimate.homography_image_from_court)
    probe = np.array([[3.05, 6.70], [0.0, 0.0], [COURT_WIDTH_M, COURT_LENGTH_M], [1.0, 9.0]])
    truth_px = cv2.perspectiveTransform(probe.reshape(-1, 1, 2).astype(np.float32), truth).reshape(-1, 2)
    estimated_px = cv2.perspectiveTransform(probe.reshape(-1, 1, 2).astype(np.float32), estimated.astype(np.float32)).reshape(-1, 2)
    assert np.max(np.abs(truth_px - estimated_px)) < 6.0  # pixels in a 960x540 frame


def test_estimate_court_rejects_a_frame_without_court_lines():
    frame = np.zeros((540, 960, 3), dtype=np.uint8)
    frame[:] = (60, 160, 60)
    estimate = estimate_court(frame)
    assert estimate.status == "failed"
    assert estimate.homography_image_from_court is None


def test_image_to_court_round_trips_points():
    h = _court_homography()
    court_pts = np.array([[3.05, 6.7], [0.5, 12.0]])
    image_pts = cv2.perspectiveTransform(court_pts.reshape(-1, 1, 2).astype(np.float32), h).reshape(-1, 2)
    back = image_to_court(h, image_pts)
    assert np.allclose(back, court_pts, atol=1e-4)


def _obs(frame, track_id, foot_x, foot_y):
    return TrackObservation(frame=frame, track_id=track_id, x1=foot_x - 20, y1=foot_y - 120, x2=foot_x + 20, y2=foot_y, score=0.9, confirmed=True)


def test_court_points_and_distance_use_floor_metres():
    h = _court_homography()
    # walk the centre line from the far baseline towards the net, one metre per frame, 1 fps for easy numbers
    court_track = [np.array([3.05, y]) for y in (1.0, 2.0, 3.0, 4.0)]
    image_track = cv2.perspectiveTransform(np.float32(court_track).reshape(-1, 1, 2), h).reshape(-1, 2)
    observations = [_obs(i, 1, x, y) for i, (x, y) in enumerate(image_track)]
    positions = court_points(observations, h)
    assert positions[(0, 1)][1] == pytest.approx(1.0, abs=1e-3)
    movements = court_player_movements(observations, h, fps=1.0, total_frames=4)
    assert movements[0]["path_length_m"] == pytest.approx(3.0, abs=1e-2)
    assert movements[0]["share_inside_doubles_outline"] == pytest.approx(1.0)


def test_court_heatmap_counts_points_inside_the_outline():
    h = _court_homography()
    court_track = [np.array([1.0, 2.0]), np.array([5.0, 12.0]), np.array([9.0, 9.0])]  # last one is outside
    image_track = cv2.perspectiveTransform(np.float32(court_track).reshape(-1, 1, 2), h).reshape(-1, 2)
    observations = [_obs(i, 1, x, y) for i, (x, y) in enumerate(image_track)]
    heat = court_heatmap(observations, h)
    assert heat["total_observations"] == 2
    assert heat["rows"] == 13 and heat["cols"] == 6
