"""Write or check the golden-analysis/v1 snapshots of the stored sample analyses A to D.

The manifest backend/tests/golden/samples.json names one stored job per sample. A snapshot is recomputed from that
job's files (read only, no model run, corrections left out) and compared with backend/tests/golden/<sample>.json.

Usage (from backend/):
  .venv-dev/bin/python tools/update_golden.py check            # print the differences, exit 1 when any
  .venv-dev/bin/python tools/update_golden.py write            # replace the baselines after an intended change
  .venv-dev/bin/python tools/update_golden.py write --sample A # one sample only

The outputs folder defaults to ../outputs (the repository's), or SMASHLAB_GOLDEN_OUTPUTS. A snapshot change is not an
accuracy change: there is no ground truth for these clips. Write new baselines only after reading the differences.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services import golden  # noqa: E402

GOLDEN_DIR = Path(__file__).resolve().parents[1] / "tests" / "golden"
MANIFEST = GOLDEN_DIR / "samples.json"


def outputs_dir() -> Path:
    return Path(os.environ.get("SMASHLAB_GOLDEN_OUTPUTS") or Path(__file__).resolve().parents[2] / "outputs")


def load_manifest() -> dict:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def baseline_path(sample: str) -> Path:
    return GOLDEN_DIR / f"sample_{sample.lower()}.json"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("action", choices=("check", "write"))
    parser.add_argument("--sample", help="one sample letter from the manifest (default: all)")
    args = parser.parse_args(argv)
    manifest = load_manifest()
    samples = manifest["samples"]
    chosen = {args.sample: samples[args.sample]} if args.sample else samples
    failures = 0
    for name, entry in chosen.items():
        folder = outputs_dir() / entry["job_id"]
        if not (folder / "results.json").is_file():
            print(f"sample {name}: skipped, stored job {entry['job_id']} not found in {outputs_dir()}")
            continue
        current = golden.snapshot(str(folder), entry["job_id"])
        target = baseline_path(name)
        if args.action == "write":
            previous = json.loads(target.read_text(encoding="utf-8")) if target.is_file() else None
            target.write_text(json.dumps(current, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
            changed = list(golden.differences(previous, current)) if previous is not None else ["new baseline"]
            print(f"sample {name}: written {target.name} ({len(changed)} change(s))")
            for line in changed[:40]:
                print(f"  {line}")
            continue
        if not target.is_file():
            print(f"sample {name}: no baseline {target.name}")
            failures += 1
            continue
        expected = json.loads(target.read_text(encoding="utf-8"))
        found = list(golden.differences(expected, current))
        print(f"sample {name}: {'unchanged' if not found else f'{len(found)} difference(s)'}")
        for line in found[:60]:
            print(f"  {line}")
        failures += bool(found)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
