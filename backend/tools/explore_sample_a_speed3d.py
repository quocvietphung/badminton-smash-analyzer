#!/usr/bin/env python3
"""Research-only sensitivity sweep for Sample A.

This intentionally bypasses the production calibration gate to answer a scientific
question: how much can plausible monocular camera/contact assumptions change the fitted
speed? Results are diagnostics and must never be copied into the user-facing HUD.
"""

from __future__ import annotations

import argparse
import json
import os
import resource
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from app.physics.camera import approximate_camera_from_floor_homography  # noqa: E402
from app.physics.speed3d import fit_free_monocular, select_observations  # noqa: E402
from app.physics.trajectory import DEFAULT_TERMINAL_VELOCITY_M_S, drag_coefficient  # noqa: E402


def load(path: Path, name: str) -> dict:
    return json.loads((path / name).read_text(encoding="utf-8"))


def relative_spread(values: list[float]) -> float | None:
    if len(values) < 2:
        return None
    median = float(np.median(values))
    return None if median <= 0 else (max(values) - min(values)) / median


def run(job_dir: Path) -> dict:
    results = load(job_dir, "results.json")
    court = load(job_dir, "court_coordinates.json")
    shuttle = load(job_dir, "shuttle_trajectory.json")
    width, height = int(results["video"]["width"]), int(results["video"]["height"])
    fps = float(results["video"]["fps"])
    homography = court["homography_image_from_court"]
    started = time.perf_counter()
    rows = []
    for focal_scale in (0.80, 0.90, 1.00, 1.10, 1.20):
        for principal_y in (-0.05, 0.0, 0.05):
            camera = approximate_camera_from_floor_homography(
                homography,
                width,
                height,
                focal_scale=focal_scale,
                principal_offset_fraction=(0.0, principal_y),
            )
            if camera is None:
                continue
            for contact_frame in (50, 51, 52, 53, 54):
                observations, evidence = select_observations(shuttle["frames"], contact_frame, None, max_seconds=0.60)
                times = np.asarray([item.time_s for item in observations])
                pixels = np.asarray([[item.x, item.y] for item in observations])
                candidates = fit_free_monocular(camera, times, pixels, drag_coefficient()) if len(observations) >= 10 else []
                valid = [item for item in candidates if item.success and not item.at_bounds and np.isfinite(item.cost)]
                if not valid:
                    rows.append({
                        "focal_scale": focal_scale,
                        "principal_y_fraction": principal_y,
                        "contact_frame": contact_frame,
                        "usable_observations": len(observations),
                        "status": "fit_failed",
                    })
                    continue
                valid.sort(key=lambda item: item.cost)
                best = valid[0]
                competitive = [item for item in valid if item.cost <= best.cost * 1.25 + 1e-9]
                speeds = [item.speed_first_kmh for item in competitive]
                rows.append({
                    "focal_scale": focal_scale,
                    "focal_px": round(float(camera.intrinsic[0, 0]), 3),
                    "principal_y_fraction": principal_y,
                    "principal_y_px": round(float(camera.intrinsic[1, 2]), 3),
                    "camera_center_m": camera.camera_center_m.round(4).tolist(),
                    "contact_frame": contact_frame,
                    "contact_time_s": round(contact_frame / fps, 6),
                    "usable_observations": len(observations),
                    "timestamp_source": shuttle.get("timestamp_source", "frame_rate_derived"),
                    "status": "diagnostic_only",
                    "speed_first_observed_kmh": round(best.speed_first_kmh, 3),
                    "reprojection_rms_px": round(best.rms_px, 3),
                    "reprojection_p95_px": round(best.p95_px, 3),
                    "competitive_initializations": len(competitive),
                    "multistart_speed_spread_fraction": None if relative_spread(speeds) is None else round(relative_spread(speeds), 5),
                    "assumptions": ["floor homography decomposed as a pinhole camera", "zero lens distortion", "frame/fps timing", "contact frame swept rather than verified"],
                })
    successful = [row for row in rows if row["status"] == "diagnostic_only"]
    speeds = [row["speed_first_observed_kmh"] for row in successful]
    residuals = [row["reprojection_rms_px"] for row in successful]
    return {
        "schema": "smashlab.speed3d.exploration/v1",
        "sample": results.get("source"),
        "job_id": results.get("job_id"),
        "production_eligible": False,
        "decision": "rejected_no_unique_physical_speed",
        "rejection_reasons": [
            "no independently verified 3D camera intrinsics/extrinsics",
            "no lens-distortion calibration",
            "timestamps are frame-rate-derived rather than saved presentation timestamps",
            "frame 52 is not a human-confirmed contact in this job",
            "monocular depth, focal length and launch speed are coupled",
        ],
        "source_fps": fps,
        "base_timestamp_source": shuttle.get("timestamp_source", "frame_rate_derived"),
        "terminal_velocity_m_s": DEFAULT_TERMINAL_VELOCITY_M_S,
        "sweep": {"focal_scales": [0.8, 0.9, 1.0, 1.1, 1.2], "principal_y_fractions": [-0.05, 0.0, 0.05], "contact_frames": [50, 51, 52, 53, 54]},
        "summary": {
            "fits_attempted": len(rows),
            "fits_succeeded": len(successful),
            "candidate_speed_min_kmh": None if not speeds else round(min(speeds), 3),
            "candidate_speed_median_kmh": None if not speeds else round(float(np.median(speeds)), 3),
            "candidate_speed_max_kmh": None if not speeds else round(max(speeds), 3),
            "speed_spread_fraction": relative_spread(speeds),
            "reprojection_rms_min_px": None if not residuals else round(min(residuals), 3),
            "reprojection_rms_median_px": None if not residuals else round(float(np.median(residuals)), 3),
            "reprojection_rms_max_px": None if not residuals else round(max(residuals), 3),
            "runtime_s": round(time.perf_counter() - started, 3),
            "peak_rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1024 * 1024 if sys.platform == "darwin" else 1024), 2),
        },
        "frame_52_nominal": next((row for row in successful if row["focal_scale"] == 1.0 and row["principal_y_fraction"] == 0.0 and row["contact_frame"] == 52), None),
        "fits": rows,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("job_dir", type=Path)
    args = parser.parse_args()
    document = run(args.job_dir)
    print(json.dumps(document, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
