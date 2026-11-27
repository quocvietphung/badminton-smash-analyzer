"""INT8 tools: an old-opset model is quantized per channel only after an opset upgrade, the result must load, and the
agreement report keeps one model's result when the other cannot be compared.

The YOLOX file is opset 11; per-channel DequantizeLinear needs opset 13, so quantizing it directly wrote a file that
onnxruntime refused (INVALID_GRAPH). These tests use tiny synthetic Conv models, so they need no local models or
samples. The quantizer tests need the host-only `onnx` package (requirements-export.txt) and skip without it.
"""

import importlib.util
import json
from pathlib import Path

import numpy as np
import pytest

from app.ai import precision as P

TOOLS = Path(__file__).resolve().parents[1] / "tools"


def _tool(name: str):
    spec = importlib.util.spec_from_file_location(f"smashlab_tool_{name}", TOOLS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def quantizer():
    pytest.importorskip("onnx")
    return _tool("quantize_int8")


def _conv_model(path: Path, opset: int) -> Path:
    import onnx
    from onnx import TensorProto, helper, numpy_helper

    rng = np.random.default_rng(3)
    weight = numpy_helper.from_array(rng.normal(size=(4, 3, 3, 3)).astype(np.float32), "w")
    bias = numpy_helper.from_array(rng.normal(size=(4,)).astype(np.float32), "b")
    graph = helper.make_graph(
        [helper.make_node("Conv", ["x", "w", "b"], ["c"], pads=[1, 1, 1, 1]), helper.make_node("Relu", ["c"], ["y"])],
        "tiny",
        [helper.make_tensor_value_info("x", TensorProto.FLOAT, [1, 3, 8, 8])],
        [helper.make_tensor_value_info("y", TensorProto.FLOAT, [1, 4, 8, 8])],
        initializer=[weight, bias],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", opset)])
    model.ir_version = 6 if opset <= 11 else 8  # the YOLOX file is IR 6 / opset 11
    onnx.save(model, str(path))
    return path


def test_an_opset_11_model_is_converted_to_opset_13_in_scratch_and_keeps_its_output(quantizer, tmp_path):
    import onnx
    import onnxruntime as ort

    source = _conv_model(tmp_path / "old.onnx", 11)
    before = source.read_bytes()
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    converted, source_opset, quantized_opset = quantizer.prepare_opset(source, scratch)
    assert (source_opset, quantized_opset) == (11, 13)
    assert converted.parent == scratch and source.read_bytes() == before
    assert quantizer.default_opset(onnx.load(str(converted))) == 13
    x = np.random.default_rng(5).normal(size=(1, 3, 8, 8)).astype(np.float32)
    old = ort.InferenceSession(str(source), providers=["CPUExecutionProvider"]).run(None, {"x": x})[0]
    new = ort.InferenceSession(str(converted), providers=["CPUExecutionProvider"]).run(None, {"x": x})[0]
    np.testing.assert_allclose(new, old, rtol=1e-6, atol=1e-6)


def test_a_model_at_opset_13_or_newer_is_quantized_as_it_is(quantizer, tmp_path):
    source = _conv_model(tmp_path / "new.onnx", 17)
    assert quantizer.prepare_opset(source, tmp_path) == (source, 17, 17)


def test_per_channel_int8_of_an_opset_11_model_loads_and_is_recorded(quantizer, tmp_path):
    import onnxruntime as ort

    source = _conv_model(tmp_path / "old.onnx", 11)
    rng = np.random.default_rng(11)
    tensors = [rng.normal(size=(1, 3, 8, 8)).astype(np.float32) for _ in range(4)]
    record = quantizer.quantize(source, "x", tensors, ["synthetic"])
    assert record["source_opset"] == 11 and record["quantized_opset"] == 13
    assert record["settings"]["per_channel"] is True and record["loads_in_onnxruntime"] is True
    path, stored = P.resolve(str(source), "int8")
    assert stored["int8_sha256"] == record["int8_sha256"]
    session = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    assert session.run(None, {"x": tensors[0]})[0].shape == (1, 4, 8, 8)


def test_the_agreement_report_keeps_tracknet_when_yolox_cannot_be_compared(tmp_path, monkeypatch, capsys):
    compare = _tool("compare_precision")
    tracknet = {"frames": 6, "both_visible": 4, "visibility_agreement": 1.0, "within_2px": 1.0, "distance_px_median": 0.2,
                "distance_px_p95": 0.9, "ms_per_window_fp32": 40.0, "ms_per_window_int8": 20.0, "passes": True}

    def yolox_fails(*_args):
        raise RuntimeError("INVALID_GRAPH: Unrecognized attribute: axis for operator DequantizeLinear")

    monkeypatch.setattr(compare.int8_data, "sample_paths", lambda: [])
    monkeypatch.setattr(compare, "compare_tracknet", lambda *_args: tracknet)
    monkeypatch.setattr(compare, "compare_yolox", yolox_fails)
    out = tmp_path / "run"
    assert compare.main(["--out", str(out), "--models-dir", str(tmp_path)]) == 1
    report = json.loads((out / "int8_agreement.json").read_text(encoding="utf-8"))
    assert report["tracknet"] == tracknet
    assert report["yolox"]["passes"] is False and "INVALID_GRAPH" in report["yolox"]["error"]
    printed = capsys.readouterr().out
    assert "TrackNet: visibility 100.00%" in printed and "YOLOX: not compared" in printed
