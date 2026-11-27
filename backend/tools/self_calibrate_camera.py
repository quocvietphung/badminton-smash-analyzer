"""Evaluate the court self-calibration (court-self-calibration/v1) on stored analyses, read-only.

For each job: the court homography comes from the job's results.json, the median background is rebuilt from the
sample video exactly as the pipeline builds it (9 full-resolution frames, per-pixel median), and the camera is built
from the floor and checked against the net tape. The report and a picture of the predicted and detected net tape are
written to the output folder. Nothing is written into the job folder and no model runs.

Usage (from backend/):
  .venv-dev/bin/python tools/self_calibrate_camera.py --out ../outputs/test-runs/<stamp>-self-calibration \
      ../outputs/<job A> ../data/samples/sample-a-singles-rally.mp4 ../outputs/<job B> ../data/samples/sample-b-fast-shuttle.mp4

A "validated" camera means the floor-only camera predicted the net tape within the limit. It is not an accuracy
measurement: these clips have no ground truth.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.pipeline.media import probe_video, sample_background_frames, uint8_median  # noqa: E402
from app.physics import self_calibration as S  # noqa: E402
from app.physics.camera import CameraCalibration  # noqa: E402


def _camera(block: dict, width: int, height: int) -> CameraCalibration:
    return CameraCalibration(block["intrinsic"], block["rotation_world_to_camera"], block["camera_center_m"], width, height,
                             block["source"], bool(block["independent_3d"]))


def picture(background: np.ndarray, block: dict, width: int, height: int, path: Path) -> None:
    """The median background with the predicted tape (green line) and the detected tape points (orange dots)."""
    if "intrinsic" not in block:
        return
    image = background.copy()
    camera = _camera(block, width, height)
    xs = np.linspace(0.0, S.COURT_WIDTH_M, 60)
    tape, _ = camera.project(np.column_stack([xs, np.full(len(xs), S.NET_Y_M), S.net_top_height_m(xs) - S.NET_TAPE_HALF_WIDTH_M]))
    cv2.polylines(image, [tape.round().astype(np.int32)], False, (60, 220, 120), 2, cv2.LINE_AA)
    found = S.detect_net_tape(camera, background, np.asarray(block.get("homography_image_from_court") or np.eye(3)))
    for item in found["detections"]:
        cv2.circle(image, (int(round(item["u_px"])), int(round(item["row_px"]))), 4, (0, 150, 255), -1, cv2.LINE_AA)
    cv2.imwrite(str(path), image)


def evaluate(job_dir: Path, video: Path, out_dir: Path) -> dict:
    results = json.loads((job_dir / "results.json").read_text(encoding="utf-8"))
    court = results.get("court", {})
    info = probe_video(str(video))
    entry = {"job_id": job_dir.name, "video": video.name, "court_status": court.get("status"), "court_source": court.get("source")}
    if court.get("status") != "calibrated" or not court.get("homography_image_from_court"):
        return {**entry, "status": "not_run", "reason": "the court of this analysis is not calibrated"}
    _count, _samples, calibration_frames = sample_background_frames(str(video), info.frame_count, 120)
    background = uint8_median(calibration_frames)
    block = S.self_calibrate(court["homography_image_from_court"], background, info.width, info.height)
    picture(background, {**block, "homography_image_from_court": court["homography_image_from_court"]}, info.width, info.height,
            out_dir / f"net_tape_{job_dir.name[:8]}.jpg")
    return {**entry, **{key: block.get(key) for key in ("status", "independent_3d", "reason", "checks", "limits",
                                                        "focal_uncertainty_fraction", "reprojection_rms_px", "camera_center_m")}}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", required=True, help="report folder (created; must not be a job folder)")
    parser.add_argument("pairs", nargs="+", help="job folder and sample video, repeated")
    args = parser.parse_args(argv)
    if len(args.pairs) % 2:
        parser.error("give a job folder and a video for each analysis")
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    report = {"schema": "smashlab.self-calibration-report/v1", "version": S.VERSION,
              "note": "Floor-only camera checked against the net tape. Not an accuracy measurement: no ground truth.",
              "analyses": []}
    for job, video in zip(args.pairs[0::2], args.pairs[1::2]):
        entry = evaluate(Path(job), Path(video), out_dir)
        report["analyses"].append(entry)
        checks = entry.get("checks") or {}
        print(f"{entry['job_id'][:8]} {entry['video']}: {entry['status']} | floor {checks.get('floor_reprojection_rms_px')} px | "
              f"net {checks.get('net_tape_residual_rms_px')} px | coverage {checks.get('net_tape_coverage')} | "
              f"focal {checks.get('focal_from_floor_px')} (net best {checks.get('focal_best_fit_to_net_px')}) | {entry.get('reason')}")
    (out_dir / "self_calibration_report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
