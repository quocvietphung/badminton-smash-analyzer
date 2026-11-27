"""Optional INT8 models, chosen with SMASHLAB_ONNX_PRECISION=int8 (default fp32).

tools/quantize_int8.py writes "<model>.int8.onnx" next to each FP32 model, with "<model>.int8.json": the FP32 source's
SHA-256, the INT8 file's SHA-256, the calibration clips and the settings. tools/compare_precision.py measures how
often the INT8 model agrees with the FP32 model on the local samples. Loading checks only that the INT8 file belongs
to the FP32 model on disk; agreement is a measurement, never assumed. InpaintNet stays FP32 (it is small).
"""

from __future__ import annotations

import hashlib
import json
import os
from typing import Optional

PRECISIONS = ("fp32", "int8")


def int8_path(fp32_path: str) -> str:
    root, _ext = os.path.splitext(fp32_path)
    return root + ".int8.onnx"


def int8_record_path(fp32_path: str) -> str:
    root, _ext = os.path.splitext(fp32_path)
    return root + ".int8.json"


def sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def resolve(fp32_path: str, precision: str) -> tuple[str, Optional[dict]]:
    """The model file to load for this precision, and its INT8 record. Raises FileNotFoundError or ValueError with a
    message a person can act on; never falls back to the other precision silently."""
    if precision not in PRECISIONS:
        raise ValueError(f"unknown ONNX precision {precision!r}; use one of {', '.join(PRECISIONS)}")
    if precision == "fp32":
        return fp32_path, None
    path, record_path = int8_path(fp32_path), int8_record_path(fp32_path)
    if not os.path.isfile(path) or not os.path.isfile(record_path):
        raise FileNotFoundError(f"INT8 model not found next to {os.path.basename(fp32_path)}; run backend/tools/quantize_int8.py")
    with open(record_path, encoding="utf-8") as handle:
        record = json.load(handle)
    if record.get("source_sha256") != sha256(fp32_path):
        raise ValueError(f"{os.path.basename(path)} was made from a different {os.path.basename(fp32_path)}; quantize again")
    if record.get("int8_sha256") != sha256(path):
        raise ValueError(f"{os.path.basename(path)} changed after it was written; quantize again")
    return path, record
