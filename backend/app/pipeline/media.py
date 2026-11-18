"""Video probing, sampling and H.264 writing for the local analysis pipeline."""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from typing import Optional

import cv2
import numpy as np

from app.ai.shuttle_tracking.tracknet import resize_to_model


class MediaError(Exception):
    """Raised for unreadable or unsupported media. ``code`` is stable for API clients."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class VideoInfo:
    width: int
    height: int
    fps: float
    frame_count: int

    @property
    def duration_s(self) -> float:
        return self.frame_count / self.fps if self.fps > 0 else 0.0


def probe_video(path: str) -> VideoInfo:
    capture = cv2.VideoCapture(path)
    try:
        if not capture.isOpened():
            raise MediaError("corrupt_video", "The file could not be opened as a video.")
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = float(capture.get(cv2.CAP_PROP_FPS))
        frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
        ok, _ = capture.read()
        if not ok:
            raise MediaError("corrupt_video", "The video contains no decodable frames.")
    finally:
        capture.release()
    if width <= 0 or height <= 0 or fps <= 0:
        raise MediaError("corrupt_video", "The video has no usable size or frame rate.")
    return VideoInfo(width=width, height=height, fps=fps, frame_count=max(frame_count, 0))


def iter_frames(path: str):
    """Yield (index, BGR frame) sequentially."""
    capture = cv2.VideoCapture(path)
    try:
        index = 0
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            yield index, frame
            index += 1
    finally:
        capture.release()


def iter_frames_with_timestamps(path: str):
    """Yield decoded frames with the presentation timestamp reported by the decoder.

    Some OpenCV backends report only zero for ``CAP_PROP_POS_MSEC``. The caller must
    validate the series before labelling it as presentation timestamps.
    """
    capture = cv2.VideoCapture(path)
    try:
        index = 0
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            timestamp_s = float(capture.get(cv2.CAP_PROP_POS_MSEC) or 0.0) / 1000.0
            yield index, frame, timestamp_s
            index += 1
    finally:
        capture.release()


def sample_background_frames(
    path: str, total_frames: int, max_samples: int = 120, calibration_samples: int = 9
) -> tuple[int, list[np.ndarray], list[np.ndarray]]:
    """Read the clip once.

    Returns (frame count, up to ``max_samples`` frames resized to the model grid for the shuttle
    background, up to ``calibration_samples`` full-resolution frames for court calibration).
    """
    step = max(1, total_frames // max_samples) if total_frames > 0 else 5
    calib_step = max(1, total_frames // calibration_samples) if total_frames > 0 else 10
    samples: list[np.ndarray] = []
    full_frames: list[np.ndarray] = []
    count = 0
    for index, frame in iter_frames(path):
        if index % step == 0 and len(samples) < max_samples:
            samples.append(resize_to_model(frame))
        if index % calib_step == 0 and len(full_frames) < calibration_samples:
            full_frames.append(frame.copy())
        count = index + 1
    if not samples:
        raise MediaError("corrupt_video", "No frames could be sampled for the background model.")
    return count, samples, full_frames


def uint8_median(frames: list[np.ndarray]) -> np.ndarray:
    """Per-pixel median of an odd number of uint8 frames without float copies."""
    if not frames:
        raise MediaError("corrupt_video", "No frames were available for the calibration background.")
    stack = np.stack(frames, axis=0)
    middle = stack.shape[0] // 2
    if stack.shape[0] % 2 == 1:
        return np.partition(stack, middle, axis=0)[middle]
    return ((np.partition(stack, middle - 1, axis=0)[middle - 1].astype(np.uint16) + np.partition(stack, middle, axis=0)[middle].astype(np.uint16)) // 2).astype(np.uint8)


def ffmpeg_path() -> Optional[str]:
    return shutil.which("ffmpeg")


class H264Writer:
    """Pipes raw BGR frames to ffmpeg (libx264, yuv420p, faststart, no audio)."""

    def __init__(self, path: str, width: int, height: int, fps: float, crf: int = 23, preset: str = "veryfast") -> None:
        binary = ffmpeg_path()
        if binary is None:
            raise MediaError("ffmpeg_unavailable", "ffmpeg is not installed in this environment.")
        self.width = width - (width % 2)
        self.height = height - (height % 2)
        command = [
            binary,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "bgr24",
            "-s",
            f"{self.width}x{self.height}",
            "-r",
            f"{fps:.6f}",
            "-i",
            "pipe:0",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            preset,
            "-crf",
            str(crf),
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            path,
        ]
        self._process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
        self.frames_written = 0

    def write(self, frame_bgr: np.ndarray) -> None:
        if self._process.stdin is None:
            raise MediaError("render_failed", "ffmpeg input is closed.")
        frame = frame_bgr[: self.height, : self.width]
        try:
            self._process.stdin.write(np.ascontiguousarray(frame).tobytes())
        except BrokenPipeError as exc:
            raise MediaError("render_failed", "ffmpeg stopped while receiving frames.") from exc
        self.frames_written += 1

    def close(self) -> None:
        if self._process.stdin is not None:
            self._process.stdin.close()
        stderr = self._process.stderr.read().decode("utf-8", errors="replace") if self._process.stderr else ""
        return_code = self._process.wait()
        if return_code != 0:
            raise MediaError("render_failed", f"ffmpeg exited with {return_code}: {stderr.strip()[:300]}")
