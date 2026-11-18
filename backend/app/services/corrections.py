"""Manual corrections for one analysis job.

Corrections live in ``corrections.json`` inside the job folder. The raw inference files (``raw/``, the shuttle
trajectory and the detections) are never edited. The file is append-only: every correction keeps its id, its
creation time and its content, so the history can be reviewed. When two corrections cover the same frame and
tracker ID, the later one wins.

Correction types:
- ``identity``: assign a logical identity (P1 to P4) to one tracker ID over a frame interval.
- ``court_calibration``: four image corners of the court (near-left, near-right, far-right, far-left).
- ``mode``: "singles" or "doubles" (sets the number of identities).
- ``contact_review``: confirm or reject a contact candidate at a frame, or add a missed contact for a player.
- ``shot_label``: set the shot type of the shot at a frame (the build has no validated shot classifier).
- ``rally_boundary``: set the start and end frame of a rally candidate, or add a rally.
- ``hit_frame``: record the frame where the racket meets the shuttle for the contact at ``frame`` (ground truth for timing).

The last three change only the match analytics, so they do not rebuild the annotated video.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from typing import Optional

from app.analytics.match import SHOT_TYPES

SCHEMA = "smashlab.corrections/v1"
FILE_NAME = "corrections.json"
ANALYTICS_TYPES = ("contact_review", "shot_label", "rally_boundary", "hit_frame")
TYPES = ("identity", "court_calibration", "mode") + ANALYTICS_TYPES
CONTACT_DECISIONS = ("confirmed", "rejected", "added")
IDENTITY_KEYS = {2: ("P1", "P2"), 4: ("P1", "P2", "P3", "P4")}
NOTE_LIMIT = 280


class CorrectionError(ValueError):
    """Raised when a correction is malformed or refers to data the job does not have."""


def corrections_path(job_dir: str) -> str:
    return os.path.join(job_dir, FILE_NAME)


def load(job_dir: str) -> dict:
    path = corrections_path(job_dir)
    if not os.path.isfile(path):
        return {"schema": SCHEMA, "entries": []}
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def _write(job_dir: str, document: dict) -> None:
    path = corrections_path(job_dir)
    temporary = path + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(document, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    os.replace(temporary, path)


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def validate(payload: dict, *, frames_total: int, width: int, height: int, players: int) -> None:
    kind = payload.get("type")
    if kind not in TYPES:
        raise CorrectionError(f"unknown correction type: {kind!r}")
    note = payload.get("note", "")
    if not isinstance(note, str) or len(note) > NOTE_LIMIT:
        raise CorrectionError("note must be text of at most 280 characters")
    if kind == "identity":
        track_id = payload.get("track_id")
        identity = payload.get("identity")
        start = payload.get("start_frame")
        end = payload.get("end_frame")
        if not _is_int(track_id) or track_id < 0:
            raise CorrectionError("track_id must be a non-negative integer")
        if identity not in IDENTITY_KEYS.get(players, ()):
            raise CorrectionError(f"identity must be one of {', '.join(IDENTITY_KEYS.get(players, ()))} for this analysis")
        if not (_is_int(start) and _is_int(end) and 0 <= start <= end < frames_total):
            raise CorrectionError("start_frame and end_frame must be integers inside the video")
    elif kind == "court_calibration":
        corners = payload.get("corners_px")
        if not isinstance(corners, list) or len(corners) != 4:
            raise CorrectionError("corners_px must list four [x, y] points")
        for point in corners:
            if not (isinstance(point, list) and len(point) == 2 and all(isinstance(v, (int, float)) for v in point)):
                raise CorrectionError("each corner must be an [x, y] pair of numbers")
            if not (0 <= point[0] <= width and 0 <= point[1] <= height):
                raise CorrectionError("corners must lie inside the video frame")
        if not _is_convex_quad(corners):
            raise CorrectionError("the four corners must form a convex quadrilateral in the order near-left, near-right, far-right, far-left")
    elif kind == "mode":
        if payload.get("mode") not in ("singles", "doubles"):
            raise CorrectionError("mode must be 'singles' or 'doubles'")
    elif kind in ("contact_review", "shot_label"):
        frame = payload.get("frame")
        if not (_is_int(frame) and 0 <= frame < frames_total):
            raise CorrectionError("frame must be an integer inside the video")
        player = payload.get("player")
        if player is not None and player not in IDENTITY_KEYS.get(players, ()):
            raise CorrectionError(f"player must be one of {', '.join(IDENTITY_KEYS.get(players, ()))} for this analysis")
        if kind == "contact_review":
            decision = payload.get("decision")
            if decision not in CONTACT_DECISIONS:
                raise CorrectionError("decision must be 'confirmed', 'rejected' or 'added'")
            if decision == "added" and player is None:
                raise CorrectionError("an added contact needs a player")
        elif payload.get("shot_type") not in SHOT_TYPES:
            raise CorrectionError(f"shot_type must be one of {', '.join(SHOT_TYPES)}")
    elif kind == "hit_frame":
        frame = payload.get("frame")
        hit = payload.get("hit_frame")
        if not (_is_int(frame) and 0 <= frame < frames_total):
            raise CorrectionError("frame must be an integer inside the video")
        if not (_is_int(hit) and 0 <= hit < frames_total):
            raise CorrectionError("hit_frame must be an integer inside the video")
    elif kind == "rally_boundary":
        index = payload.get("rally_index")
        if index is not None and (not _is_int(index) or index < 1):
            raise CorrectionError("rally_index must be a positive integer, or omitted to add a rally")
        start = payload.get("start_frame")
        end = payload.get("end_frame")
        if not (_is_int(start) and _is_int(end) and 0 <= start < end < frames_total):
            raise CorrectionError("start_frame must be before end_frame, both inside the video")


def _is_convex_quad(points: list) -> bool:
    signs = []
    for i in range(4):
        ax, ay = points[i]
        bx, by = points[(i + 1) % 4]
        cx, cy = points[(i + 2) % 4]
        cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx)
        signs.append(cross > 0)
    if len(set(signs)) != 1:
        return False
    area = 0.0
    for i in range(4):
        x1, y1 = points[i]
        x2, y2 = points[(i + 1) % 4]
        area += x1 * y2 - x2 * y1
    return abs(area) / 2.0 > 1.0


ALLOWED_KEYS = (
    "type", "track_id", "identity", "start_frame", "end_frame", "corners_px", "mode", "note",
    "frame", "decision", "player", "shot_type", "rally_index", "hit_frame",
)


def append(job_dir: str, job_id: str, payload: dict, *, frames_total: int, width: int, height: int, players: int) -> dict:
    """Validate and append one correction. Only known fields are stored; the id and time are set here."""
    clean = {key: payload[key] for key in ALLOWED_KEYS if key in payload}
    validate(clean, frames_total=frames_total, width=width, height=height, players=players)
    document = load(job_dir)
    document["schema"] = SCHEMA
    document["job_id"] = job_id
    entry = {**clean, "id": uuid.uuid4().hex, "created_at": round(time.time(), 3)}
    document.setdefault("entries", []).append(entry)
    os.makedirs(job_dir, exist_ok=True)
    _write(job_dir, document)
    return entry


def discard(job_dir: str, entry_id: str) -> None:
    """Remove an entry that was never applied, for example after a failed recompute."""
    document = load(job_dir)
    document["entries"] = [entry for entry in document.get("entries", []) if entry.get("id") != entry_id]
    _write(job_dir, document)


def forced_identities(entries: list[dict]) -> dict[int, dict[int, str]]:
    """frame -> {tracker id -> identity}. Later corrections overwrite earlier ones for the same frame and track."""
    forced: dict[int, dict[int, str]] = {}
    for entry in entries:
        if entry.get("type") != "identity":
            continue
        for frame in range(entry["start_frame"], entry["end_frame"] + 1):
            forced.setdefault(frame, {})[entry["track_id"]] = entry["identity"]
    return forced


def latest(entries: list[dict], kind: str) -> Optional[dict]:
    found = [entry for entry in entries if entry.get("type") == kind]
    return found[-1] if found else None
