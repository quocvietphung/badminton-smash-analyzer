from __future__ import annotations

from dataclasses import dataclass
from math import exp


@dataclass(frozen=True)
class StrokeResult:
    stroke_type: str
    stroke_label: str
    confidence: float
    estimated_shuttle_speed_kmh: float | None = None


def _clamp(value: float, minimum: float = 0.0, maximum: float = 1.0) -> float:
    return min(maximum, max(minimum, value))


def estimate_smash_speed_kmh(
    *,
    wrist_speed: float,
    arm_angular_speed: float,
    contact_height: float,
    body_extension: float,
) -> float:
    """Return a pose-based estimate, not a calibrated shuttlecock measurement."""

    # Pose landmarks can jump for a single camera frame. Soft saturation keeps
    # those spikes from forcing every strong swing to the same maximum speed.
    stable_wrist_speed = _clamp(wrist_speed, 0, 4)
    stable_angular_speed = _clamp(arm_angular_speed, 0, 1400)
    estimate = (
        125
        + 145 * (1 - exp(-stable_wrist_speed / 1.35))
        + 42 * (1 - exp(-stable_angular_speed / 420))
        + _clamp(contact_height - 50, 0, 40) * 0.35
        + _clamp(body_extension, 0, 100) * 0.12
    )
    return round(_clamp(estimate, 120, 340), 1)


def classify_stroke(
    *,
    wrist_speed: float,
    elbow_angle: float,
    shoulder_angle: float,
    contact_height: float,
    arm_angular_speed: float,
    body_extension: float,
    wrist_above_shoulder: bool,
    is_contact: bool,
) -> StrokeResult:
    """Describe a pose peak without pretending it proves the shuttle trajectory."""

    overhead = wrist_above_shoulder or contact_height >= 55 or shoulder_angle >= 100
    explosive = wrist_speed >= 0.95 or arm_angular_speed >= 260

    if not is_contact or wrist_speed < 0.35:
        return StrokeResult("motion", "Đang chuyển động", 0.45)

    if overhead and explosive:
        confidence = _clamp(
            0.64
            + max(0, wrist_speed - 0.95) * 0.16
            + max(0, arm_angular_speed - 180) / 2500
            + max(0, contact_height - 55) / 300,
        )
        speed_kmh = estimate_smash_speed_kmh(
            wrist_speed=wrist_speed,
            arm_angular_speed=arm_angular_speed,
            contact_height=contact_height,
            body_extension=body_extension,
        )
        return StrokeResult(
            "overhead",
            "Cú trên đầu mạnh · chờ đường cầu",
            min(confidence, 0.72),
            speed_kmh,
        )

    if overhead:
        confidence = _clamp(0.5 + max(0, wrist_speed - 0.35) * 0.12, 0, 0.64)
        return StrokeResult("overhead", "Cú trên đầu · chờ đường cầu", confidence)

    if wrist_speed >= 0.78 and contact_height < 55:
        confidence = _clamp(0.52 + (wrist_speed - 0.78) * 0.18)
        return StrokeResult("drive_candidate", "Cú ngang · chờ đường cầu", confidence)

    return StrokeResult("unknown", "Chưa đủ dữ liệu phân loại", 0.4)
