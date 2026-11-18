#!/usr/bin/env python3
"""Synthetic ground-truth benchmark for the experimental 3D speed estimator."""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from app.physics.camera import look_at_camera  # noqa: E402
from app.physics.speed3d import estimate_shot_speed  # noqa: E402
from app.physics.trajectory import drag_coefficient, integrate_state, speed_kmh  # noqa: E402


def scenario(fps: int, noise_px: float, gap_fraction: float, seed: int) -> dict:
    camera = look_at_camera((3.05, -8.0, 6.0), (3.05, 6.70, 1.5))
    initial = np.array([3.0, 2.0, 2.2, 1.5, 28.0, 7.0])
    truth_kmh = speed_kmh(initial)
    times = np.arange(0.0, 0.60, 1.0 / fps)
    states = integrate_state(initial, 0.0, times, drag_coefficient())
    pixels, _ = camera.project(states[:, :3])
    rng = np.random.default_rng(seed)
    pixels += rng.normal(0.0, noise_px, pixels.shape)
    missing = set(rng.choice(len(times), size=round(gap_fraction * len(times)), replace=False).tolist()) if gap_fraction else set()
    missing.discard(0)
    frames = [
        {"frame": index, "time_s": float(timestamp), "x": float(pixel[0]), "y": float(pixel[1]), "visible": True, "confidence": 0.9, "refined": False}
        for index, (timestamp, pixel) in enumerate(zip(times, pixels))
        if index not in missing
    ]
    began = time.perf_counter()
    result = estimate_shot_speed(
        contact={"frame": 0, "status": "confirmed"},
        shuttle_doc={"timestamp_source": "presentation_timestamp", "frames": frames},
        court_doc={"camera_3d": camera.as_dict()},
        width=1920,
        height=1080,
        run_sensitivity=True,
    )
    estimate = result["speed_first_observed_kmh"]
    error = None if estimate is None else estimate - truth_kmh
    return {
        "fps": fps,
        "noise_px": noise_px,
        "gap_fraction": gap_fraction,
        "observations": len(frames),
        "truth_kmh": round(truth_kmh, 4),
        "status": result["status"],
        "estimate_kmh": estimate,
        "absolute_error_kmh": None if error is None else round(abs(error), 4),
        "relative_error_fraction": None if error is None else round(abs(error) / truth_kmh, 6),
        "reprojection_rms_px": result.get("quality", {}).get("reprojection_rms_px"),
        "uncertainty_kmh": result.get("uncertainty_kmh"),
        "uncertainty_contains_truth": (
            None
            if result.get("uncertainty_kmh") is None
            else result["uncertainty_kmh"][0] <= truth_kmh <= result["uncertainty_kmh"][1]
        ),
        "reason_codes": result["reason_codes"],
        "runtime_s": round(time.perf_counter() - began, 3),
    }


def main() -> None:
    rows = []
    for fps in (30, 60, 120, 240):
        rows.append(scenario(fps, 0.0, 0.0, fps))
        rows.append(scenario(fps, 1.5, 0.10, fps + 1))
        rows.append(scenario(fps, 4.0, 0.30, fps + 2))
    accepted = [row for row in rows if row["status"] == "available"]
    errors = [row["absolute_error_kmh"] for row in accepted]
    relative = [row["relative_error_fraction"] for row in accepted]
    covered = [row["uncertainty_contains_truth"] for row in accepted if row["uncertainty_contains_truth"] is not None]
    document = {
        "schema": "smashlab.speed3d.synthetic-benchmark/v1",
        "method": "known quadratic-drag trajectory projected through a known pinhole camera",
        "scenarios": rows,
        "summary": {
            "scenarios": len(rows),
            "accepted": len(accepted),
            "failure_rate": round((len(rows) - len(accepted)) / len(rows), 4),
            "mae_kmh": None if not errors else round(float(np.mean(errors)), 4),
            "median_relative_error_fraction": None if not relative else round(float(np.median(relative)), 6),
            "max_relative_error_fraction": None if not relative else round(max(relative), 6),
            "uncertainty_coverage": None if not covered else round(sum(covered) / len(covered), 4),
        },
    }
    print(json.dumps(document, indent=2))


if __name__ == "__main__":
    main()
