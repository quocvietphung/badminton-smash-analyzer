"""Evaluation summary built only from saved analyses on this machine.

Each value is either measured by the pipeline (timings, memory, counts, coverage) or reported as not evaluated.
Tracking continuity and identity events are proxies, not accuracy. Ground truth is reported as not evaluated,
because no labelled ground-truth annotations exist for the local samples in this build.
"""

from __future__ import annotations

import json
import os
import time
from collections import Counter
from typing import Iterable, Optional

from app.services import corrections as corrections_service

EVALUATION_SCHEMA = "smashlab.evaluation/v1"
NOT_EVALUATED = "not evaluated (no ground truth)"


def _read(path: str) -> Optional[dict]:
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def _mean(values: Iterable[Optional[float]]) -> Optional[float]:
    kept = [float(v) for v in values if v is not None]
    return round(sum(kept) / len(kept), 4) if kept else None


def _dig(data: dict, *keys):
    """Nested lookup that returns None for any missing key, so older or partial results never break the summary."""
    current = data
    for key in keys:
        if not isinstance(current, dict) or key not in current:
            return None
        current = current[key]
    return current


def summarise_jobs(jobs, labelled_samples: int = 0) -> dict:
    counts: Counter = Counter()
    failure_codes: Counter = Counter()
    results: list[dict] = []
    metrics: list[dict] = []
    identity_counts: Counter = Counter()
    correction_types: Counter = Counter()
    analyses_with_corrections = 0

    for job in jobs:
        counts["total"] += 1
        if job.status == "completed":
            counts["completed"] += 1
            result = _read(os.path.join(job.output_dir, "results.json"))
            if result is not None:
                results.append(result)
            measured = _read(os.path.join(job.output_dir, "metrics.json"))
            if measured is not None:
                metrics.append(measured)
            events = _read(os.path.join(job.output_dir, "identity_events.json"))
            if events is not None:
                identity_counts.update(events.get("event_counts", {}))
            entries = corrections_service.load(job.output_dir).get("entries", [])
            if entries:
                analyses_with_corrections += 1
            correction_types.update(entry.get("type", "unknown") for entry in entries)
        elif job.status == "failed":
            counts["failed"] += 1
            failure_codes[job.error_code or "unknown"] += 1
        else:
            counts["in_progress"] += 1

    frames = sum(int(_dig(r, "video", "frames_analysed") or 0) for r in results)
    seconds = sum(float(_dig(r, "video", "duration_s") or 0.0) for r in results)
    peak_values = [m["peak_rss_mb"] for m in metrics if m.get("peak_rss_mb") is not None]
    tracks_total = [_dig(r, "players", "tracks_total") for r in results]
    fragmentation = []
    for r in results:
        tracks = _dig(r, "players", "tracks_total")
        identities = _dig(r, "players", "logical_identities")
        if tracks is not None and identities:
            fragmentation.append(int(tracks) / int(identities))
    rally_counts = [_dig(r, "rally_segmentation", "count") for r in results]
    return {
        "schema": EVALUATION_SCHEMA,
        "generated_at": round(time.time(), 3),
        "scope": "saved analyses in this local database; no video or derived data leaves this machine",
        "analyses": {
            "total": counts["total"],
            "completed": counts["completed"],
            "failed": counts["failed"],
            "in_progress": counts["in_progress"],
            "failures_by_code": dict(failure_codes),
            "frames_analysed": frames,
            "video_seconds_analysed": round(seconds, 3),
        },
        "processing": {
            "measured_analyses": len(metrics),
            "wall_seconds_mean": _mean(m.get("wall_seconds") for m in metrics),
            "frames_per_second_mean": _mean(m.get("frames_per_second") for m in metrics),
            "cpu_utilisation_mean": _mean(m.get("cpu_utilisation_mean") for m in metrics),
            "peak_rss_mb_max": max(peak_values) if peak_values else None,
            "detector_ms_per_frame_mean": _mean(m.get("detector_ms_per_frame") for m in metrics),
            "derive_seconds_mean": _mean(m.get("derive_seconds") for m in metrics),
            "note": "Measured on the machine that ran each analysis. Depends on CPU, thread count and clip length.",
        },
        "shuttle_coverage": {
            "visible_ratio_mean": _mean(_dig(r, "shuttle", "visible_ratio") for r in results),
            "detected_ratio_mean": _mean(_dig(r, "shuttle", "detected_ratio") for r in results),
            "interpolated_frames_total": sum(int(_dig(r, "shuttle", "frames_interpolated") or 0) for r in results),
            "note": "Share of frames with a shuttle position. Image-space detections, not a detection accuracy.",
        },
        "tracking": {
            "tracks_total": sum(int(t) for t in tracks_total if t is not None),
            "tracks_per_analysis_mean": _mean(tracks_total),
            "tracks_per_identity_mean": _mean(fragmentation),
            "note": "1.0 means one tracker ID per logical identity. Higher values mean the tracker created more IDs. "
                    "This is a continuity proxy, not identity accuracy.",
        },
        "identities": {
            "events_total": sum(identity_counts.values()),
            "counts_by_kind": dict(identity_counts),
            "switches_suspected": identity_counts.get("identity_switch_suspected", 0),
            "note": "Suspected switches are logged and never applied automatically. Identity accuracy is not evaluated.",
        },
        "corrections": {
            "analyses_with_corrections": analyses_with_corrections,
            "entries_by_type": dict(correction_types),
            "note": "Manual corrections are stored apart from the raw inference outputs and applied on recompute.",
        },
        "rallies": {
            "status": "heuristic_candidates",
            "candidates_total": sum(c for c in rally_counts if c is not None),
            "analyses_with_candidates": sum(1 for c in rally_counts if c is not None),
            "validated": False,
            "evaluation": NOT_EVALUATED,
        },
        "shots": {"status": "unsupported", "evaluation": NOT_EVALUATED},
        "ground_truth": {
            "status": NOT_EVALUATED,
            "labelled_samples": labelled_samples,
            "note": "No labelled ground truth is available for the local samples, so precision, recall and accuracy are not reported.",
        },
    }
