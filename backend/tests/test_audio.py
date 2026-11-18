"""Audio muxing for the annotated MP4 (app.pipeline.audio). Needs an ffmpeg binary; skipped when there is none."""

from __future__ import annotations

import json
import os
import re
import subprocess

import pytest

from app.pipeline import audio
from app.pipeline.media import MediaError, ffmpeg_path

pytestmark = pytest.mark.skipif(ffmpeg_path() is None, reason="ffmpeg is not installed")


def _run(*args: str) -> None:
    subprocess.run([ffmpeg_path(), "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


def _silent_video(path: os.PathLike, seconds: float = 2.0) -> str:
    _run("-f", "lavfi", "-i", f"testsrc=duration={seconds}:size=64x48:rate=10",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", str(path))
    return str(path)


def _tone(path: os.PathLike, seconds: float = 4.0) -> str:
    _run("-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}", "-c:a", "aac", str(path))
    return str(path)


def _streams(path: str) -> str:
    result = subprocess.run([ffmpeg_path(), "-hide_banner", "-i", path], capture_output=True, text=True, check=False)
    return result.stderr


def test_has_audio_stream_tells_silent_and_sound_files_apart(tmp_path):
    silent = _silent_video(tmp_path / "silent.mp4")
    with_sound = _tone(tmp_path / "tone.m4a")
    assert audio.has_audio_stream(silent) is False
    assert audio.has_audio_stream(with_sound) is True
    assert audio.has_audio_stream(str(tmp_path / "missing.mp4")) is False


def test_attach_audio_adds_an_aac_track_and_keeps_the_picture(tmp_path):
    video = _silent_video(tmp_path / "annotated.mp4", seconds=2.0)
    source = audio.AudioSource(path=_tone(tmp_path / "tone.m4a", seconds=4.0), start_s=1.0)

    audio.attach_audio(video, source, duration_s=2.0)

    report = _streams(video)
    assert re.search(r"Stream #0:0.*Video: h264", report), report
    assert re.search(r"Stream #0:1.*Audio: aac", report), report
    assert not os.path.exists(f"{video}.with-audio.tmp.mp4")


def test_failed_attach_leaves_the_silent_video_untouched(tmp_path):
    video = _silent_video(tmp_path / "annotated.mp4")
    before = open(video, "rb").read()
    missing = audio.AudioSource(path=str(tmp_path / "no-such-source.webm"), start_s=0.0)

    with pytest.raises(MediaError):
        audio.attach_audio(video, missing, duration_s=2.0)

    assert open(video, "rb").read() == before
    assert not os.path.exists(f"{video}.with-audio.tmp.mp4")


def _write_manifest(input_dir, raw_file: str, *, start_s: float = 150) -> None:
    manifest = {
        "raw_sources": [{"id": "raw-1", "raw_file": raw_file}],
        "samples": [{"id": "sample-x", "source_id": "raw-1", "source_start_s": str(start_s),
                     "trim": {"start_s": start_s, "duration_s": 15}}],
    }
    with open(os.path.join(input_dir, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle)


def test_sample_audio_comes_from_the_raw_source_at_the_manifest_offset(tmp_path):
    (tmp_path / "raw").mkdir()
    _tone(tmp_path / "raw" / "source.m4a")
    _write_manifest(tmp_path, "raw/source.m4a", start_s=150)

    found = audio.sample_audio_source(str(tmp_path), "sample-x")

    assert found is not None
    assert found.path == os.path.join(str(tmp_path), "raw", "source.m4a")
    assert found.start_s == 150.0


def test_sample_without_a_raw_source_gets_no_audio(tmp_path):
    (tmp_path / "raw").mkdir()
    _silent_video(tmp_path / "raw" / "source.mp4")
    _write_manifest(tmp_path, "raw/source.mp4")

    assert audio.sample_audio_source(str(tmp_path), "sample-x") is None
    assert audio.sample_audio_source(str(tmp_path), "unknown-sample") is None
    assert audio.sample_audio_source(str(tmp_path / "absent"), "sample-x") is None
