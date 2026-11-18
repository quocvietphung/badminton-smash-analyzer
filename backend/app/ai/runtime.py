"""Shared ONNX Runtime session options for the CPU-only pipeline.

Spinning worker threads are disabled because the pipeline alternates between sessions and
OpenCV work on a small CPU budget; spinning added contention in local runs.
"""

from __future__ import annotations

import onnxruntime as ort


def session_options(threads: int) -> ort.SessionOptions:
    options = ort.SessionOptions()
    options.intra_op_num_threads = max(1, int(threads))
    options.inter_op_num_threads = 1
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    return options
