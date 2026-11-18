"""A job interrupted by a restart is queued again at once, not after its lease runs out."""

import uuid

from app.services.store import SqliteStore


def new_store(tmp_path):
    return SqliteStore(str(tmp_path / "queue" / "jobs.sqlite"))


def test_interrupted_job_is_requeued_when_a_new_process_starts(tmp_path):
    store = new_store(tmp_path)
    job_id = uuid.uuid4().hex
    store.create_job(job_id, "sample", "s", "s", "/x.mp4", str(tmp_path))
    store.enqueue(job_id)
    first = store.receive(3600)  # the previous process leased the job for a long time
    store.mark_running(job_id, attempts=first.dequeue_count)
    assert store.receive(3600) is None  # still leased, so not visible
    store.close()

    restarted = new_store(tmp_path)  # a new process opens the same database
    assert restarted.requeue_interrupted() == 1
    job = restarted.get_job(job_id)
    assert job.status == "queued" and job.stage == "queued" and job.progress == 0
    again = restarted.receive(3600)
    assert again is not None and again.job_id == job_id and again.dequeue_count == 2
    restarted.close()


def test_requeue_does_nothing_when_no_job_was_interrupted(tmp_path):
    store = new_store(tmp_path)
    assert store.requeue_interrupted() == 0
    store.close()


def test_queued_job_without_a_message_gets_one(tmp_path):
    store = new_store(tmp_path)
    job_id = uuid.uuid4().hex
    store.create_job(job_id, "sample", "s", "s", "/x.mp4", str(tmp_path))  # never enqueued
    store.requeue_interrupted()
    message = store.receive(60)
    assert message is not None and message.job_id == job_id
    store.close()
