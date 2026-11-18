import math

import numpy as np

from app.ai.analytics.movement import compute_player_movements, foot_heatmap, shuttle_summary
from app.ai.player_detection.tracker import IouTracker, iou
from app.ai.player_detection.yolox import (
    Detection,
    build_grids,
    decode_predictions,
    letterbox,
)
from app.ai.shuttle_tracking.tracknet import TrackNetFrame


def test_yolox_grid_has_three_strides_and_row_major_order():
    grids, strides = build_grids(640, (8, 16, 32))
    assert grids.shape == (80 * 80 + 40 * 40 + 20 * 20, 2)
    assert strides[0, 0] == 8 and strides[-1, 0] == 32
    assert tuple(grids[1]) == (1, 0)  # x varies fastest
    assert tuple(grids[80]) == (0, 1)  # next row


def test_letterbox_keeps_aspect_ratio_and_pads_with_114():
    frame = np.zeros((720, 1280, 3), dtype=np.uint8)
    padded, ratio = letterbox(frame, 640)
    assert ratio == 0.5
    assert padded.shape == (640, 640, 3)
    assert int(padded[-1, -1, 0]) == 114
    assert int(padded[0, 0, 0]) == 0


def test_yolox_decode_maps_a_person_box_back_to_frame_pixels():
    grids, strides = build_grids(640, (8, 16, 32))
    output = np.zeros((grids.shape[0], 85), dtype=np.float32)
    anchor = 40 * 80 + 40  # grid (x=40, y=40) on the stride-8 map
    output[anchor, 0:2] = 0.5  # centre offset inside the cell
    output[anchor, 2:4] = math.log(4.0)  # 4 cells * stride 8 = 32 px in model space
    output[anchor, 4] = 0.9  # objectness
    output[anchor, 5] = 0.9  # person class
    dets = decode_predictions(output, grids, strides, ratio=0.5, frame_w=1280, frame_h=720)
    assert len(dets) == 1
    det = dets[0]
    assert math.isclose(det.x1, 616, abs_tol=1) and math.isclose(det.x2, 680, abs_tol=1)
    assert math.isclose(det.y1, 616, abs_tol=1) and math.isclose(det.y2, 680, abs_tol=1)
    assert abs(det.score - 0.81) < 1e-3


def test_yolox_decode_suppresses_overlapping_boxes():
    grids, strides = build_grids(640, (8, 16, 32))
    output = np.zeros((grids.shape[0], 85), dtype=np.float32)
    for anchor, score in ((40 * 80 + 40, 0.9), (40 * 80 + 41, 0.6)):
        output[anchor, 0:2] = 0.5
        output[anchor, 2:4] = math.log(4.0)
        output[anchor, 4] = score
        output[anchor, 5] = 1.0
    dets = decode_predictions(output, grids, strides, ratio=1.0, frame_w=640, frame_h=640)
    assert len(dets) == 1
    assert dets[0].score > 0.8


def test_iou_basic_cases():
    assert iou((0, 0, 10, 10), (0, 0, 10, 10)) == 1.0
    assert iou((0, 0, 10, 10), (20, 20, 30, 30)) == 0.0
    assert math.isclose(iou((0, 0, 10, 10), (5, 0, 15, 10)), 50 / 150)


def _det(x, y, w=40, h=120, score=0.9):
    return Detection(x, y, x + w, y + h, score)


def test_tracker_keeps_ids_across_frames_and_confirms_after_min_hits():
    tracker = IouTracker(frame_height=720, min_hits=3, max_players=4)
    seen = {}
    for frame in range(5):
        obs = tracker.update(frame, [_det(100 + frame, 300), _det(900 - frame, 300)])
        for o in obs:
            seen.setdefault(o.track_id, []).append(o)
    assert sorted(seen) == [1, 2]
    assert [o.confirmed for o in seen[1]] == [False, False, True, True, True]


def test_tracker_ignores_small_boxes_and_caps_players():
    tracker = IouTracker(frame_height=720, min_hits=1, max_players=2, min_height_ratio=0.06)
    dets = [_det(100, 300, h=20), _det(200, 300, h=200), _det(400, 300, h=180), _det(600, 300, h=160)]
    obs = tracker.update(0, dets)
    assert len(obs) == 2
    assert all(o.y2 - o.y1 >= 0.06 * 720 for o in obs)


def test_tracker_survives_a_short_detection_gap():
    tracker = IouTracker(frame_height=720, min_hits=1, max_misses=5)
    first = tracker.update(0, [_det(100, 300)])
    tracker.update(1, [])
    second = tracker.update(2, [_det(102, 300)])
    assert first[0].track_id == second[0].track_id


def test_movement_path_is_normalised_by_image_diagonal():
    tracker = IouTracker(frame_height=720, min_hits=1)
    observations = []
    for frame in range(10):
        det = _det(100 + 3 * frame, 300)
        observations.extend(tracker.update(frame, [det]))
    movements = compute_player_movements(observations, fps=30.0, width=1280, height=720, total_frames=10)
    assert len(movements) == 1
    diag = math.hypot(1280, 720)
    assert math.isclose(movements[0].path_length_norm, 9 * 3 / diag, rel_tol=1e-6)
    assert movements[0].observed_frames == 10
    assert movements[0].segments == 1


def test_movement_splits_segments_after_a_long_gap():
    tracker = IouTracker(frame_height=720, min_hits=1, max_misses=100)
    observations = []
    for frame in list(range(0, 5)) + list(range(20, 25)):
        observations.extend(tracker.update(frame, [_det(100, 300)]))
    movements = compute_player_movements(observations, fps=30.0, width=1280, height=720, total_frames=30, max_gap=3)
    assert movements[0].segments == 2


def test_foot_heatmap_counts_all_confirmed_observations():
    tracker = IouTracker(frame_height=720, min_hits=1)
    observations = []
    for frame in range(6):
        observations.extend(tracker.update(frame, [_det(200 + 10 * frame, 300), _det(900, 300)]))
    heat = foot_heatmap(observations, 1280, 720)
    assert heat["total_observations"] == len(observations)
    assert max(max(row) for row in heat["normalised"]) == 1.0


def test_shuttle_summary_reports_proxy_units_only():
    frames = [TrackNetFrame(frame=i, x=100 + 4 * i, y=200, visible=(i % 5 != 4), confidence=0.7) for i in range(10)]
    summary = shuttle_summary(frames, fps=30.0, width=1920, height=1080)
    assert summary["frames_total"] == 10
    assert summary["frames_visible"] == 8
    assert summary["visible_runs"] == 2
    assert "not physical speed" in summary["units"]
    assert summary["step_px_per_frame_max"] == 4.0


def test_movement_can_skip_short_tracks():
    tracker = IouTracker(frame_height=720, min_hits=1)
    observations = []
    for frame in range(20):
        observations.extend(tracker.update(frame, [_det(100 + frame, 300)]))
    observations.extend(IouTracker(frame_height=720, min_hits=1).update(50, [_det(900, 300)]))  # one short track
    kept = compute_player_movements(observations, fps=30.0, width=1280, height=720, total_frames=60, min_observed_frames=15)
    assert [m.track_id for m in kept] == [1]
