import numpy as np
import pytest

from app.ai.shuttle_tracking.inpaint import generate_inpaint_mask, refine_trajectory
from app.ai.shuttle_tracking.tracknet import (
    MODEL_HEIGHT,
    MODEL_WIDTH,
    NonOverlappingShuttleTracker,
    TrackNetFrame,
    build_window_input,
    heatmap_to_point,
    heatmaps_to_frames,
    median_background,
    model_point_to_source,
    position_weights,
)


def test_position_weights_match_tracknetv3_ensemble_for_seq_len_8():
    weights = position_weights(8)
    expected = np.array([1, 2, 3, 4, 4, 3, 2, 1], dtype=float) / 20.0
    assert np.allclose(weights, expected)
    assert np.isclose(weights.sum(), 1.0)


def test_heatmap_to_point_returns_centre_and_peak_confidence():
    heat = np.zeros((MODEL_HEIGHT, MODEL_WIDTH), dtype=np.float32)
    heat[50:60, 100:120] = 0.8
    heat[52:54, 104:106] = 0.95
    cx, cy, conf = heatmap_to_point(heat)
    assert (cx, cy) == (110, 55)
    assert conf == pytest.approx(0.95)


def test_heatmap_below_threshold_is_not_visible():
    heat = np.full((MODEL_HEIGHT, MODEL_WIDTH), 0.4, dtype=np.float32)
    assert heatmap_to_point(heat) == (0, 0, 0.0)


def test_largest_region_wins_when_several_blobs_exist():
    heat = np.zeros((MODEL_HEIGHT, MODEL_WIDTH), dtype=np.float32)
    heat[10:12, 10:12] = 0.9
    heat[100:130, 300:340] = 0.9
    cx, cy, _ = heatmap_to_point(heat)
    assert (cx, cy) == (320, 115)


def test_model_point_scales_to_source_resolution():
    assert model_point_to_source(256, 144, 1920, 1080) == (960, 540)
    assert model_point_to_source(0, 0, 1920, 1080) == (0, 0)


def test_heatmaps_to_frames_marks_empty_heatmaps_invisible():
    heat = np.zeros((2, MODEL_HEIGHT, MODEL_WIDTH), dtype=np.float32)
    heat[0, 10:14, 20:24] = 0.9
    frames = heatmaps_to_frames(heat, [7, 8], 1024, 576)
    assert frames[0].visible is True and frames[0].frame == 7
    assert frames[1].visible is False and (frames[1].x, frames[1].y) == (0, 0)


def test_window_input_puts_median_first_and_scales_to_unit_range():
    median = np.full((MODEL_HEIGHT, MODEL_WIDTH, 3), 255, dtype=np.uint8)
    frames = np.zeros((8, MODEL_HEIGHT, MODEL_WIDTH, 3), dtype=np.uint8)
    tensor = build_window_input(frames, median, "concat")
    assert tensor.shape == (27, MODEL_HEIGHT, MODEL_WIDTH)
    assert tensor.dtype == np.float32
    assert float(tensor[:3].min()) == pytest.approx(1.0)
    assert float(tensor[3:].max()) == pytest.approx(0.0)


def test_median_background_is_uint8_median():
    samples = [np.full((4, 4, 3), v, dtype=np.uint8) for v in (10, 20, 200)]
    median = median_background(samples)
    assert median.dtype == np.uint8
    assert int(median[0, 0, 0]) == 20


def _fake_infer_factory(seq_len, record):
    def infer(batch):
        record.append(batch.shape)
        out = np.zeros((batch.shape[0], seq_len, MODEL_HEIGHT, MODEL_WIDTH), dtype=np.float32)
        for b in range(batch.shape[0]):
            for p in range(seq_len):
                x0 = 10 * p
                out[b, p, 100:110, x0 : x0 + 10] = 0.9
        return out

    return infer


def test_non_overlapping_tracker_maps_each_position_to_its_frame():
    record = []
    median = np.zeros((MODEL_HEIGHT, MODEL_WIDTH, 3), dtype=np.uint8)
    tracker = NonOverlappingShuttleTracker(
        infer=_fake_infer_factory(8, record),
        median_rgb=median,
        src_w=MODEL_WIDTH * 2,
        src_h=MODEL_HEIGHT * 2,
        seq_len=8,
        bg_mode="concat",
        batch_size=4,
    )
    results = []
    frame = np.zeros((MODEL_HEIGHT, MODEL_WIDTH, 3), dtype=np.uint8)
    for index in range(10):
        results.extend(tracker.push(index, frame))
    results.extend(tracker.finish())
    assert [r.frame for r in results] == list(range(10))
    # position p has model centre x = 10*p + 5, scaled by 2 for the source resolution
    for r in results:
        p = r.frame % 8
        assert r.visible is True
        assert r.x == 2 * (10 * p + 5)
        assert r.y == 2 * 105
    assert record and record[0] == (2, 27, MODEL_HEIGHT, MODEL_WIDTH)  # two windows, padded tail window


def test_inpaint_mask_fills_hidden_segment_between_low_detections():
    visible = [0, 0, 0, 1, 1, 1]
    y = [0, 0, 0, 500, 500, 500]
    mask = generate_inpaint_mask(y, visible, th_h=100)
    assert mask.tolist() == [1, 1, 1, 0, 0, 0]


def test_inpaint_mask_is_empty_when_always_visible():
    mask = generate_inpaint_mask([100, 110, 120], [1, 1, 1], th_h=50)
    assert mask.tolist() == [0, 0, 0]


def test_refine_trajectory_keeps_visible_points_when_model_is_identity():
    frames = [TrackNetFrame(frame=i, x=100 + 2 * i, y=200, visible=True, confidence=0.9) for i in range(20)]

    def identity(coords, mask):
        return coords.copy()

    refined = refine_trajectory(frames, 1920, 1080, identity, seq_len=16)
    assert len(refined) == 20
    for before, after in zip(frames, refined):
        assert abs(before.x - after.x) <= 1
        assert abs(before.y - after.y) <= 1
        assert after.refined is False


def test_refine_trajectory_changes_hidden_frames_when_model_predicts_coordinates():
    frames = []
    for i in range(20):
        visible = i < 8 or i > 12
        frames.append(TrackNetFrame(frame=i, x=(100 + i) if visible else 0, y=(500 if visible else 0), visible=visible, confidence=0.5 if visible else 0.0))

    def fill(coords, mask):
        # replace masked positions with a constant location inside the frame
        out = coords.copy()
        out[..., 0] = np.where(mask[..., 0] > 0, 0.5, out[..., 0])
        out[..., 1] = np.where(mask[..., 0] > 0, 0.5, out[..., 1])
        return out

    refined = refine_trajectory(frames, 1000, 1000, fill, seq_len=16)
    hidden = [r for r in refined if 8 <= r.frame <= 12]
    assert any(r.refined for r in hidden)
    assert all(r.x in (0, 500) for r in hidden)
