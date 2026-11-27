"""golden-analysis/v1: a compact snapshot of one analysis, recomputed from the job's stored files.

The snapshot holds the numbers a later change could move: the observed-2d/v1 track counts, every contact with its
player, status, six-class estimate and px/s, the rally candidates, the dashboard values, the Estimated 3D outcome, the
coach dataset's movement comparison, the stored court calibration and the stored identity continuity.

Reads only. Nothing is written into the job folder, no model runs, and manual corrections are left out (raw AI output
alone), so a person's later review never changes a snapshot. A snapshot that differs means a derived number changed;
it says nothing about accuracy, because these clips have no ground truth.

Used by backend/tests/test_golden_samples.py and backend/tools/update_golden.py.
"""

from __future__ import annotations

import json
import os
from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Any, Iterator, Mapping, Optional

from app.services import coach_dataset
from app.services import match_document as M
from app.services import shot_dataset

SCHEMA = "smashlab.golden-analysis/v1"


@dataclass(frozen=True)
class StoredJob:
    """The parts of a job record the match document needs: an id and the folder that holds its files."""

    id: str
    output_dir: str
    status: str = "completed"


def _round(value: Any, digits: int = 4) -> Any:
    if isinstance(value, float):
        return round(value, digits)
    if isinstance(value, dict):
        return {key: _round(item, digits) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_round(item, digits) for item in value]
    return value


def _read(folder: str, name: str) -> Optional[dict]:
    try:
        with open(os.path.join(folder, name), encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def identity_continuity(tracks_doc: Optional[Mapping]) -> dict:
    """How many tracker tracks each logical identity was assembled from (1 means it never broke) and how often an
    identity moved from one track to another. Read from the stored player_tracks.json."""
    per_identity: dict[str, set] = defaultdict(set)
    switches: Counter = Counter()
    sequence: dict[str, list[tuple[int, int]]] = defaultdict(list)
    for track in (tracks_doc or {}).get("tracks", []):
        for obs in track.get("observations", []):
            identity = obs.get("identity")
            if identity:
                per_identity[identity].add(int(track["track_id"]))
                sequence[identity].append((int(obs["frame"]), int(track["track_id"])))
    for identity, items in sequence.items():
        items.sort()
        switches[identity] = sum(1 for (_fa, ta), (_fb, tb) in zip(items, items[1:]) if ta != tb)
    tracks_total = len((tracks_doc or {}).get("tracks", []))
    return {
        "tracks_total": tracks_total,
        "tracks_per_identity": {identity: len(ids) for identity, ids in sorted(per_identity.items())},
        "track_switches": {identity: switches[identity] for identity in sorted(per_identity)},
    }


def snapshot(output_dir: str, job_id: str) -> dict:
    """The golden snapshot of one stored analysis. Raises FileNotFoundError when the job's files are missing."""
    if not os.path.isfile(os.path.join(output_dir, "results.json")):
        raise FileNotFoundError(os.path.join(output_dir, "results.json"))
    job = StoredJob(job_id, output_dir)
    results = M._read_results(output_dir)
    video = results.get("video", {}) or {}
    track = M.observed_track(job)
    base = M.assemble(None, job, None, track=track, compute_estimated_3d=False, raw_only=True)
    shuttle_doc = M._shuttle_or_empty(job)
    records, _meta = shot_dataset.build_records(base, shuttle_doc, job_id=job_id, run_id="golden", video=video, track=track)
    estimated = M.estimated_3d_map(job, base, track)
    full = M.assemble(None, job, shot_dataset.by_frame(records), track=track, estimated_3d=estimated, raw_only=True)
    fps = float(video.get("fps") or shuttle_doc.get("fps") or full.get("fps") or 30.0)
    coach = coach_dataset.build(job_id=job_id, match_doc=full, records=records,
                                tracks_doc=_read(output_dir, "player_tracks.json"), results=results, fps=fps)

    observed = full.get("observed_2d", {}) or {}
    shots = (full.get("shots", {}) or {}).get("items", [])
    dashboard = full.get("dashboard", {}) or {}
    reasons: Counter = Counter()
    for value in estimated.values():
        reasons.update(value.get("rejection_reasons", []))
    court = results.get("court", {}) or {}
    stored_identity = results.get("identity", {}) or {}

    return _round({
        "schema": SCHEMA,
        "job_id": job_id,
        "video": {"fps": video.get("fps"), "width": video.get("width"), "height": video.get("height"),
                  "frames": observed.get("frames_total")},
        "observed_2d": {
            "version": observed.get("version"),
            "detected": observed.get("detected"),
            "interpolated": observed.get("interpolated"),
            "rejected": observed.get("rejected"),
            "invalid_steps": observed.get("invalid_steps"),
            "segments": observed.get("segments"),
            "frames_without_position": observed.get("frames_without_position"),
        },
        "contacts": [
            [shot["frame"], shot.get("player"), shot.get("contact_status"), shot.get("type"),
             (shot.get("speed") or {}).get("px_per_s")]
            for shot in shots
        ],
        "review": dict(sorted(Counter(record.get("review_status") for record in records).items())),
        "rallies": [[item.get("start_frame"), item.get("end_frame")] for item in (full.get("rallies", {}) or {}).get("items", [])],
        "dashboard": {
            "players": {
                identity: {
                    "contacts": block.get("contacts"),
                    "distance": (block.get("distance") or {}).get("value"),
                    "distance_unit": (block.get("distance") or {}).get("unit"),
                    "official_max_px_per_s": block.get("official_max_px_per_s"),
                    "most_frequent_estimate": (block.get("most_frequent_estimate") or {}).get("label"),
                }
                for identity, block in sorted((dashboard.get("players") or {}).items())
            },
            "speed_panel": {key: value for key, value in (dashboard.get("speed_panel") or {}).items()
                            if key not in ("unit", "shot_interval_basis")},
        },
        "estimated_3d": {
            "available": sum(1 for value in estimated.values() if value.get("status") == "available"),
            "rejected": sum(1 for value in estimated.values() if value.get("status") != "available"),
            "reasons": dict(sorted(reasons.items())),
        },
        "coach": {
            "movement": {key: coach["movement_comparison"].get(key)
                         for key in ("metric", "values", "more_movement", "difference_percent", "compared")},
            "shot_counts": coach.get("shot_counts"),
        },
        "court": {"status": court.get("status"), "score": court.get("score"), "coverage": court.get("coverage")},
        "identity": {
            **identity_continuity(_read(output_dir, "player_tracks.json")),
            "coverage": stored_identity.get("coverage"),
            "events": stored_identity.get("event_counts"),
        },
    })


def differences(expected: Any, actual: Any, path: str = "") -> Iterator[str]:
    """Every path where two snapshots differ, as readable lines."""
    if isinstance(expected, dict) and isinstance(actual, dict):
        for key in sorted(set(expected) | set(actual), key=str):
            where = f"{path}.{key}" if path else str(key)
            if key not in actual:
                yield f"{where}: missing (expected {expected[key]!r})"
            elif key not in expected:
                yield f"{where}: new value {actual[key]!r}"
            else:
                yield from differences(expected[key], actual[key], where)
        return
    if isinstance(expected, list) and isinstance(actual, list):
        if len(expected) != len(actual):
            yield f"{path}: {len(expected)} items expected, {len(actual)} now"
        for index, (left, right) in enumerate(zip(expected, actual)):
            yield from differences(left, right, f"{path}[{index}]")
        return
    if expected != actual:
        yield f"{path}: expected {expected!r}, now {actual!r}"
