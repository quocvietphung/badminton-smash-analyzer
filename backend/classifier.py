from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class StrokeResult:
    stroke_type: str
    stroke_label: str
    confidence: float
    estimated_shuttle_speed_kmh: None = None


def _clamp(value: float, minimum: float = 0.0, maximum: float = 1.0) -> float:
    return min(maximum, max(minimum, value))


def classify_stroke(
    *,
    wrist_speed: float,
    elbow_angle: float,
    shoulder_angle: float,
    contact_height: float,
    is_contact: bool,
) -> StrokeResult:
    """Classify pose metrics without pretending to measure shuttlecock speed."""

    overhead = contact_height >= 50 and shoulder_angle >= 75

    if not is_contact or wrist_speed < 0.35:
        return StrokeResult("motion", "Đang chuyển động", 0.45)

    if overhead and wrist_speed >= 1.05 and elbow_angle >= 135:
        confidence = _clamp(
            0.62
            + (wrist_speed - 1.05) * 0.12
            + (elbow_angle - 135) / 180
            + (contact_height - 50) / 250,
        )
        return StrokeResult("smash", "Smash", confidence)

    if overhead and wrist_speed >= 0.68 and elbow_angle < 135:
        confidence = _clamp(0.53 + (wrist_speed - 0.68) * 0.18)
        return StrokeResult("slice", "Cắt / chặt cầu", confidence)

    if overhead and wrist_speed < 0.68:
        confidence = _clamp(0.56 + (0.68 - wrist_speed) * 0.3)
        return StrokeResult("drop_shot", "Bỏ nhỏ", confidence)

    if wrist_speed >= 0.78 and shoulder_angle < 105:
        confidence = _clamp(0.52 + (wrist_speed - 0.78) * 0.18)
        return StrokeResult("drive", "Tạt cầu", confidence)

    return StrokeResult("clear", "Phông cầu", 0.5)
