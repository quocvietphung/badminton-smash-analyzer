"""Sensitivity of trajectory-rules/v1 labels to smoothing, TrackNet confidence and contact offset.

Reads one analysis (this job only) through the local API and writes a derived summary under
outputs/<job>/derived/sensitivity/. It never writes raw outputs and never changes the dataset or the timeline.

Usage (from backend/):  .venv-dev/bin/python tools/shot_trajectory_sensitivity.py --job <job-id>
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from app.analytics import trajectory_rules as R  # noqa: E402
from app.services import shot_dataset as D  # noqa: E402


def _token() -> str | None:
    env = ROOT / ".env.local"
    if not env.exists():
        return None
    for line in env.read_text(encoding="utf-8").splitlines():
        if line.startswith("SMASHLAB_API_TOKEN="):
            return line.split("=", 1)[1].strip() or None
    return None


def _fetch(api: str, path: str) -> dict:
    request = urllib.request.Request(f"{api}{path}")
    token = _token()
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.loads(response.read())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", required=True)
    parser.add_argument("--api", default=os.environ.get("SMASHLAB_API_URL", "http://localhost:8000"))
    args = parser.parse_args()
    job_dir = ROOT / "outputs" / args.job
    shuttle = json.loads((job_dir / "shuttle_trajectory.json").read_text(encoding="utf-8"))
    video = json.loads((job_dir / "results.json").read_text(encoding="utf-8")).get("video", {})
    doc = _fetch(args.api, f"/api/v1/analyses/{args.job}/match")
    results = []
    for smoothing in (1, 3, 5):
        for conf in (0.3, 0.5, 0.7):
            config = dict(R.CONFIG, smoothing=smoothing, conf_threshold=conf)
            records, _meta = D.build_records(doc, shuttle, job_id=args.job, run_id="sensitivity", config=config, video=video)
            labels = [r["best_guess_label"] for r in records]
            accepted = sum(1 for r in records if r["review_status"] == "accepted_by_gate")
            flips = sum(1 for r in records if len(set(r["offset_labels"].values())) > 1)
            results.append({"smoothing": smoothing, "conf_threshold": conf, "labels": labels,
                            "accepted_by_gate": accepted, "offset_unstable": flips,
                            "distribution": {c: labels.count(c) for c in R.CLASSES}})
    base = next(r for r in results if r["smoothing"] == 1 and r["conf_threshold"] == 0.5)
    for item in results:
        item["same_labels_as_baseline"] = sum(1 for a, b in zip(item["labels"], base["labels"]) if a == b)
    out_dir = job_dir / "derived" / "sensitivity"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "sensitivity_summary.json").write_text(json.dumps({
        "schema": "smashlab.shot-trajectory.sensitivity/v1", "job_id": args.job, "rule_version": R.RULE_VERSION,
        "contacts": len(base["labels"]), "settings": results,
        "offsets": list(R.CONFIG["offsets"]),
        "note": "Offsets -2/0/+2 are checked for every contact in each dataset row (offset_labels). Not validated.",
    }, indent=2, ensure_ascii=False), encoding="utf-8")
    print(out_dir / "sensitivity_summary.json")


if __name__ == "__main__":
    main()
