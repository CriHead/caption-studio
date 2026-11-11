FROM python:3.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    HF_HUB_DISABLE_XET=1 \
    DO_NOT_TRACK=1 \
    OMP_NUM_THREADS=2 \
    MKL_NUM_THREADS=2 \
    WHISPER_MODEL=tiny \
    WHISPER_DOWNLOAD_ROOT=/app/models/faster-whisper \
    CAPTION_STUDIO_ROOT=/app \
    PORT=7860

RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        fontconfig \
        fonts-noto-cjk \
        libsndfile1 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && ffmpeg -hide_banner -filters 2>&1 | grep -q " ass "

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the multilingual Whisper tiny model so the first render is fast.
# This is a public model; no Hugging Face token is required at build or runtime.
RUN mkdir -p /app/models/faster-whisper \
    && python -c "from faster_whisper import WhisperModel; WhisperModel('tiny', device='cpu', compute_type='int8', download_root='/app/models/faster-whisper')"

COPY . /app

RUN useradd --create-home --uid 1000 user \
    && mkdir -p /tmp/caption-studio-jobs /data \
    && chown -R user:user /app /tmp/caption-studio-jobs /data

USER user

EXPOSE 7860
CMD ["sh", "-c", "python app.py --host 0.0.0.0 --port ${PORT:-7860}"]
