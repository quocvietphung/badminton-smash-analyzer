"""The job time limit grows with the clip length, and the queue lease outlives the longest job.

Before: one fixed limit of 1200 s for every clip. A 120 s clip (the longest the service accepts) needs about
12 s per video second on the host CPU, about 1440 s plus overhead, so it was stopped before it could finish.
"""

from app.config import Settings
from app.pipeline.media import MediaError
from app.services.worker import AnalysisWorker, clip_duration_s
from tests.test_service_and_api import make_settings as settings_for, new_store, write_video


def test_short_clips_keep_the_floor_and_long_clips_get_their_length_budget(tmp_path):
    settings = settings_for(tmp_path, max_duration_s=120.0, job_timeout_s=1200.0)
    assert settings.job_seconds_per_video_s == 30.0 and settings.job_overhead_s == 300.0
    assert settings.job_timeout_for(15.0) == 1200.0  # 300 + 450 is below the floor
    assert settings.job_timeout_for(60.0) == 2100.0  # 300 + 30 x 60
    assert settings.job_timeout_for(120.0) == 3900.0  # 300 + 30 x 120
    assert settings.job_timeout_for(118.0) > 118.0 * 12.0 + 300.0  # the measured host rate fits with room to spare


def test_an_unknown_or_too_long_clip_gets_the_budget_of_the_longest_accepted_clip(tmp_path):
    settings = settings_for(tmp_path, max_duration_s=120.0, job_timeout_s=1200.0)
    assert settings.job_timeout_for(None) == settings.job_timeout_for(120.0) == 3900.0
    assert settings.job_timeout_for(0.0) == 3900.0
    assert settings.job_timeout_for(500.0) == 3900.0  # uploads above the limit are refused before they reach a job


def test_the_environment_sets_the_budget_and_the_lease_outlives_the_longest_job(monkeypatch):
    for name in ("SMASHLAB_LEASE_S", "SMASHLAB_JOB_SECONDS_PER_VIDEO_S", "SMASHLAB_JOB_OVERHEAD_S"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("SMASHLAB_JOB_TIMEOUT_S", "1200")
    monkeypatch.setenv("SMASHLAB_MAX_DURATION_S", "120")
    settings = Settings.from_env()
    assert settings.job_timeout_for(120.0) == 3900.0
    assert settings.lease_seconds == 3900.0 + 120.0
    monkeypatch.setenv("SMASHLAB_JOB_SECONDS_PER_VIDEO_S", "20")
    monkeypatch.setenv("SMASHLAB_JOB_OVERHEAD_S", "100")
    settings = Settings.from_env()
    assert settings.job_timeout_for(120.0) == 2500.0 and settings.lease_seconds == 2620.0


def test_the_worker_gives_the_runner_the_limit_of_this_clip(tmp_path):
    settings = settings_for(tmp_path, max_duration_s=120.0, job_timeout_s=10.0, job_seconds_per_video_s=4.0,
                            job_overhead_s=5.0)
    video = write_video(tmp_path / "input" / "clip.mp4", frames=30, fps=10.0)  # 3 s
    assert clip_duration_s(video) == 3.0
    assert clip_duration_s(str(tmp_path / "missing.mp4")) is None
    store = new_store(tmp_path)
    seen = {}

    class StopRunner:
        def __init__(self, options, progress):
            seen["options"] = options

        def run(self, *args):
            raise MediaError("stop", "test stop after the options were read")

    worker = AnalysisWorker(store, store, settings, runner_factory=lambda options, progress: StopRunner(options, progress))
    store.create_job("job-t", "upload", "clip.mp4", "", video, str(tmp_path / "outputs" / "job-t"))
    worker.process_message("job-t", 1)
    assert seen["options"].timeout_s == 17.0  # 5 + 4 x 3 s, above the 10 s floor
    assert store.get_job("job-t").status == "failed"


def test_the_timeout_message_names_the_limit():
    from app.pipeline.runner import AnalysisRunner, PipelineOptions

    runner = AnalysisRunner(PipelineOptions(models_dir="/none", deadline=0.0, timeout_s=3900.0))
    try:
        runner._check_deadline()
    except MediaError as exc:
        assert exc.code == "timeout" and "3900 s" in exc.message
    else:
        raise AssertionError("the deadline in the past did not stop the job")
