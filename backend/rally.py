from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from math import hypot

from classifier import estimate_smash_speed_kmh


@dataclass(frozen=True)
class CourtPoint:
    x: float
    y: float


@dataclass(frozen=True)
class RallyStroke:
    hitter: str
    stroke_type: str
    stroke_label: str
    start: CourtPoint
    end: CourtPoint
    confidence: float


@dataclass(frozen=True)
class TrajectoryResult:
    stroke_type: str
    stroke_label: str
    stroke_variant: str
    stroke_variant_label: str | None
    classification_status: str
    classification_basis: str
    estimated_shuttle_speed_kmh: float | None
    length_type: str
    length_label: str
    direction_type: str
    direction_label: str
    landing_zone: str
    court_distance_m: float
    confidence: float


def _clamp(value: float, minimum: float = 0.0, maximum: float = 1.0) -> float:
    return min(maximum, max(minimum, value))


def analyze_trajectory(
    *,
    hitter: str,
    start: CourtPoint,
    end: CourtPoint,
    source_confidence: float,
    wrist_speed: float = 0.0,
    arm_angular_speed: float = 0.0,
    contact_height: float = 0.0,
    body_extension: float = 0.0,
    wrist_above_shoulder: bool = False,
) -> TrajectoryResult:
    """Classify a stroke from pose plus the next estimated contact position.

    The destination is the opponent's next contact position, not a tracked
    shuttle landing point. Results therefore stay explicitly probabilistic.
    """

    hitter_key = hitter.upper()
    if hitter_key not in {"A", "B"}:
        raise ValueError("hitter must be A or B")

    # Player A is the near-court player (y > .5), B is the far-court player.
    opponent_depth = (
        _clamp((0.5 - end.y) / 0.5)
        if hitter_key == "A"
        else _clamp((end.y - 0.5) / 0.5)
    )
    source_depth = (
        _clamp((start.y - 0.5) / 0.5)
        if hitter_key == "A"
        else _clamp((0.5 - start.y) / 0.5)
    )
    if opponent_depth < 0.34:
        length_type, length_label = "short", "Ngắn"
    elif opponent_depth < 0.7:
        length_type, length_label = "medium", "Trung bình"
    else:
        length_type, length_label = "long", "Dài"

    lateral_change = abs(end.x - start.x)
    if lateral_change >= 0.28:
        direction_type, direction_label = "cross", "Chéo sân"
    else:
        direction_type, direction_label = "straight", "Thẳng"

    side = "trái" if end.x < 0.5 else "phải"
    landing_zone = f"{length_label.lower()} · {side}"
    distance_m = hypot((end.x - start.x) * 6.1, (end.y - start.y) * 13.4)
    geometry_confidence = 0.92 if 0 <= end.x <= 1 and 0 <= end.y <= 1 else 0.55
    overhead = wrist_above_shoulder or contact_height >= 55
    wrist_power = _clamp((wrist_speed - 0.4) / 1.5)
    angular_power = _clamp((arm_angular_speed - 40) / 520)
    power = max(wrist_power, angular_power)
    rear_or_mid_contact = source_depth >= 0.28

    stroke_type = "unknown"
    stroke_label = "Chưa chắc loại cú đánh"
    stroke_variant = "unverified"
    stroke_variant_label: str | None = None
    rule_confidence = 0.48

    if overhead and rear_or_mid_contact and opponent_depth < 0.34:
        stroke_type = "drop_shot"
        stroke_label = "Drop shot"
        stroke_variant_label = "Cắt/chặt: chưa xác minh"
        rule_confidence = 0.72 + min(0.08, (0.34 - opponent_depth) * 0.2)
    elif overhead and opponent_depth >= 0.7:
        if power >= 0.78 and contact_height >= 64:
            stroke_type = "smash"
            stroke_label = "Smash"
            stroke_variant = "full_smash"
            stroke_variant_label = "Smash toàn lực · ước tính"
            rule_confidence = 0.7
        else:
            stroke_type = "clear"
            stroke_label = "Clear / phông cầu"
            stroke_variant = "attacking_clear" if power >= 0.5 else "defensive_clear"
            stroke_variant_label = "Clear tấn công" if power >= 0.5 else "Clear phòng thủ"
            rule_confidence = 0.74
    elif overhead and power >= 0.55 and opponent_depth >= 0.34:
        stroke_type = "smash"
        if power >= 0.78:
            stroke_label = "Smash"
            stroke_variant = "full_smash"
            stroke_variant_label = "Smash toàn lực · ước tính"
            rule_confidence = 0.76
        else:
            stroke_label = "Smash nhẹ"
            stroke_variant = "half_smash"
            stroke_variant_label = "Chặt / half-smash · ước tính"
            rule_confidence = 0.67
    elif not overhead and power >= 0.34 and opponent_depth >= 0.2:
        stroke_type = "drive"
        stroke_label = "Drive / tạt cầu"
        stroke_variant = "none"
        rule_confidence = 0.68
    elif overhead:
        stroke_label = "Cú trên đầu chưa rõ"
        stroke_variant_label = "Cần quỹ đạo cầu để tách smash, drop và clear"

    confidence = _clamp(
        rule_confidence * 0.72
        + source_confidence * 0.18
        + geometry_confidence * 0.1,
        0,
        0.86,
    )
    classification_status = "probable" if confidence >= 0.65 else "uncertain"
    estimated_speed = (
        estimate_smash_speed_kmh(
            wrist_speed=wrist_speed,
            arm_angular_speed=arm_angular_speed,
            contact_height=contact_height,
            body_extension=body_extension,
        )
        if stroke_type == "smash"
        else None
    )

    return TrajectoryResult(
        stroke_type=stroke_type,
        stroke_label=stroke_label,
        stroke_variant=stroke_variant,
        stroke_variant_label=stroke_variant_label,
        classification_status=classification_status,
        classification_basis="Pose + vị trí hai lần tiếp cầu; chưa tracking quả cầu",
        estimated_shuttle_speed_kmh=estimated_speed,
        length_type=length_type,
        length_label=length_label,
        direction_type=direction_type,
        direction_label=direction_label,
        landing_zone=landing_zone,
        court_distance_m=round(distance_m, 2),
        confidence=round(confidence, 3),
    )


def summarize_rally(strokes: list[dict[str, str | float]]) -> dict[str, object]:
    if not strokes:
        return {
            "headline": "Chưa đủ dữ liệu rally",
            "insight": "Cần ít nhất hai lần tiếp cầu để tạo một đường cầu.",
            "dominant_pattern": "Chưa xác định",
            "long_rate": 0.0,
            "cross_rate": 0.0,
        }

    total = len(strokes)
    lengths = Counter(str(stroke["length_type"]) for stroke in strokes)
    directions = Counter(str(stroke["direction_type"]) for stroke in strokes)
    long_rate = lengths["long"] / total
    cross_rate = directions["cross"] / total

    if cross_rate >= 0.6 and long_rate >= 0.5:
        pattern = "Ép cuối sân chéo"
        insight = "Rally thiên về đổi góc sâu, buộc đối thủ di chuyển ngang và lùi cuối sân."
    elif cross_rate >= 0.6:
        pattern = "Điều cầu chéo sân"
        insight = "Bạn đổi hành lang đánh thường xuyên; hãy quan sát khả năng hồi tâm của đối thủ."
    elif long_rate >= 0.6:
        pattern = "Ghim cuối sân"
        insight = "Phần lớn đường cầu đi sâu; có thể xen một cú ngắn để tạo thay đổi trước–sau."
    elif lengths["short"] / total >= 0.45:
        pattern = "Áp lực trên lưới"
        insight = "Rally có nhiều đường cầu ngắn; chú ý chuẩn bị cho pha đối thủ nâng cầu phản công."
    else:
        pattern = "Phân phối cân bằng"
        insight = "Độ dài và hướng cầu khá đa dạng, chưa có một mẫu điều cầu chiếm ưu thế."

    return {
        "headline": f"{total} đường cầu đã phân tích",
        "insight": insight,
        "dominant_pattern": pattern,
        "long_rate": round(long_rate, 3),
        "cross_rate": round(cross_rate, 3),
    }
