"""Runtime settings, read from SMASHLAB_* environment variables with local-development defaults."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

REPO_ROOT = Path(__file__).resolve().parents[2]


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return int(raw) if raw not in (None, "") else default


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    return float(raw) if raw not in (None, "") else default


def _env_list(name: str, default: list[str]) -> list[str]:
    raw = os.environ.get(name)
    if raw in (None, ""):
        return list(default)
    return [item.strip() for item in raw.split(",") if item.strip()]


@dataclass(frozen=True)
class Settings:
    input_dir: str
    samples_dir: str
    samples_manifest: str
    models_dir: str
    outputs_dir: str
    db_path: str
    max_upload_bytes: int
    max_duration_s: float
    job_timeout_s: float
    lease_seconds: float
    max_attempts: int
    onnx_threads: int
    cors_origins: list[str] = field(default_factory=list)
    app_version: str = "0.1.0"
    api_token: Optional[str] = None  # SMASHLAB_API_TOKEN: when set, every /api/v1 request needs it
    ticket_ttl_s: float = 300.0  # lifetime of an upload ticket

    @classmethod
    def from_env(cls) -> "Settings":
        input_dir = os.environ.get("SMASHLAB_INPUT_DIR", str(REPO_ROOT / "data"))
        outputs_dir = os.environ.get("SMASHLAB_OUTPUTS_DIR", str(REPO_ROOT / "outputs"))
        job_timeout = _env_float("SMASHLAB_JOB_TIMEOUT_S", 1200.0)
        return cls(
            input_dir=input_dir,
            samples_dir=os.environ.get("SMASHLAB_SAMPLES_DIR", os.path.join(input_dir, "samples")),
            samples_manifest=os.environ.get("SMASHLAB_SAMPLES_MANIFEST", os.path.join(input_dir, "samples", "manifest.json")),
            models_dir=os.environ.get("SMASHLAB_MODELS_DIR", str(REPO_ROOT / "models")),
            outputs_dir=outputs_dir,
            db_path=os.environ.get("SMASHLAB_DB_PATH", os.path.join(outputs_dir, "db", "jobs.sqlite")),
            max_upload_bytes=_env_int("SMASHLAB_MAX_UPLOAD_MB", 200) * 1024 * 1024,
            max_duration_s=_env_float("SMASHLAB_MAX_DURATION_S", 120.0),
            job_timeout_s=job_timeout,
            lease_seconds=_env_float("SMASHLAB_LEASE_S", job_timeout + 120.0),
            max_attempts=_env_int("SMASHLAB_MAX_ATTEMPTS", 2),
            onnx_threads=_env_int("SMASHLAB_ONNX_THREADS", 4),
            cors_origins=_env_list("SMASHLAB_CORS_ORIGINS", ["http://localhost:3000", "http://127.0.0.1:3000"]),
            api_token=os.environ.get("SMASHLAB_API_TOKEN") or None,
            ticket_ttl_s=_env_float("SMASHLAB_TICKET_TTL_S", 300.0),
        )
