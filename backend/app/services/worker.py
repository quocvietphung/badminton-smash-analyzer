"""Background worker: receives queue messages, runs the analysis pipeline, records job state.

One worker thread processes one job at a time. The pipeline is CPU-bound and the job state
lives in SQLite, so a restarted container resumes queued jobs and retries jobs whose lease
expired (see services/store.py).
"""

from __future__ import annotations

import logging
import threading
import time
import traceback
from typing import Callable, Optional

from app.config import Settings
from app.pipeline.media import MediaError
from app.pipeline.runner import AnalysisRunner, PipelineOptions
from app.analytics import trajectory_rules as R
from app.services import match_document
from app.services.store import JobQueue, SqliteStore

logger = logging.getLogger("smashlab.worker")


class AnalysisWorker(threading.Thread):
    def __init__(
        self,
        store: SqliteStore,
        queue: JobQueue,
        settings: Settings,
        runner_factory: Optional[Callable[[PipelineOptions, Callable[[str, float], None]], AnalysisRunner]] = None,
    ) -> None:
        super().__init__(name="smashlab-analysis-worker", daemon=True)
        self._store = store
        self._queue = queue
        self._settings = settings
        self._stop_event = threading.Event()
        self._runner_factory = runner_factory or (lambda options, progress: AnalysisRunner(options, progress))
        self.processed = 0
        self.last_error: Optional[str] = None

    def stop(self) -> None:
        self._stop_event.set()

    @property
    def running(self) -> bool:
        return self.is_alive() and not self._stop_event.is_set()

    def run(self) -> None:  # pragma: no cover - exercised through the integration test
        while not self._stop_event.is_set():
            try:
                message = self._queue.receive(self._settings.lease_seconds)
            except Exception:  # keep the worker alive on transient database errors
                logger.exception("queue receive failed")
                self._stop_event.wait(2.0)
                continue
            if message is None:
                self._stop_event.wait(1.0)
                continue
            self.process_message(message.job_id, message.dequeue_count)

    def process_message(self, job_id: str, dequeue_count: int) -> None:
        job = self._store.get_job(job_id)
        if job is None or job.status in ("completed", "failed"):
            self._queue.delete(job_id)
            return
        if dequeue_count > self._settings.max_attempts:
            self._store.mark_failed(job_id, "retry_exhausted", "The job failed on every attempt.")
            self._queue.delete(job_id)
            return

        self._store.mark_running(job_id, attempts=dequeue_count)
        options = PipelineOptions(
            models_dir=self._settings.models_dir,
            threads=self._settings.onnx_threads,
            deadline=time.monotonic() + self._settings.job_timeout_s,
            input_dir=self._settings.input_dir,
        )

        def progress(stage: str, fraction: float) -> None:
            self._store.update_progress(job_id, stage, fraction)

        try:
            runner = self._runner_factory(options, progress)
            runner.run(job.input_path, job.output_dir, job_id, _source_payload(job))
        except MediaError as exc:
            self.last_error = f"{exc.code}: {exc.message}"
            logger.warning("job %s failed: %s", job_id, self.last_error)
            self._store.mark_failed(job_id, exc.code, exc.message)
        except Exception:
            self.last_error = traceback.format_exc(limit=3)
            logger.error("job %s crashed:\n%s", job_id, self.last_error)
            self._store.mark_failed(job_id, "internal_error", "The analysis failed unexpectedly. See the server log.")
        else:
            try:
                # The trajectory dataset belongs to this job and is built from its own outputs before it is marked complete.
                match_document.write_for_job(self._store, job)
            except R.PipelineIntegrityError as exc:
                self.last_error = f"{exc.code}: {exc}"
                logger.error("job %s failed the trajectory dataset: %s", job_id, self.last_error)
                self._store.mark_failed(job_id, exc.code, str(exc))
            else:
                self._store.mark_completed(job_id)
                self.processed += 1
        finally:
            self._queue.delete(job_id)


def _source_payload(job) -> dict:
    payload = {"kind": job.source_kind, "name": job.source_name}
    if job.source_detail:
        payload["detail"] = job.source_detail
    return payload
