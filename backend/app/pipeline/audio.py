"""Audio for the annotated MP4.

The annotated video is written without sound (``H264Writer`` uses ``-an``). This module muxes an AAC track into it
afterwards, from one of two places:

- an uploaded clip that has its own audio track: the track of the input file itself, from its start;
- a built-in sample: the sample file is trimmed without sound on purpose (its SHA-256 identifies the session), so the
  track comes from the raw Wikimedia Commons file that the manifest names, at the sample's start offset.

Audio is optional. When no track is available, or the mux fails, the annotated video keeps its picture and the
caller records that no audio was attached.
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
from dataclasses import dataclass
from typing import Optional

from app.pipeline.media import MediaError, ffmpeg_path

logger = logging.getLogger(__name__)

_AUDIO_STREAM = re.compile(r"Stream #\d+:\d+[^\n]*: Audio:")


@dataclass(frozen=True)
class AudioSource:
    path: str
    start_s: float = 0.0


def has_audio_stream(path: str) -> bool:
    """True when ffmpeg reports an audio stream in the file. Missing ffmpeg or an unreadable file means False."""
    binary = ffmpeg_path()
    if binary is None or not os.path.isfile(path):
        return False
    try:
        result = subprocess.run(
            [binary, "-hide_banner", "-i", path],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return _AUDIO_STREAM.search(result.stderr or "") is not None


def sample_audio_source(input_dir: str, sample_id: str) -> Optional[AudioSource]:
    """Audio of a built-in sample, from its raw source in the dataset manifest. None when it cannot be found."""
    try:
        with open(os.path.join(input_dir, "manifest.json"), encoding="utf-8") as handle:
            manifest = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None
    sample = next((item for item in manifest.get("samples", []) if item.get("id") == sample_id), None)
    if sample is None:
        return None
    raw = next((item for item in manifest.get("raw_sources", []) if item.get("id") == sample.get("source_id")), None)
    if raw is None or not raw.get("raw_file"):
        return None
    start = (sample.get("trim") or {}).get("start_s", sample.get("source_start_s", 0))
    try:
        start_s = float(start)
    except (TypeError, ValueError):
        return None
    path = os.path.join(input_dir, raw["raw_file"])
    if not has_audio_stream(path):
        return None
    return AudioSource(path=path, start_s=start_s)


def attach_audio(video_path: str, source: AudioSource, duration_s: float) -> None:
    """Replace ``video_path`` with a copy that carries AAC audio from ``source``, cut to the video length.

    The picture is copied, not re-encoded. The write goes to a temporary file first, so a failed mux leaves the
    silent video in place.
    """
    binary = ffmpeg_path()
    if binary is None:
        raise MediaError("ffmpeg_unavailable", "ffmpeg is not installed in this environment.")
    temporary = f"{video_path}.with-audio.tmp.mp4"
    command = [
        binary,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        video_path,
        "-ss",
        f"{max(source.start_s, 0.0):.3f}",
        "-i",
        source.path,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-t",
        f"{max(duration_s, 0.0):.3f}",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-shortest",
        "-movflags",
        "+faststart",
        temporary,
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=600, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        _remove_quietly(temporary)
        raise MediaError("audio_failed", f"ffmpeg could not attach audio: {exc}") from exc
    if result.returncode != 0:
        _remove_quietly(temporary)
        raise MediaError("audio_failed", f"ffmpeg exited with {result.returncode}: {(result.stderr or '').strip()[:300]}")
    os.replace(temporary, video_path)


def _remove_quietly(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass
