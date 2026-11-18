"""Sessions: one per video. Analyses are runs of the pipeline on that video.

A session key is the video's identity, never a job id or a display name. The identity is the SHA-256 of the video
content, recorded in the job folder as ``input/sha256.txt``. A built-in sample and an upload of the same file therefore
share one session. Jobs without a recorded hash fall back to their sample id (``sample:<id>``) or to their own job id.

The session's active analysis is the newest job that completed successfully. A queued, running, failed or cancelled job
never becomes the active analysis, so a failed rerun leaves the previous result in place. Nothing is deleted: old job
folders stay on disk, and their annotations stay in their own corrections file.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Iterable, Optional

ACTIVE_STATES = ("queued", "running")
SHA_FILE = os.path.join("input", "sha256.txt")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")


def read_sha256(output_dir: str) -> Optional[str]:
    path = os.path.join(output_dir, SHA_FILE)
    if not os.path.isfile(path):
        return None
    value = open(path, encoding="utf-8").read().strip()
    return value if _HEX64.match(value) else None


HIDDEN_MARKER = "hidden.json"


def is_hidden(job) -> bool:
    """A job folder with hidden.json is left out of the Sessions list. Nothing is deleted; removing the file shows it again."""
    return os.path.isfile(os.path.join(job.output_dir, HIDDEN_MARKER))


def session_key(job) -> str:
    digest = read_sha256(job.output_dir)
    if digest:
        return f"video:{digest}"
    if job.source_kind == "sample" and job.source_detail:
        return f"sample:{job.source_detail}"
    return f"job:{job.id}"


@dataclass(frozen=True)
class Session:
    session_id: str
    source_kind: str
    source_name: str
    sample_id: Optional[str]
    active_job: Optional[object]
    running_job: Optional[object]
    jobs: tuple
    failed_since_success: int


def group_sessions(jobs: Iterable) -> list[Session]:
    """Group job records by session key. Each session shows its newest job as the source name reference."""
    buckets: dict[str, list] = {}
    for job in jobs:
        buckets.setdefault(session_key(job), []).append(job)
    sessions = []
    for key, members in buckets.items():
        members.sort(key=lambda item: item.created_at, reverse=True)
        completed = [job for job in members if job.status == "completed"]
        active = max(completed, key=lambda job: (job.finished_at or 0.0, job.created_at)) if completed else None
        running = next((job for job in members if job.status in ACTIVE_STATES), None)
        after = [job for job in members if active is None or job.created_at > active.created_at]
        failed_since = sum(1 for job in after if job.status == "failed")
        # The name shown is the sample's own when the session holds a built-in sample; otherwise the newest upload's.
        named = next((job for job in members if job.source_kind == "sample"), members[0])
        sessions.append(Session(
            session_id=key,
            source_kind=named.source_kind,
            source_name=named.source_name,
            sample_id=named.source_detail if named.source_kind == "sample" else None,
            active_job=active,
            running_job=running,
            jobs=tuple(members),
            failed_since_success=failed_since,
        ))
    sessions.sort(key=lambda s: (s.active_job or s.jobs[0]).created_at, reverse=True)
    return sessions


def running_job_for(jobs: Iterable, key: str):
    """The queued or running job for this session, if any. Used to refuse a duplicate inference run."""
    for job in jobs:
        if job.status in ACTIVE_STATES and session_key(job) == key:
            return job
    return None


def completed_jobs_for(jobs: Iterable, key: str, exclude_id: Optional[str] = None) -> list:
    return [job for job in jobs if job.status == "completed" and session_key(job) == key and job.id != exclude_id]


def active_sample_jobs(jobs: Iterable) -> list:
    """The active analysis of each built-in sample session. Uploads, hidden jobs and superseded runs are left out."""
    visible = [job for job in jobs if not is_hidden(job)]
    return [session.active_job for session in group_sessions(visible)
            if session.source_kind == "sample" and session.active_job is not None]
