"""Catalogue of local test samples, read from the dataset manifest mounted read-only."""

from __future__ import annotations

import json
import os
from typing import Optional


def load_manifest(manifest_path: str) -> dict:
    if not os.path.isfile(manifest_path):
        return {"schema": "smashlab.local-ai.manifest/v1", "samples": []}
    with open(manifest_path, encoding="utf-8") as handle:
        return json.load(handle)


def list_samples(input_dir: str, manifest_path: str) -> list[dict]:
    """Public view of each sample: no absolute host paths, availability flag included."""
    manifest = load_manifest(manifest_path)
    entries = []
    for sample in manifest.get("samples", []):
        relative = sample["file"]
        path = os.path.join(input_dir, relative)
        available = os.path.isfile(path)
        entries.append(
            {
                "id": sample["id"],
                "title": sample["title"],
                "scenario": sample.get("scenario"),
                "file": relative,
                "available": available,
                "status": "available" if available else "missing",
                "thumbnail_url": f"/api/v1/samples/{sample['id']}/thumbnail",
                "width": sample.get("width"),
                "height": sample.get("height"),
                "fps": sample.get("fps"),
                "frames": sample.get("frames"),
                "duration_s": sample.get("duration_s"),
                "trim": sample.get("trim"),
                "licence": sample.get("licence"),
                "source_url": sample.get("source_url"),
                "attribution": sample.get("attribution"),
                "ground_truth": sample.get("ground_truth", []),
            }
        )
    return entries


def resolve_sample(input_dir: str, manifest_path: str, sample_id: str) -> Optional[tuple[dict, str]]:
    for entry in list_samples(input_dir, manifest_path):
        if entry["id"] == sample_id:
            path = os.path.join(input_dir, entry["file"])
            return entry, path if entry["available"] else ""
    return None
