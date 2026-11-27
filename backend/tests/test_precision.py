"""INT8 models are opt-in, belong to the FP32 model on disk, and never replace it silently."""

import json

import pytest

from app.ai import precision as P
from app.config import Settings


def _model(tmp_path, name="model.onnx", content=b"fp32"):
    path = tmp_path / name
    path.write_bytes(content)
    return path


def test_fp32_is_the_default_and_needs_no_extra_file(tmp_path):
    path = _model(tmp_path)
    assert P.resolve(str(path), "fp32") == (str(path), None)


def test_int8_without_its_files_fails_with_the_command_to_run(tmp_path):
    path = _model(tmp_path)
    with pytest.raises(FileNotFoundError, match="quantize_int8.py"):
        P.resolve(str(path), "int8")


def test_int8_is_loaded_only_when_it_was_made_from_this_fp32_model(tmp_path):
    path = _model(tmp_path)
    int8 = tmp_path / "model.int8.onnx"
    int8.write_bytes(b"int8")
    record = {"source_sha256": P.sha256(str(path)), "int8_sha256": P.sha256(str(int8))}
    (tmp_path / "model.int8.json").write_text(json.dumps(record), encoding="utf-8")
    assert P.resolve(str(path), "int8")[0] == str(int8)
    path.write_bytes(b"another fp32 model")
    with pytest.raises(ValueError, match="different"):
        P.resolve(str(path), "int8")
    path.write_bytes(b"fp32")
    int8.write_bytes(b"edited")
    with pytest.raises(ValueError, match="changed"):
        P.resolve(str(path), "int8")
    with pytest.raises(ValueError, match="unknown"):
        P.resolve(str(path), "fp16")


def test_the_setting_accepts_only_fp32_or_int8(monkeypatch):
    monkeypatch.delenv("SMASHLAB_ONNX_PRECISION", raising=False)
    assert Settings.from_env().onnx_precision == "fp32"
    monkeypatch.setenv("SMASHLAB_ONNX_PRECISION", "INT8")
    assert Settings.from_env().onnx_precision == "int8"
    monkeypatch.setenv("SMASHLAB_ONNX_PRECISION", "fp16")
    with pytest.raises(ValueError):
        Settings.from_env()
