"""Durable job state and queue on SQLite (named Docker volume in production).

The queue follows Azure Queue Storage semantics so it can be replaced later without
changing the worker: ``receive`` hides a message for ``lease_seconds`` and increments
``dequeue_count``; ``delete`` acknowledges it. A crashed worker therefore releases its job
once the lease expires, and a retry happens automatically.
"""

from __future__ import annotations

import os
import sqlite3
import threading
import time
from dataclasses import dataclass
from typing import Optional, Protocol

JOB_STATUSES = ("queued", "running", "completed", "failed")

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    stage TEXT,
    progress REAL NOT NULL DEFAULT 0,
    source_kind TEXT NOT NULL,
    source_name TEXT NOT NULL,
    source_detail TEXT,
    input_path TEXT NOT NULL,
    output_dir TEXT NOT NULL,
    created_at REAL NOT NULL,
    started_at REAL,
    finished_at REAL,
    attempts INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    error_message TEXT
);
CREATE TABLE IF NOT EXISTS queue_messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL UNIQUE,
    visible_at REAL NOT NULL,
    dequeue_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS queue_visible ON queue_messages (visible_at, seq);
"""


@dataclass(frozen=True)
class QueueMessage:
    job_id: str
    dequeue_count: int


@dataclass(frozen=True)
class JobRecord:
    id: str
    status: str
    stage: Optional[str]
    progress: float
    source_kind: str
    source_name: str
    source_detail: Optional[str]
    input_path: str
    output_dir: str
    created_at: float
    started_at: Optional[float]
    finished_at: Optional[float]
    attempts: int
    error_code: Optional[str]
    error_message: Optional[str]


class JobQueue(Protocol):
    """Queue contract. An Azure Queue Storage adapter can implement the same three methods."""

    def enqueue(self, job_id: str) -> None: ...

    def receive(self, lease_seconds: float) -> Optional[QueueMessage]: ...

    def delete(self, job_id: str) -> None: ...


class SqliteStore:
    """Job records and the SQLite-backed queue. One connection guarded by a lock."""

    def __init__(self, path: str) -> None:
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(path, check_same_thread=False, timeout=30, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.executescript(SCHEMA)

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def ping(self) -> bool:
        with self._lock:
            self._conn.execute("SELECT 1").fetchone()
        return True

    # ----- jobs -----------------------------------------------------------------

    def create_job(
        self,
        job_id: str,
        source_kind: str,
        source_name: str,
        source_detail: Optional[str],
        input_path: str,
        output_dir: str,
    ) -> JobRecord:
        now = time.time()
        with self._lock:
            self._conn.execute(
                "INSERT INTO jobs (id, status, stage, progress, source_kind, source_name, source_detail, input_path, output_dir, created_at) "
                "VALUES (?, 'queued', 'queued', 0, ?, ?, ?, ?, ?, ?)",
                (job_id, source_kind, source_name, source_detail, input_path, output_dir, now),
            )
        record = self.get_job(job_id)
        assert record is not None
        return record

    def get_job(self, job_id: str) -> Optional[JobRecord]:
        with self._lock:
            row = self._conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return _job_from_row(row) if row else None

    def list_jobs(self, limit: int) -> list[JobRecord]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (int(limit),)
            ).fetchall()
        return [_job_from_row(row) for row in rows]

    def mark_running(self, job_id: str, attempts: int) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE jobs SET status='running', stage='starting', progress=0, started_at=?, attempts=?, "
                "error_code=NULL, error_message=NULL WHERE id=?",
                (time.time(), attempts, job_id),
            )

    def update_progress(self, job_id: str, stage: str, progress: float) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE jobs SET stage=?, progress=? WHERE id=? AND status='running'",
                (stage, max(0.0, min(1.0, float(progress))), job_id),
            )

    def mark_completed(self, job_id: str) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE jobs SET status='completed', stage='completed', progress=1, finished_at=? WHERE id=?",
                (time.time(), job_id),
            )

    def mark_failed(self, job_id: str, code: str, message: str) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE jobs SET status='failed', stage='failed', finished_at=?, error_code=?, error_message=? WHERE id=?",
                (time.time(), code, message[:500], job_id),
            )

    def counts(self) -> dict[str, int]:
        with self._lock:
            rows = self._conn.execute("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").fetchall()
        result = {status: 0 for status in JOB_STATUSES}
        for row in rows:
            result[row["status"]] = row["n"]
        return result

    # ----- queue ----------------------------------------------------------------

    def enqueue(self, job_id: str) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR IGNORE INTO queue_messages (job_id, visible_at, dequeue_count) VALUES (?, 0, 0)",
                (job_id,),
            )

    def receive(self, lease_seconds: float) -> Optional[QueueMessage]:
        now = time.time()
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                row = self._conn.execute(
                    "SELECT seq, job_id, dequeue_count FROM queue_messages WHERE visible_at <= ? ORDER BY seq LIMIT 1",
                    (now,),
                ).fetchone()
                if row is None:
                    self._conn.execute("COMMIT")
                    return None
                self._conn.execute(
                    "UPDATE queue_messages SET visible_at=?, dequeue_count=dequeue_count+1 WHERE seq=?",
                    (now + lease_seconds, row["seq"]),
                )
                self._conn.execute("COMMIT")
            except Exception:
                self._conn.execute("ROLLBACK")
                raise
        return QueueMessage(job_id=row["job_id"], dequeue_count=row["dequeue_count"] + 1)

    def delete(self, job_id: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM queue_messages WHERE job_id=?", (job_id,))

    def queue_depth(self) -> int:
        with self._lock:
            row = self._conn.execute("SELECT COUNT(*) AS n FROM queue_messages").fetchone()
        return int(row["n"])

    def requeue_interrupted(self) -> int:
        """Queue again the jobs that a previous process left running, at once instead of after their lease.

        The worker runs one job at a time in one process, so any lease present when this process starts belongs to
        a process that has exited. Without this, an interrupted job showed as running until its lease expired.
        Returns the number of jobs that were running.
        """
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                interrupted = int(
                    self._conn.execute("SELECT COUNT(*) AS n FROM jobs WHERE status='running'").fetchone()["n"]
                )
                self._conn.execute(
                    "UPDATE jobs SET status='queued', stage='queued', progress=0, started_at=NULL WHERE status='running'"
                )
                self._conn.execute("UPDATE queue_messages SET visible_at=0 WHERE visible_at > 0")
                self._conn.execute(
                    "INSERT OR IGNORE INTO queue_messages (job_id, visible_at, dequeue_count) "
                    "SELECT id, 0, 0 FROM jobs WHERE status='queued'"
                )
                self._conn.execute("COMMIT")
            except Exception:
                self._conn.execute("ROLLBACK")
                raise
        return interrupted


def _job_from_row(row: sqlite3.Row) -> JobRecord:
    return JobRecord(
        id=row["id"],
        status=row["status"],
        stage=row["stage"],
        progress=float(row["progress"]),
        source_kind=row["source_kind"],
        source_name=row["source_name"],
        source_detail=row["source_detail"],
        input_path=row["input_path"],
        output_dir=row["output_dir"],
        created_at=float(row["created_at"]),
        started_at=row["started_at"],
        finished_at=row["finished_at"],
        attempts=int(row["attempts"]),
        error_code=row["error_code"],
        error_message=row["error_message"],
    )
