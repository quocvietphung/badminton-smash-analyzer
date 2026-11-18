"""Export TrackNetV3 checkpoints to ONNX for the CPU-only backend image.

Host-side tool. It needs PyTorch and ONNX, which the backend Docker image does not
contain. The ONNX files it writes are used by app/ai/shuttle_tracking at runtime.

Licences (verified in this session):
- Source: https://github.com/qaz812345/TrackNetV3 (MIT, code and pretrained checkpoints).
- Checkpoints: TrackNetV3_ckpts.zip, distributed with the MIT licence in the repository.

Run with isolated Python so the cloned source cannot shadow stdlib modules:

    python -I backend/tools/export_tracknetv3.py \
        --src <dir containing model.py from TrackNetV3> \
        --ckpt <path to TrackNet_best.pt> \
        --inpaint-ckpt <path to InpaintNet_best.pt> \
        --out-dir models/tracknetv3

The script re-implements no model logic: it imports TrackNet and InpaintNet from the
TrackNetV3 source directory, loads the checkpoint, exports ONNX with the legacy
TorchScript exporter, and checks ONNX Runtime output against PyTorch output.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone

# Matches TrackNetV3 utils/general.py (HEIGHT, WIDTH). Used only to build dummy inputs.
HEIGHT = 288
WIDTH = 512


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def load_checkpoint(torch, path: str) -> dict:
    try:
        return torch.load(path, map_location="cpu", weights_only=True)
    except Exception as exc:  # pragma: no cover - only hit with unusual checkpoints
        raise SystemExit(
            f"Could not load {path} with weights_only=True ({exc}). Inspect the checkpoint manually "
            "before relaxing this check; do not load untrusted pickles."
        ) from exc


def build_tracknet(model_module, seq_len: int, bg_mode: str):
    """Mirror TrackNetV3 utils/general.py get_model() for TrackNet."""
    if bg_mode == "subtract":
        in_dim = seq_len
    elif bg_mode == "subtract_concat":
        in_dim = seq_len * 4
    elif bg_mode == "concat":
        in_dim = (seq_len + 1) * 3
    else:
        in_dim = seq_len * 3
    return model_module.TrackNet(in_dim=in_dim, out_dim=seq_len), in_dim


def export_model(torch, ort, np, model, dummy, onnx_path, input_name, output_name, dynamic_axes):
    model.eval()
    with torch.no_grad():
        expected = model(dummy).cpu().numpy()
    torch.onnx.export(
        model,
        dummy,
        onnx_path,
        input_names=[input_name],
        output_names=[output_name],
        dynamic_axes=dynamic_axes,
        opset_version=17,
        dynamo=False,
        do_constant_folding=True,
    )
    session = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
    got = session.run(None, {input_name: dummy.cpu().numpy()})[0]
    max_abs_diff = float(np.max(np.abs(got - expected)))
    return {
        "max_abs_diff_vs_torch": max_abs_diff,
        "output_shape": list(got.shape),
        "output_min": float(got.min()),
        "output_max": float(got.max()),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--src", required=True, help="TrackNetV3 source directory that contains model.py")
    parser.add_argument("--ckpt", required=True, help="TrackNet_best.pt checkpoint path")
    parser.add_argument("--inpaint-ckpt", default="", help="InpaintNet_best.pt checkpoint path (optional)")
    parser.add_argument("--out-dir", required=True, help="output directory for ONNX files and JSON sidecars")
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()

    import numpy as np
    import onnx
    import onnxruntime as ort
    import torch

    src = os.path.abspath(args.src)
    if not os.path.isfile(os.path.join(src, "model.py")):
        raise SystemExit(f"model.py not found in {src}")
    sys.path.insert(0, src)
    import model as tracknet_model  # noqa: E402  (TrackNetV3 model.py, imports only torch)

    os.makedirs(args.out_dir, exist_ok=True)
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)

    report: dict = {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "torch": torch.__version__,
        "onnxruntime": ort.__version__,
        "onnx": onnx.__version__,
        "opset": 17,
        "source": {
            "repository": "https://github.com/qaz812345/TrackNetV3",
            "licence": "MIT (code and pretrained checkpoints, per the repository LICENSE)",
        },
        "models": {},
    }

    ckpt = load_checkpoint(torch, args.ckpt)
    param = ckpt["param_dict"]
    seq_len, bg_mode = int(param["seq_len"]), str(param["bg_mode"])
    tracknet, in_dim = build_tracknet(tracknet_model, seq_len, bg_mode)
    tracknet.load_state_dict(ckpt["model"])
    tracknet.eval()

    tracknet_onnx = os.path.join(args.out_dir, "tracknetv3_tracknet.onnx")
    dummy = torch.rand(1, in_dim, HEIGHT, WIDTH, dtype=torch.float32)
    stats = export_model(
        torch, ort, np, tracknet, dummy, tracknet_onnx,
        input_name="frames", output_name="heatmaps",
        dynamic_axes={"frames": {0: "batch"}, "heatmaps": {0: "batch"}},
    )
    onnx.checker.check_model(tracknet_onnx)
    report["models"]["tracknet"] = {
        "file": os.path.basename(tracknet_onnx),
        "checkpoint": os.path.basename(args.ckpt),
        "checkpoint_sha256": sha256_file(args.ckpt),
        "onnx_sha256": sha256_file(tracknet_onnx),
        "onnx_bytes": os.path.getsize(tracknet_onnx),
        "seq_len": seq_len,
        "bg_mode": bg_mode,
        "input_channels": in_dim,
        "input_shape": ["batch", in_dim, HEIGHT, WIDTH],
        "input_name": "frames",
        "output_name": "heatmaps",
        **stats,
    }

    if args.inpaint_ckpt:
        inpaint_ckpt = load_checkpoint(torch, args.inpaint_ckpt)
        inpaint_seq_len = int(inpaint_ckpt["param_dict"]["seq_len"])
        inpaintnet = tracknet_model.InpaintNet()
        inpaintnet.load_state_dict(inpaint_ckpt["model"])
        inpaintnet.eval()
        inpaint_onnx = os.path.join(args.out_dir, "tracknetv3_inpaintnet.onnx")
        coords = torch.rand(1, inpaint_seq_len, 2, dtype=torch.float32)
        mask = torch.zeros(1, inpaint_seq_len, 1, dtype=torch.float32)
        torch.onnx.export(
            inpaintnet,
            (coords, mask),
            inpaint_onnx,
            input_names=["coords", "mask"],
            output_names=["coords_inpainted"],
            dynamic_axes={"coords": {0: "batch"}, "mask": {0: "batch"}, "coords_inpainted": {0: "batch"}},
            opset_version=17,
            dynamo=False,
            do_constant_folding=True,
        )
        session = ort.InferenceSession(inpaint_onnx, providers=["CPUExecutionProvider"])
        with torch.no_grad():
            expected = inpaintnet(coords, mask).cpu().numpy()
        got = session.run(None, {"coords": coords.numpy(), "mask": mask.numpy()})[0]
        onnx.checker.check_model(inpaint_onnx)
        report["models"]["inpaintnet"] = {
            "file": os.path.basename(inpaint_onnx),
            "checkpoint": os.path.basename(args.inpaint_ckpt),
            "checkpoint_sha256": sha256_file(args.inpaint_ckpt),
            "onnx_sha256": sha256_file(inpaint_onnx),
            "onnx_bytes": os.path.getsize(inpaint_onnx),
            "seq_len": inpaint_seq_len,
            "max_abs_diff_vs_torch": float(np.max(np.abs(got - expected))),
        }

    report_path = os.path.join(args.out_dir, "tracknetv3_export.json")
    with open(report_path, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
