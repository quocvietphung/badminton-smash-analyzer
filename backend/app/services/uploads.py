"""Upload validation: extension, ISO-BMFF container signature and a streamed size cap."""

from __future__ import annotations

import os
from typing import Protocol

ALLOWED_SUFFIXES = (".mp4", ".mov")
CHUNK_BYTES = 1024 * 1024


class UploadRejected(Exception):
    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


class _Readable(Protocol):
    async def read(self, size: int = -1) -> bytes: ...


def check_filename(filename: str) -> str:
    suffix = os.path.splitext(filename or "")[1].lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise UploadRejected(415, "unsupported_format", "Only MP4 or MOV files are accepted.")
    return suffix


def check_container(head: bytes) -> None:
    """MP4 and MOV files carry an 'ftyp' box at byte offset 4."""
    if len(head) < 12 or head[4:8] != b"ftyp":
        raise UploadRejected(415, "unsupported_format", "The file is not an MP4 or MOV container.")


async def save_upload(upload: _Readable, destination: str, max_bytes: int) -> int:
    """Stream the upload to disk; delete the partial file when the cap is exceeded."""
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    written = 0
    head = b""
    try:
        with open(destination, "wb") as handle:
            while True:
                chunk = await upload.read(CHUNK_BYTES)
                if not chunk:
                    break
                if len(head) < 12:
                    head = (head + chunk)[:12]
                written += len(chunk)
                if written > max_bytes:
                    raise UploadRejected(413, "file_too_large", "The upload is larger than the configured limit.")
                handle.write(chunk)
        if written == 0:
            raise UploadRejected(400, "empty_file", "The upload is empty.")
        check_container(head)
    except UploadRejected:
        _remove_quietly(destination)
        raise
    return written


def _remove_quietly(path: str) -> None:
    try:
        os.remove(path)
    except FileNotFoundError:
        pass
