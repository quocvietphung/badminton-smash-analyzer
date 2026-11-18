"""Golden regression check for the shuttle trajectory.

A golden file stores a digest of the trajectory that a known clip produced with this build, plus a
short human-readable summary. A later run on the same clip must produce the same digest. A mismatch
means the output changed. It says nothing about whether the detections are correct: there is no
ground truth for these clips, so accuracy is not measured.

Usage:
  python tools/golden_trajectory.py write <job_folder> <golden.json> <clip-name>
  python tools/golden_trajectory.py check <job_folder> <golden.json>
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

TRAJECTORY = "shuttle_trajectory.json"
SCHEMA = "smashlab.golden.shuttle/v1"


def canonical_frames(trajectory: dict) -> list:
    """The fields that define the output, in frame order, with floats rounded to four decimals."""
    return [
        [
            item["frame"],
            item["x"],
            item["y"],
            bool(item["visible"]),
            round(float(item["confidence"]), 4),
            bool(item["refined"]),
        ]
        for item in trajectory["frames"]
    ]


def digest(trajectory: dict) -> str:
    payload = json.dumps(canonical_frames(trajectory), separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def summary(trajectory: dict) -> dict:
    frames = trajectory["frames"]
    return {
        "frames_total": len(frames),
        "frames_visible": sum(1 for item in frames if item["visible"]),
        "frames_refined": sum(1 for item in frames if item["refined"]),
        "first_frames": canonical_frames(trajectory)[:20],
    }


def _load(folder: str) -> dict:
    return json.loads((Path(folder) / TRAJECTORY).read_text(encoding="utf-8"))


def write_golden(folder: str, golden_path: str, clip: str) -> None:
    trajectory = _load(folder)
    golden = {
        "schema": SCHEMA,
        "clip": clip,
        "digest_sha256": digest(trajectory),
        "summary": summary(trajectory),
        "note": "Regression snapshot of this build's shuttle output for this clip. Not an accuracy measurement.",
    }
    Path(golden_path).write_text(json.dumps(golden, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def check_golden(folder: str, golden_path: str) -> int:
    golden = json.loads(Path(golden_path).read_text(encoding="utf-8"))
    actual = digest(_load(folder))
    if actual == golden["digest_sha256"]:
        print(f"golden match: {golden['clip']} {actual[:16]}")
        return 0
    print(f"golden MISMATCH: {golden['clip']} expected {golden['digest_sha256'][:16]} got {actual[:16]}")
    return 1


def main(argv: list[str]) -> int:
    if len(argv) >= 4 and argv[1] == "write" and len(argv) == 5:
        write_golden(argv[2], argv[3], argv[4])
        print(f"wrote {argv[3]}")
        return 0
    if len(argv) == 4 and argv[1] == "check":
        return check_golden(argv[2], argv[3])
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
