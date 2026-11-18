"""FastAPI application: local AI analysis service for SmashLab.

Run locally:  uvicorn app.main:app --host 127.0.0.1 --port 8000
The Docker image runs the same app with one worker process (the job worker is a thread).
"""

from __future__ import annotations

import logging
import os
import shutil
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.routes import router
from app.config import Settings
from app.services.access import AccessDenied, UploadTicketStore, authorize
from app.services.store import SqliteStore
from app.services.worker import AnalysisWorker

logging.basicConfig(level=os.environ.get("SMASHLAB_LOG_LEVEL", "INFO"))


def _error_body(code: str, message: str) -> dict:
    return {"error": {"code": code, "message": message}}


def create_app(settings: Settings | None = None, start_worker: bool = True) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        os.makedirs(settings.outputs_dir, exist_ok=True)
        store = SqliteStore(settings.db_path)
        app.state.settings = settings
        app.state.store = store
        worker = AnalysisWorker(store, store, settings)
        app.state.worker = worker
        app.state.upload_tickets = UploadTicketStore(settings.api_token) if settings.api_token else None
        # Jobs that a previous process left running go back to the queue now, not when their lease expires.
        interrupted = store.requeue_interrupted()
        if interrupted:
            logging.getLogger("smashlab.api").warning("re-queued %d job(s) that a restart interrupted", interrupted)
        if start_worker:
            worker.start()
        yield
        worker.stop()
        if worker.is_alive():
            worker.join(timeout=10)
        store.close()

    app = FastAPI(title="SmashLab local AI API", version=settings.app_version, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "Range", "Authorization", "X-SmashLab-Upload-Ticket"],
        expose_headers=["Content-Range", "Accept-Ranges", "Content-Length"],
        allow_credentials=False,
    )

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_: Request, exc: StarletteHTTPException):
        if isinstance(exc.detail, dict) and "code" in exc.detail:
            body = _error_body(exc.detail["code"], exc.detail.get("message", ""))
        else:
            body = _error_body("http_error", str(exc.detail))
        return JSONResponse(body, status_code=exc.status_code, headers=getattr(exc, "headers", None))

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError):
        return JSONResponse(_error_body("invalid_request", "The request body or parameters are invalid."), status_code=422)

    @app.get("/health")
    async def health(request: Request):
        state = request.app.state
        checks: dict = {"database": "ok"}
        try:
            state.store.ping()
        except Exception as exc:  # pragma: no cover - defensive
            checks["database"] = f"error: {type(exc).__name__}"
        models_dir = settings.models_dir
        model_files = {
            "tracknetv3": os.path.isfile(os.path.join(models_dir, "tracknetv3", "tracknetv3_tracknet.onnx")),
            "inpaintnet": os.path.isfile(os.path.join(models_dir, "tracknetv3", "tracknetv3_inpaintnet.onnx")),
            "yolox": os.path.isfile(os.path.join(models_dir, "yolox", "object_detection_yolox_2022nov.onnx")),
        }
        worker = state.worker
        ready = checks["database"] == "ok" and model_files["tracknetv3"] and model_files["yolox"]
        status = "ok" if ready else "degraded"
        try:
            authorize(request.headers, settings.api_token, None)
        except AccessDenied:
            # Without credentials only the overall status is shown; models, jobs and paths stay private.
            return {"status": status}
        return {
            "status": status,
            "version": settings.app_version,
            "checks": checks,
            "ffmpeg": shutil.which("ffmpeg") is not None,
            "models": model_files,
            "worker": {"alive": bool(worker and worker.is_alive()), "processed": worker.processed if worker else 0},
            "queue_depth": state.store.queue_depth(),
            "jobs": state.store.counts(),
            "limits": {
                "max_upload_mb": settings.max_upload_bytes // (1024 * 1024),
                "max_duration_s": settings.max_duration_s,
                "job_timeout_s": settings.job_timeout_s,
            },
        }

    app.include_router(router)
    return app


app = create_app()
