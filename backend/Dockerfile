# SmashLab local AI backend: CPU only, no PyTorch in the image.
# Models (ONNX) and sample data are mounted read-only by docker-compose.yml.
# Build context: backend/ (see backend/.dockerignore).
FROM python:3.12-slim

ARG UID=501
ARG GID=20

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
 && FFMPEG_BIN="$(python -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())')" \
 && ln -s "$FFMPEG_BIN" /usr/local/bin/ffmpeg \
 && ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libx264 \
 && ffmpeg -version | head -1

COPY app ./app

# Non-root user. UID/GID default to the usual macOS user so bind-mounted outputs stay writable.
RUN (getent group ${GID} >/dev/null || groupadd -g ${GID} smashlab) \
 && (id -u smashlab >/dev/null 2>&1 || useradd -m -u ${UID} -g ${GID} smashlab) \
 && mkdir -p /data/outputs /data/db /models /data/input \
 && chown -R ${UID}:${GID} /data /app

USER ${UID}:${GID}

ENV SMASHLAB_INPUT_DIR=/data/input \
    SMASHLAB_SAMPLES_DIR=/data/input/samples \
    SMASHLAB_SAMPLES_MANIFEST=/data/input/samples/manifest.json \
    SMASHLAB_MODELS_DIR=/models \
    SMASHLAB_OUTPUTS_DIR=/data/outputs \
    SMASHLAB_DB_PATH=/data/db/jobs.sqlite \
    SMASHLAB_ONNX_THREADS=4 \
    SMASHLAB_JOB_TIMEOUT_S=1200 \
    SMASHLAB_MAX_UPLOAD_MB=200 \
    SMASHLAB_MAX_DURATION_S=120

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=4 \
  CMD python -c "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status == 200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-access-log"]
