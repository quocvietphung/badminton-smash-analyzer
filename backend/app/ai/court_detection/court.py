"""Classical court calibration: white-line detection and template homography search.

Method (no learned model):
1. Floor mask: saturated pixels (green, blue or wood floors) inside the largest floor component.
2. White-line response: white top-hat of the grey image inside the floor, thresholded per frame.
3. Line segments from LSD on the floor region; a segment is kept only if the pixels along it are
   white (rejects banners and colour edges), then split into near-horizontal and near-vertical families.
4. Candidate quadrilaterals from pairs of horizontal and vertical segments.
5. Each quadrilateral gives a homography to a court template (doubles outline 13.40 m x 6.10 m,
   or the singles outline 13.40 m x 5.18 m). It is scored by the share of projected template line
   points that land on white-line pixels, with a minimum visible coverage.
6. Calibration is reported only when the best score and coverage pass thresholds.

The result is an approximate image-to-floor mapping. It is not a racket or shuttle measurement.
"""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass, field
from typing import Optional, Sequence

import cv2
import numpy as np

COURT_LENGTH_M = 13.40
COURT_WIDTH_M = 6.10
SINGLES_INSET_M = 0.46
NET_Y_M = COURT_LENGTH_M / 2.0
SHORT_SERVICE_OFFSET_M = 1.98
LONG_SERVICE_DOUBLES_M = 0.76
MIN_SCORE = 0.55
MIN_COVERAGE = 0.5
MIN_OUTLINE = 0.45
WORK_WIDTH = 960
WHITE_TOPHAT_KERNEL = 21
WHITE_PERCENTILE = 88
WHITE_MIN_THRESHOLD = 35
MIN_SEGMENT_RATIO = 0.12


@dataclass
class CourtEstimate:
    status: str
    reason: str
    score: float = 0.0
    coverage: float = 0.0
    template: str = ""
    homography_image_from_court: Optional[list[list[float]]] = None
    quad_image: Optional[list[list[float]]] = None
    extra: dict = field(default_factory=dict)

    @property
    def calibrated(self) -> bool:
        return self.status == "calibrated"

    def to_dict(self) -> dict:
        payload = {
            "status": self.status,
            "reason": self.reason,
            "template": self.template,
            "score": round(self.score, 4),
            "coverage": round(self.coverage, 4),
            "quad_image_px": self.quad_image,
            "homography_image_from_court": self.homography_image_from_court,
            "coordinate_space": "floor-plane metres: x across the court (0 to 6.10 doubles or 0.46 to 5.64 singles), "
            "y along the court (0 to 13.40), origin at one corner of the template",
            "approximation": "flat floor plane; players' feet are assumed to stand on the floor",
        }
        payload.update(self.extra)
        return payload


@dataclass(frozen=True)
class Template:
    name: str
    corners: tuple[tuple[float, float], ...]
    lines: tuple[tuple[tuple[float, float], tuple[float, float]], ...]
    outline: tuple[bool, ...] = ()


def _template(name: str, singles: bool) -> Template:
    length = COURT_LENGTH_M
    s = SINGLES_INSET_M
    w = COURT_WIDTH_M
    left, right = (s, w - s) if singles else (0.0, w)
    net = NET_Y_M
    short_a = net - SHORT_SERVICE_OFFSET_M
    short_b = net + SHORT_SERVICE_OFFSET_M
    back_a = LONG_SERVICE_DOUBLES_M
    back_b = length - LONG_SERVICE_DOUBLES_M
    centre = w / 2.0
    lines = [
        ((left, 0.0), (right, 0.0)),
        ((right, 0.0), (right, length)),
        ((right, length), (left, length)),
        ((left, length), (left, 0.0)),
        ((s, 0.0), (s, length)),
        ((w - s, 0.0), (w - s, length)),
        ((0.0, net), (w, net)),
        ((s, short_a), (w - s, short_a)),
        ((s, short_b), (w - s, short_b)),
        ((centre, short_a), (centre, short_b)),
        ((s, back_a), (w - s, back_a)),
        ((s, back_b), (w - s, back_b)),
    ]
    if singles:
        # doubles-only outer sidelines are not part of the singles outline
        lines = [seg for seg in lines if not (seg[0][0] == 0.0 and seg[1][0] == 0.0)]
    corners = ((left, 0.0), (right, 0.0), (right, length), (left, length))
    outline = []
    for (x1, y1), (x2, y2) in lines:
        is_side = abs(x1 - x2) < 1e-9 and (abs(x1 - left) < 1e-9 or abs(x1 - right) < 1e-9)
        is_baseline = abs(y1 - y2) < 1e-9 and (abs(y1) < 1e-9 or abs(y1 - length) < 1e-9)
        outline.append(bool(is_side or is_baseline))
    return Template(name=name, corners=corners, lines=tuple(lines), outline=tuple(outline))


DOUBLES = _template("doubles 13.40 m x 6.10 m", singles=False)
SINGLES = _template("singles 13.40 m x 5.18 m", singles=True)


def _template_points(template: Template, samples_per_segment: int = 40):
    """Sample points along each template line; returns points (N, 2) and the line index for each point."""
    points = []
    owners = []
    for index, ((x1, y1), (x2, y2)) in enumerate(template.lines):
        for t in np.linspace(0.0, 1.0, samples_per_segment):
            points.append((x1 + (x2 - x1) * t, y1 + (y2 - y1) * t))
            owners.append(index)
    return np.asarray(points, dtype=np.float64), np.asarray(owners, dtype=np.int64)


def floor_mask(bgr: np.ndarray) -> np.ndarray:
    """Floor region: saturated pixels that share the dominant hue of the lower two thirds of the frame.

    Picking the hue from the lower part of the frame keeps the court colour and excludes saturated
    backdrops (for example blue walls) that sit higher in the image.
    """
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    hue, sat, val = hsv[..., 0].astype(np.int32), hsv[..., 1], hsv[..., 2]
    saturated = (sat > 60) & (val > 40)
    lower = np.zeros(saturated.shape, dtype=bool)
    lower[saturated.shape[0] // 3 :, :] = True
    counts = np.bincount(hue[saturated & lower].ravel(), minlength=180).astype(np.float64)
    if counts.sum() == 0:
        return np.zeros(saturated.shape, dtype=np.uint8)
    padded = np.concatenate([counts[-4:], counts, counts[:4]])
    smooth = np.convolve(padded, np.ones(9), mode="valid")[:180]
    peak = int(np.argmax(smooth))
    hue_gap = np.minimum(np.abs(hue - peak), 180 - np.abs(hue - peak))
    candidate = (saturated & (hue_gap <= 14)).astype(np.uint8)
    candidate = cv2.morphologyEx(candidate, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(candidate, connectivity=8)
    if count <= 1:
        return np.zeros(saturated.shape, dtype=np.uint8)
    largest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    region = (labels == largest).astype(np.uint8)
    contours, _ = cv2.findContours(region, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros_like(region)
    if contours:
        cv2.drawContours(filled, [max(contours, key=cv2.contourArea)], -1, 1, thickness=cv2.FILLED)
    return filled


def white_tophat(bgr: np.ndarray, floor: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Return (white-line mask 0/255, top-hat response) restricted to the floor region."""
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    tophat = cv2.morphologyEx(gray, cv2.MORPH_TOPHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (WHITE_TOPHAT_KERNEL, WHITE_TOPHAT_KERNEL)))
    inside = floor > 0
    if not inside.any():
        return np.zeros(gray.shape, dtype=np.uint8), tophat
    threshold = max(WHITE_MIN_THRESHOLD, int(np.percentile(tophat[inside], WHITE_PERCENTILE)))
    mask = ((tophat >= threshold) & inside).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    return mask, tophat


def white_segments(bgr: np.ndarray, floor: np.ndarray, tophat: np.ndarray, white_mask: np.ndarray) -> list[tuple[float, float, float, float]]:
    """LSD segments on the floor region that are long enough and mostly white along their length."""
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    region = cv2.dilate(floor, np.ones((9, 9), np.uint8))
    detector = cv2.createLineSegmentDetector(cv2.LSD_REFINE_STD)
    found = detector.detect(cv2.bitwise_and(gray, gray, mask=region))[0]
    if found is None:
        return []
    height, width = gray.shape
    min_length = MIN_SEGMENT_RATIO * width
    # LSD endpoints sit on the edges of thin lines, so the white mask is widened before sampling
    wide_white = cv2.dilate(white_mask, np.ones((5, 5), np.uint8))
    kept = []
    for row in np.asarray(found).reshape(-1, 4):
        x1, y1, x2, y2 = (float(v) for v in row)
        length = math.hypot(x2 - x1, y2 - y1)
        if length < min_length:
            continue
        samples = np.linspace(0.0, 1.0, max(8, int(length // 4)))
        xs = np.clip(np.round(x1 + (x2 - x1) * samples).astype(int), 0, width - 1)
        ys = np.clip(np.round(y1 + (y2 - y1) * samples).astype(int), 0, height - 1)
        white_share = float((wide_white[ys, xs] > 0).mean())
        if white_share >= 0.4:
            kept.append((x1, y1, x2, y2))
    return kept


def hough_white_segments(white_mask: np.ndarray) -> list[tuple[float, float, float, float]]:
    """Probabilistic Hough segments on the white-line mask (every segment lies on white pixels)."""
    min_length = max(20, int(MIN_SEGMENT_RATIO * white_mask.shape[1]))
    lines = cv2.HoughLinesP(white_mask, 1, np.pi / 180, threshold=30, minLineLength=min_length, maxLineGap=30)
    if lines is None:
        return []
    return [tuple(map(float, row)) for row in np.asarray(lines).reshape(-1, 4)]


def dedupe_segments(segments, angle_tol_deg: float = 3.0, distance_tol_px: float = 8.0):
    """Keep the longest of each group of near-identical segments (same angle, same position)."""
    def length(seg):
        return math.hypot(seg[2] - seg[0], seg[3] - seg[1])

    kept = []
    for seg in sorted(segments, key=lambda s: -length(s)):
        angle = _angle_deg(seg)
        mid_x = (seg[0] + seg[2]) / 2.0
        mid_y = (seg[1] + seg[3]) / 2.0
        duplicate = False
        for other in kept:
            diff = abs(angle - _angle_deg(other)) % 180.0
            if min(diff, 180.0 - diff) > angle_tol_deg:
                continue
            dx = other[2] - other[0]
            dy = other[3] - other[1]
            norm = math.hypot(dx, dy)
            if norm == 0:
                continue
            distance = abs(dx * (other[1] - mid_y) - dy * (other[0] - mid_x)) / norm
            if distance <= distance_tol_px:
                duplicate = True
                break
        if not duplicate:
            kept.append(seg)
    return kept


def _angle_deg(seg: tuple[float, float, float, float]) -> float:
    x1, y1, x2, y2 = seg
    return math.degrees(math.atan2(y2 - y1, x2 - x1)) % 180.0


def split_families(segments: Sequence[tuple[float, float, float, float]], tolerance_deg: float = 35.0):
    horizontal, vertical = [], []
    for seg in segments:
        angle = _angle_deg(seg)
        if min(angle, 180 - angle) <= tolerance_deg:
            horizontal.append(seg)
        elif abs(angle - 90.0) <= tolerance_deg:
            vertical.append(seg)
    horizontal.sort(key=lambda s: -math.hypot(s[2] - s[0], s[3] - s[1]))
    vertical.sort(key=lambda s: -math.hypot(s[2] - s[0], s[3] - s[1]))
    return horizontal[:12], vertical[:12]


def _line_through(seg):
    x1, y1, x2, y2 = seg
    return y1 - y2, x2 - x1, x1 * y2 - x2 * y1


def intersect(seg_a, seg_b) -> Optional[np.ndarray]:
    a1, b1, c1 = _line_through(seg_a)
    a2, b2, c2 = _line_through(seg_b)
    det = a1 * b2 - a2 * b1
    if abs(det) < 1e-9:
        return None
    x = (b1 * c2 - b2 * c1) / det
    y = (c1 * a2 - c2 * a1) / det
    return np.array([x, y], dtype=np.float64)


def _convex_order(points: np.ndarray) -> Optional[np.ndarray]:
    centre = points.mean(axis=0)
    angles = np.arctan2(points[:, 1] - centre[1], points[:, 0] - centre[0])
    ordered = points[np.argsort(angles)]
    if not cv2.isContourConvex(ordered.astype(np.float32)):
        return None
    return ordered


def candidate_quads(horizontal, vertical, shape: tuple[int, int]) -> list[np.ndarray]:
    height, width = shape
    margin = 0.25

    def inside(p) -> bool:
        return (-margin * width <= p[0] <= (1 + margin) * width) and (-margin * height <= p[1] <= (1 + margin) * height)

    quads = []
    for h1, h2 in itertools.combinations(horizontal, 2):
        for v1, v2 in itertools.combinations(vertical, 2):
            corners = [intersect(h1, v1), intersect(h1, v2), intersect(h2, v1), intersect(h2, v2)]
            if any(c is None or not inside(c) for c in corners):
                continue
            quad = _convex_order(np.array(corners))
            if quad is None:
                continue
            if cv2.contourArea(quad.astype(np.float32)) < 0.04 * width * height:
                continue
            quads.append(quad)
    return quads


def _score_homography(h_court_from_image: np.ndarray, mask_distance: np.ndarray, template_pts, image_shape, outline=None):
    """Return (share of template points on white lines, share of points inside the image, weakest outline hit share)."""
    points, owners = template_pts
    h_image_from_court = np.linalg.inv(h_court_from_image)
    homogeneous = np.hstack([points, np.ones((points.shape[0], 1))])
    projected = homogeneous @ h_image_from_court.T
    depth = projected[:, 2:3]
    if np.any(np.abs(depth) < 1e-9):
        return 0.0, 0.0, 0.0
    pts = projected[:, :2] / depth
    height, width = image_shape
    inside = (pts[:, 0] >= 0) & (pts[:, 0] < width) & (pts[:, 1] >= 0) & (pts[:, 1] < height)
    coverage = float(inside.mean())
    if inside.sum() < 0.5 * len(points):
        return 0.0, coverage, 0.0
    xs = np.clip(pts[:, 0], 0, width - 1).astype(int)
    ys = np.clip(pts[:, 1], 0, height - 1).astype(int)
    hits = (mask_distance[ys, xs] <= 3.0) & inside
    score = float(hits.sum() / inside.sum())
    weakest = 1.0
    if outline is not None:
        checked = False
        for line_index, is_outline in enumerate(outline):
            if not is_outline:
                continue
            on_line = owners == line_index
            visible = on_line & inside
            if visible.sum() < 0.3 * on_line.sum():
                continue
            checked = True
            weakest = min(weakest, float(hits[visible].mean()))
        if not checked:
            weakest = 0.0
    return score, coverage, weakest


def _best_fit(quads, template: Template, distance: np.ndarray, image_shape):
    template_pts = _template_points(template)
    corners = np.array(template.corners, dtype=np.float32)
    best = (0.0, 0.0, 0.0, None, None)
    for quad in quads:
        for shift in range(4):
            ordered = np.roll(quad, shift, axis=0).astype(np.float32)
            for reflect in (False, True):
                targets = corners[::-1] if reflect else corners
                h_court_from_image = cv2.getPerspectiveTransform(ordered, targets.astype(np.float32))
                score, coverage, weakest = _score_homography(
                    h_court_from_image, distance, template_pts, image_shape, outline=template.outline
                )
                # rank by the outline-aware score so quads that leave outline lines unsupported lose
                rank = min(score, weakest + 0.25)
                if rank > best[0] or (rank == best[0] and coverage > best[1]):
                    best = (rank, coverage, weakest, h_court_from_image, ordered)
    return best


def estimate_court(bgr: np.ndarray) -> CourtEstimate:
    """Estimate the floor-to-image homography from a background frame (BGR, any resolution)."""
    original_h, original_w = bgr.shape[:2]
    scale = min(1.0, WORK_WIDTH / float(original_w))
    work = cv2.resize(bgr, (int(round(original_w * scale)), int(round(original_h * scale))), interpolation=cv2.INTER_AREA)
    work_h, work_w = work.shape[:2]

    floor = floor_mask(work)
    if floor.sum() < 0.05 * work_w * work_h:
        return CourtEstimate("failed", "no dominant floor region was found")
    white, tophat = white_tophat(work, floor)
    if white.sum() == 0:
        return CourtEstimate("failed", "no white court lines were found on the floor")
    segments = dedupe_segments(white_segments(work, floor, tophat, white) + hough_white_segments(white))
    horizontal, vertical = split_families(segments)
    if len(horizontal) < 2 or len(vertical) < 2:
        return CourtEstimate(
            "failed",
            "not enough horizontal and vertical white court lines were visible",
            extra={"white_segments": len(segments), "horizontal": len(horizontal), "vertical": len(vertical)},
        )
    quads = candidate_quads(horizontal, vertical, (work_h, work_w))
    if not quads:
        return CourtEstimate("failed", "no plausible court quadrilateral was found", extra={"white_segments": len(segments)})

    distance = cv2.distanceTransform((white == 0).astype(np.uint8), cv2.DIST_L2, 3)
    fits = []
    # The outer white lines of a broadcast court are the doubles boundary, so only the doubles outline is fitted.
    for template in (DOUBLES,):
        rank, coverage, weakest, h_court_from_image, quad = _best_fit(quads, template, distance, (work_h, work_w))
        fits.append(_Fit(rank, coverage, h_court_from_image, quad, template, weakest))
    best = max(fits, key=lambda fit: (fit.score_value, fit.coverage))
    if best.h_court_from_image is None or best.score_value < MIN_SCORE or best.coverage < MIN_COVERAGE or best.weakest_outline < MIN_OUTLINE:
        return CourtEstimate(
            "failed",
            "the best court fit did not reach the score and coverage thresholds",
            score=best.score_value,
            coverage=best.coverage,
            template=best.template.name,
            extra={"candidate_quads": len(quads), "white_segments": len(segments)},
        )

    to_work = np.diag([scale, scale, 1.0])
    h_court_from_original = best.h_court_from_image @ to_work
    h_image_from_court = np.linalg.inv(h_court_from_original)
    h_image_from_court = h_image_from_court / h_image_from_court[2, 2]
    quad_original = (best.quad / scale).tolist()
    return CourtEstimate(
        "calibrated",
        "template lines matched the detected white court lines",
        score=best.score_value,
        coverage=best.coverage,
        template=best.template.name,
        homography_image_from_court=[[round(float(v), 8) for v in row] for row in h_image_from_court],
        quad_image=[[round(float(x), 2), round(float(y), 2)] for x, y in quad_original],
        extra={"candidate_quads": len(quads), "white_segments": len(segments), "work_scale": round(scale, 4)},
    )


@dataclass
class _Fit:
    score_value: float
    coverage: float
    h_court_from_image: Optional[np.ndarray]
    quad: Optional[np.ndarray]
    template: Template
    weakest_outline: float = 0.0


def image_to_court(h_image_from_court: Sequence[Sequence[float]], points_xy: np.ndarray) -> np.ndarray:
    """Map image points (N, 2) to court metres using the inverse of H_image_from_court."""
    h_court_from_image = np.linalg.inv(np.asarray(h_image_from_court, dtype=np.float64))
    pts = np.asarray(points_xy, dtype=np.float64).reshape(-1, 2)
    homogeneous = np.hstack([pts, np.ones((pts.shape[0], 1))])
    mapped = homogeneous @ h_court_from_image.T
    return mapped[:, :2] / mapped[:, 2:3]
