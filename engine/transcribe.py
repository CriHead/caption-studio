"""CPU transcription with faster-whisper word timestamps (no WhisperX, no token)."""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path

from paths import WHISPER_MODEL, WHISPER_ROOT

_lock = threading.Lock()
_model = None
_model_name = None


def get_model(name: str | None = None):
    """Load the tiny multilingual model once per process from the pre-cached folder."""
    global _model, _model_name
    model_name = name or WHISPER_MODEL
    with _lock:
        if _model is not None and _model_name == model_name:
            return _model
        from faster_whisper import WhisperModel

        kwargs = dict(
            device="cpu",
            compute_type=os.environ.get("WHISPER_COMPUTE_TYPE", "int8"),
            cpu_threads=int(os.environ.get("WHISPER_CPU_THREADS", "2")),
        )
        # Prefer a pre-downloaded copy from the Docker build.
        root = str(WHISPER_ROOT)
        if Path(root).is_dir():
            kwargs["download_root"] = root
        _model = WhisperModel(model_name, **kwargs)
        _model_name = model_name
        return _model


def transcribe_words(audio: Path, dest: Path, lang: str = "auto") -> Path:
    """Write a words.json file compatible with captions_ass.load_words."""
    language = None if (lang in (None, "", "auto")) else lang
    model = get_model()
    segments, info = model.transcribe(
        str(audio),
        language=language,
        beam_size=3,
        vad_filter=False,
        word_timestamps=True,
    )
    word_segments = []
    rows = []
    for seg in segments:
        text = (seg.text or "").strip()
        rows.append({"start": float(seg.start), "end": float(seg.end), "text": text})
        for w in seg.words or []:
            token = (w.word or "").strip()
            if not token or w.start is None or w.end is None:
                continue
            word_segments.append(
                {
                    "word": token,
                    "start": round(float(w.start), 3),
                    "end": round(float(w.end), 3),
                    "score": float(getattr(w, "probability", 0.0) or 0.0),
                }
            )
        # If this segment had no word timings, split the segment text evenly.
        if not (seg.words or []) and text:
            tokens = text.split()
            dur = max(0.08, float(seg.end) - float(seg.start))
            slot = dur / max(1, len(tokens))
            t = float(seg.start)
            for tok in tokens:
                word_segments.append(
                    {
                        "word": tok,
                        "start": round(t, 3),
                        "end": round(min(float(seg.end), t + slot * 0.9), 3),
                        "score": 0.0,
                    }
                )
                t += slot

    detected = getattr(info, "language", None) or language or "unknown"
    dest.write_text(
        json.dumps(
            {"language": detected, "word_segments": word_segments, "segments": rows},
            indent=2,
        ),
        encoding="utf-8",
    )
    return dest
