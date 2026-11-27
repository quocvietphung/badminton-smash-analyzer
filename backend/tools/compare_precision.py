"""Measure how far the INT8 models agree with the FP32 models, and how much faster they run, on held-out inputs.

Inputs are the odd windows and frames of the four local samples (tools/int8_data.py); the quantizer calibrated on the
even ones. Limits are fixed before the run:
- TrackNet: the shuttle is seen or not seen in the same frames at least 98 % of the time, and where both see it the
  INT8 point is within 2 source pixels of the FP32 point in at least 95 % of those frames;
- YOLOX: at least 98 % of the FP32 person boxes have an INT8 box with IoU >= 0.5 and vice versa, mean IoU >= 0.90.
Agreement with FP32 says nothing about accuracy (there is no ground truth); it says the INT8 model behaves like the
model the pipeline was checked with.

Each model is compared on its own: when one cannot be compared (for example its INT8 file does not load), the report
still holds the other model's result, records the error and marks that model as not passing, and the exit code is 1.

Usage (from backend/):
  .venv-dev/bin/python tools/compare_precision.py --out ../outputs/test-runs/<stamp>-int8 [--windows 10] [--frames 12]
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import int8_data  # noqa: E402

from app.ai import precision as P  # noqa: E402
from app.ai.player_detection.yolox import YoloXPersonDetector  # noqa: E402
from app.ai.shuttle_tracking.tracknet import TrackNetV3Model, heatmaps_to_frames  # noqa: E402
from app.pipeline.media import probe_video  # noqa: E402

LIMITS = {"tracknet_visibility_agreement": 0.98, "tracknet_within_2px": 0.95,
          "yolox_recall": 0.98, "yolox_precision": 0.98, "yolox_mean_iou": 0.90}


def _iou(a, b) -> float:
    x1, y1, x2, y2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def _match(reference: list, other: list) -> tuple[int, list[float]]:
    used, ious = set(), []
    for box in reference:
        best, best_iou = None, 0.0
        for index, candidate in enumerate(other):
            if index in used:
                continue
            value = _iou(box, candidate)
            if value > best_iou:
                best, best_iou = index, value
        if best is not None and best_iou >= 0.5:
            used.add(best)
            ious.append(best_iou)
    return len(ious), ious


def compare_tracknet(models_dir: Path, videos: list[Path], windows: int, threads: int) -> dict:
    fp32 = TrackNetV3Model(str(models_dir / "tracknetv3"), threads=threads, precision="fp32")
    int8 = TrackNetV3Model(str(models_dir / "tracknetv3"), threads=threads, precision="int8")
    same_visibility = frames = both = within = 0
    distances: list[float] = []
    times = {"fp32": [], "int8": []}
    for video in videos:
        info = probe_video(str(video))
        for indices, tensor in int8_data.tracknet_windows(video, fp32.seq_len, fp32.bg_mode, 1, windows):
            batch = tensor[None]
            outputs = {}
            for name, model in (("fp32", fp32), ("int8", int8)):
                began = time.perf_counter()
                outputs[name] = model(batch)[0]
                times[name].append(time.perf_counter() - began)
            a = heatmaps_to_frames(outputs["fp32"], indices, info.width, info.height)
            b = heatmaps_to_frames(outputs["int8"], indices, info.width, info.height)
            for left, right in zip(a, b):
                frames += 1
                same_visibility += int(left.visible == right.visible)
                if left.visible and right.visible:
                    both += 1
                    distance = float(np.hypot(left.x - right.x, left.y - right.y))
                    distances.append(distance)
                    within += int(distance <= 2.0)
    agreement = same_visibility / frames if frames else 0.0
    share_within = within / both if both else 0.0
    return {
        "frames": frames, "both_visible": both,
        "visibility_agreement": round(agreement, 4),
        "within_2px": round(share_within, 4),
        "distance_px_median": round(float(np.median(distances)), 3) if distances else None,
        "distance_px_p95": round(float(np.percentile(distances, 95)), 3) if distances else None,
        "ms_per_window_fp32": round(1000 * float(np.mean(times["fp32"])), 1),
        "ms_per_window_int8": round(1000 * float(np.mean(times["int8"])), 1),
        "passes": agreement >= LIMITS["tracknet_visibility_agreement"] and share_within >= LIMITS["tracknet_within_2px"],
    }


def compare_yolox(models_dir: Path, videos: list[Path], frames_per_video: int, threads: int) -> dict:
    fp32_path = str(models_dir / "yolox" / "object_detection_yolox_2022nov.onnx")
    int8_path, _record = P.resolve(fp32_path, "int8")
    detectors = {"fp32": YoloXPersonDetector(fp32_path, threads=threads), "int8": YoloXPersonDetector(int8_path, threads=threads)}
    totals = {"fp32_boxes": 0, "int8_boxes": 0, "matched_fp32": 0, "matched_int8": 0, "frames": 0}
    ious: list[float] = []
    score_diffs: list[float] = []
    times = {"fp32": [], "int8": []}
    for video in videos:
        for _index, frame, _blob in int8_data.yolox_frames(video, 1, 15, frames_per_video):
            boxes = {}
            for name, detector in detectors.items():
                began = time.perf_counter()
                found = detector.detect(frame)
                times[name].append(time.perf_counter() - began)
                boxes[name] = [(d.x1, d.y1, d.x2, d.y2, d.score) for d in found]
            totals["frames"] += 1
            totals["fp32_boxes"] += len(boxes["fp32"])
            totals["int8_boxes"] += len(boxes["int8"])
            matched, values = _match([b[:4] for b in boxes["fp32"]], [b[:4] for b in boxes["int8"]])
            totals["matched_fp32"] += matched
            ious.extend(values)
            matched_back, _ = _match([b[:4] for b in boxes["int8"]], [b[:4] for b in boxes["fp32"]])
            totals["matched_int8"] += matched_back
            for a, b in zip(sorted(boxes["fp32"], key=lambda item: item[0]), sorted(boxes["int8"], key=lambda item: item[0])):
                score_diffs.append(abs(a[4] - b[4]))
    recall = totals["matched_fp32"] / totals["fp32_boxes"] if totals["fp32_boxes"] else 1.0
    precision = totals["matched_int8"] / totals["int8_boxes"] if totals["int8_boxes"] else 1.0
    mean_iou = float(np.mean(ious)) if ious else 0.0
    return {
        **totals,
        "recall_of_fp32_boxes": round(recall, 4),
        "precision_of_int8_boxes": round(precision, 4),
        "mean_iou": round(mean_iou, 4),
        "mean_score_difference": round(float(np.mean(score_diffs)), 4) if score_diffs else None,
        "ms_per_frame_fp32": round(1000 * float(np.mean(times["fp32"])), 1),
        "ms_per_frame_int8": round(1000 * float(np.mean(times["int8"])), 1),
        "passes": recall >= LIMITS["yolox_recall"] and precision >= LIMITS["yolox_precision"] and mean_iou >= LIMITS["yolox_mean_iou"],
    }


def run_comparison(measure) -> dict:
    """The comparison's result, or the error that stopped it (that model then does not pass)."""
    try:
        return measure()
    except Exception as error:  # keep the other model's result instead of losing the whole report
        return {"error": f"{type(error).__name__}: {error}", "passes": False}


def int8_records(models_dir: Path) -> dict:
    """Which INT8 files were compared: the identifying fields of every "<model>.int8.json" under the models folder."""
    keys = ("int8_file", "int8_sha256", "source_file", "source_sha256", "source_opset", "quantized_opset", "created_utc")
    records = {}
    for path in sorted(models_dir.glob("*/*.int8.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            records[path.name] = {"error": str(error)}
            continue
        records[path.name] = {key: data.get(key) for key in keys}
    return records


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", required=True)
    parser.add_argument("--models-dir", default=str(Path(__file__).resolve().parents[2] / "models"))
    parser.add_argument("--windows", type=int, default=10, help="held-out TrackNet windows per sample")
    parser.add_argument("--frames", type=int, default=12, help="held-out YOLOX frames per sample")
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args(argv)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    models, videos = Path(args.models_dir), int8_data.sample_paths()
    report = {"schema": "smashlab.int8-agreement/v1", "limits": LIMITS, "threads": args.threads,
              "inputs": "odd windows and frames of the four local samples (the quantizer used the even ones)",
              "note": "Agreement with the FP32 models, not accuracy: there is no ground truth.",
              "int8_records": int8_records(models),
              "tracknet": run_comparison(lambda: compare_tracknet(models, videos, args.windows, args.threads)),
              "yolox": run_comparison(lambda: compare_yolox(models, videos, args.frames, args.threads))}
    (out / "int8_agreement.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    t, y = report["tracknet"], report["yolox"]
    if "error" in t:
        print(f"TrackNet: not compared ({t['error']})")
    else:
        print(f"TrackNet: visibility {t['visibility_agreement']:.2%}, within 2 px {t['within_2px']:.2%} of {t['both_visible']} frames, "
              f"median {t['distance_px_median']} px, p95 {t['distance_px_p95']} px | {t['ms_per_window_fp32']} -> {t['ms_per_window_int8']} ms/window | "
              f"{'passes' if t['passes'] else 'does not pass'}")
    if "error" in y:
        print(f"YOLOX: not compared ({y['error']})")
    else:
        print(f"YOLOX: recall {y['recall_of_fp32_boxes']:.2%}, precision {y['precision_of_int8_boxes']:.2%}, mean IoU {y['mean_iou']:.3f} | "
              f"{y['ms_per_frame_fp32']} -> {y['ms_per_frame_int8']} ms/frame | {'passes' if y['passes'] else 'does not pass'}")
    return 1 if "error" in t or "error" in y else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
