import itertools

import numpy as np

from app.ai.player_detection.bytetrack import ByteTracker, hungarian, iou_matrix


def brute_force_cost(cost: np.ndarray) -> float:
    rows, cols = cost.shape
    best = np.inf
    for perm in itertools.permutations(range(cols), rows):
        best = min(best, sum(cost[r, c] for r, c in enumerate(perm)))
    return best


def test_hungarian_matches_brute_force_on_random_square_and_rectangular_matrices():
    rng = np.random.default_rng(7)
    for rows, cols in [(2, 2), (3, 3), (3, 4), (4, 3), (4, 4)]:
        for _ in range(20):
            cost = rng.random((rows, cols))
            pairs = hungarian(cost)
            assert len(pairs) == min(rows, cols)
            assert len({r for r, _ in pairs}) == len(pairs) and len({c for _, c in pairs}) == len(pairs)
            total = sum(cost[r, c] for r, c in pairs)
            assert abs(total - brute_force_cost(cost if rows <= cols else cost.T)) < 1e-9


def test_iou_matrix_values():
    a = np.array([[0, 0, 10, 10.0]])
    b = np.array([[0, 0, 10, 10.0], [5, 0, 15, 10.0], [20, 20, 30, 30.0]])
    iou = iou_matrix(a, b)
    assert np.allclose(iou, [[1.0, 50 / 150, 0.0]])


def _box(x, y, w=40, h=120, score=0.9):
    return [x, y, x + w, y + h, score]


def test_two_moving_boxes_keep_their_ids_over_thirty_frames():
    tracker = ByteTracker(min_hits=3)
    seen: dict[int, set[int]] = {}
    for frame in range(30):
        boxes = np.array([_box(100 + 2 * frame, 300), _box(900 - 2 * frame, 300)])
        for item in tracker.update(frame, boxes):
            seen.setdefault(item.track_id, set()).add(frame)
    assert sorted(seen) == [1, 2]
    assert all(len(frames) == 30 for frames in seen.values())


def test_a_short_occlusion_keeps_the_same_track_id():
    tracker = ByteTracker(min_hits=1, max_age=30)
    first = tracker.update(0, np.array([_box(100, 300)]))
    for frame in range(1, 4):
        tracker.update(frame, np.zeros((0, 5)))
    later = tracker.update(4, np.array([_box(104, 300)]))
    assert first[0].track_id == later[0].track_id


def test_a_low_score_box_extends_an_existing_track_without_a_new_id():
    tracker = ByteTracker(min_hits=1)
    tracker.update(0, np.array([_box(100, 300, score=0.9)]))
    output = tracker.update(1, np.array([_box(101, 300, score=0.2)]))
    assert [item.track_id for item in output] == [1]
    assert output[0].score < 0.5
