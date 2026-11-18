"""JPEG thumbnails for the sample library. Read-only: the source video is never written."""

from __future__ import annotations

import cv2

from app.pipeline.media import MediaError


def make_thumbnail(path: str, target_width: int = 480) -> bytes:
    """A frame about one second in (or the first readable frame), scaled to ``target_width`` pixels wide."""
    capture = cv2.VideoCapture(path)
    try:
        if not capture.isOpened():
            raise MediaError("corrupt_video", "The sample could not be opened as a video.")
        fps = float(capture.get(cv2.CAP_PROP_FPS) or 0.0)
        total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        target = int(fps) if fps > 0 else 0
        if total > 0:
            target = min(target, total - 1)
        capture.set(cv2.CAP_PROP_POS_FRAMES, max(target, 0))
        ok, frame = capture.read()
        if not ok:
            capture.set(cv2.CAP_PROP_POS_FRAMES, 0)
            ok, frame = capture.read()
        if not ok:
            raise MediaError("corrupt_video", "No frame could be read for the thumbnail.")
    finally:
        capture.release()
    height, width = frame.shape[:2]
    resized = cv2.resize(
        frame, (target_width, max(1, round(height * target_width / width))), interpolation=cv2.INTER_AREA
    )
    ok, encoded = cv2.imencode(".jpg", resized, [cv2.IMWRITE_JPEG_QUALITY, 82])
    if not ok:
        raise MediaError("render_failed", "The thumbnail could not be encoded.")
    return encoded.tobytes()
