"""Write INT8 copies of TrackNet and YOLOX next to the FP32 models (opt-in: SMASHLAB_ONNX_PRECISION=int8).

Static QDQ quantization with per-channel INT8 weights and UINT8 activations, calibrated on the even windows of the
four local samples (tools/int8_data.py). Per-channel DequantizeLinear (its "axis" attribute) needs opset 13, so a model
with an older opset (the YOLOX file is opset 11) is converted to opset 13 in a scratch folder first. Nothing is
downloaded; the FP32 files are only read. Each INT8 file must load in onnxruntime before its record is written. For each
model it writes "<model>.int8.onnx" and "<model>.int8.json" (source and INT8 SHA-256, opsets, calibration clips,
settings).

Run tools/compare_precision.py afterwards: an INT8 model is worth using only where it agrees with FP32.

Usage (from backend/):
  .venv-dev/bin/python tools/quantize_int8.py [--models-dir ../models] [--windows 6] [--frames 12]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import int8_data  # noqa: E402
import onnx  # noqa: E402
import onnxruntime as ort  # noqa: E402
from onnx import helper, version_converter  # noqa: E402
from onnxruntime.quantization import CalibrationDataReader, QuantFormat, QuantType, quantize_static  # noqa: E402
from onnxruntime.quantization.shape_inference import quant_pre_process  # noqa: E402

from app.ai import precision as P  # noqa: E402

SETTINGS = {"format": "QDQ", "per_channel": True, "weight_type": "QInt8", "activation_type": "QUInt8",
            "calibration": "MinMax", "calibration_windows": "even windows of each sample"}
PER_CHANNEL_MIN_OPSET = 13  # DequantizeLinear accepts the per-channel "axis" attribute from opset 13 on


def default_opset(model: onnx.ModelProto) -> int:
    return next((entry.version for entry in model.opset_import if entry.domain in ("", "ai.onnx")), 0)


def prepare_opset(fp32_path: Path, scratch: Path) -> tuple[Path, int, int]:
    """The model file to quantize, its source opset and the opset it is quantized at. A model older than opset 13 is
    converted into ``scratch`` (checked with the ONNX checker); the FP32 file is never rewritten."""
    model = onnx.load(str(fp32_path))
    source = default_opset(model)
    if source >= PER_CHANNEL_MIN_OPSET:
        return fp32_path, source, source
    converted = version_converter.convert_version(model, PER_CHANNEL_MIN_OPSET)
    converted.ir_version = max(converted.ir_version, helper.find_min_ir_version_for(list(converted.opset_import)))
    onnx.checker.check_model(converted)
    target = scratch / f"opset{PER_CHANNEL_MIN_OPSET}.onnx"
    onnx.save(converted, str(target))
    return target, source, PER_CHANNEL_MIN_OPSET


class ListReader(CalibrationDataReader):
    def __init__(self, input_name: str, tensors: list) -> None:
        self._items = iter([{input_name: tensor} for tensor in tensors])

    def get_next(self):
        return next(self._items, None)


def quantize(fp32_path: Path, input_name: str, tensors: list, clips: list[str]) -> dict:
    target = Path(P.int8_path(str(fp32_path)))
    record_path = Path(P.int8_record_path(str(fp32_path)))
    began = time.perf_counter()
    with tempfile.TemporaryDirectory() as scratch:
        source, source_opset, quantized_opset = prepare_opset(fp32_path, Path(scratch))
        prepared = Path(scratch) / "prepared.onnx"
        quant_pre_process(str(source), str(prepared), skip_symbolic_shape=True)
        quantize_static(str(prepared), str(target), ListReader(input_name, tensors), quant_format=QuantFormat.QDQ,
                        per_channel=True, weight_type=QuantType.QInt8, activation_type=QuantType.QUInt8)
    try:
        ort.InferenceSession(str(target), providers=["CPUExecutionProvider"])
    except Exception as error:  # an INT8 file that onnxruntime rejects must not keep a record that vouches for it
        record_path.unlink(missing_ok=True)
        raise RuntimeError(f"{target.name} does not load in onnxruntime: {error}") from error
    record = {
        "schema": "smashlab.int8-model/v1",
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "source_file": fp32_path.name,
        "source_sha256": P.sha256(str(fp32_path)),
        "source_opset": source_opset,
        "quantized_opset": quantized_opset,
        "int8_file": target.name,
        "int8_sha256": P.sha256(str(target)),
        "loads_in_onnxruntime": True,
        "source_bytes": fp32_path.stat().st_size,
        "int8_bytes": target.stat().st_size,
        "calibration_inputs": len(tensors),
        "calibration_clips": clips,
        "settings": SETTINGS,
        "seconds": round(time.perf_counter() - began, 1),
        "note": "Agreement with FP32 is measured by tools/compare_precision.py, not assumed.",
    }
    record_path.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    return record


def describe(name: str, record: dict, unit: str) -> str:
    opsets = f"opset {record['source_opset']}" + (f" -> {record['quantized_opset']}" if record["quantized_opset"] != record["source_opset"] else "")
    return (f"{name} ({opsets}): {record['source_bytes'] / 1e6:.1f} MB -> {record['int8_bytes'] / 1e6:.1f} MB "
            f"from {record['calibration_inputs']} {unit} in {record['seconds']} s; loads in onnxruntime")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--models-dir", default=str(Path(__file__).resolve().parents[2] / "models"))
    parser.add_argument("--windows", type=int, default=6, help="TrackNet calibration windows per sample")
    parser.add_argument("--frames", type=int, default=12, help="YOLOX calibration frames per sample")
    args = parser.parse_args(argv)
    models = Path(args.models_dir)
    videos = int8_data.sample_paths()
    clips = [video.name for video in videos]
    sidecar = json.loads((models / "tracknetv3" / "tracknetv3_export.json").read_text(encoding="utf-8"))["models"]["tracknet"]
    tracknet_inputs = [tensor[None] for video in videos
                       for _indices, tensor in int8_data.tracknet_windows(video, int(sidecar["seq_len"]), str(sidecar["bg_mode"]), 0, args.windows)]
    record = quantize(models / "tracknetv3" / sidecar["file"], sidecar["input_name"], tracknet_inputs, clips)
    print(describe("TrackNet", record, "windows"), flush=True)

    yolox = models / "yolox" / "object_detection_yolox_2022nov.onnx"
    yolox_input = ort.InferenceSession(str(yolox), providers=["CPUExecutionProvider"]).get_inputs()[0].name
    yolox_inputs = [blob for video in videos for _index, _frame, blob in int8_data.yolox_frames(video, 0, 15, args.frames)]
    record = quantize(yolox, yolox_input, yolox_inputs, clips)
    print(describe("YOLOX", record, "frames"), flush=True)
    return 0


if __name__ == "__main__":
    os.environ.setdefault("OMP_NUM_THREADS", "4")
    raise SystemExit(main(sys.argv[1:]))
