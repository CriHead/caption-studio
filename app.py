#!/usr/bin/env python3
"""Caption Studio — phone-friendly Flask app for a Hugging Face Docker Space."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ENGINE = ROOT / "engine"
if str(ENGINE) not in sys.path:
    sys.path.insert(0, str(ENGINE))
os.environ.setdefault("CAPTION_STUDIO_ROOT", str(ROOT))

from flask import (  # noqa: E402
    Flask,
    abort,
    jsonify,
    render_template,
    request,
    send_file,
    send_from_directory,
    url_for,
)

from paths import JOBS, link_cjk_font  # noqa: E402
from styles import (  # noqa: E402
    ANIMATIONS,
    DEFAULT_PALETTE,
    DEFAULT_STYLE,
    PLACEMENTS,
    STYLES,
    get_language,
    list_animations,
    list_languages,
    list_palettes,
    list_placements,
    list_styles,
    resolve_palette,
)

link_cjk_font()

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"}
AUDIO_EXTS = {".wav", ".mp3", ".m4a", ".aac", ".ogg", ".flac"}
MAX_UPLOAD = 50 * 1024 * 1024
MAX_SECONDS = 60
JOB_TTL_SECONDS = 15 * 60
AFTER_DOWNLOAD_SECONDS = 2 * 60
PREVIEWS = ROOT / "static" / "previews"
AUTO_EDIT = ENGINE / "auto_edit.py"

app = Flask(__name__, template_folder=str(ROOT / "templates"), static_folder=str(ROOT / "static"))
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD

_jobs: dict[str, dict] = {}
_lock = threading.Lock()
_pool = threading.Semaphore(1)


def _safe_name(name: str, fallback: str) -> str:
    raw = Path(name or "").name
    keep = "".join(ch if ch.isalnum() or ch in "._- " else "_" for ch in raw).strip()
    return keep or fallback


def _job_dir(job_id: str) -> Path:
    path = JOBS / job_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def _public_job(job: dict) -> dict:
    return {
        "id": job["id"],
        "status": job["status"],
        "progress": job["progress"],
        "message": job["message"],
        "error": job.get("error"),
        "download": url_for("job_video", job_id=job["id"]) if job["status"] == "done" else None,
        "filename": job.get("filename") or "captioned.mp4",
    }


def _update(job_id: str, **fields) -> None:
    with _lock:
        if job_id in _jobs:
            _jobs[job_id].update(fields)


def _rm_tree(path: Path) -> None:
    try:
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
        elif path.is_file() or path.is_symlink():
            path.unlink(missing_ok=True)
    except OSError:
        pass


def _cleanup_work_files(work: Path, keep: Path | None = None) -> None:
    """Delete uploads and intermediates; optionally keep the finished MP4."""
    keep_res = keep.resolve() if keep is not None else None
    for child in list(work.iterdir()) if work.is_dir() else []:
        if keep_res is not None and child.resolve() == keep_res:
            continue
        _rm_tree(child)


def _forget_job(job_id: str) -> None:
    with _lock:
        job = _jobs.pop(job_id, None)
    if job and job.get("dir"):
        _rm_tree(Path(job["dir"]))


def _schedule_delete(job_id: str, delay: float) -> None:
    def _later() -> None:
        time.sleep(delay)
        _forget_job(job_id)

    threading.Thread(target=_later, daemon=True).start()


def _janitor_loop() -> None:
    while True:
        time.sleep(60)
        now = time.time()
        stale = []
        with _lock:
            for job_id, job in list(_jobs.items()):
                created = float(job.get("created") or now)
                if now - created > JOB_TTL_SECONDS:
                    stale.append(job_id)
        for job_id in stale:
            _forget_job(job_id)


def _probe_duration(path: Path) -> float:
    try:
        proc = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        return float((proc.stdout or "0").strip() or 0.0)
    except (ValueError, OSError):
        return 0.0


def _run_job(job_id: str) -> None:
    with _lock:
        job = dict(_jobs[job_id])
    work = Path(job["dir"])
    output = work / "captioned.mp4"
    cmd = [
        sys.executable,
        str(AUTO_EDIT),
        str(job["input"]),
        str(output),
        "--style",
        job["style"],
        "--placement",
        job.get("placement") or "auto",
        "--motion-strength",
        "medium",
        "--lang",
        job.get("lang") or "auto",
        "--work-dir",
        str(work / "work"),
        "--fonts-dir",
        str(ROOT / "fonts"),
    ]
    if job.get("color"):
        cmd += ["--color", job["color"]]
    if job.get("vertical"):
        cmd.append("--vertical")
    if job.get("text"):
        cmd += ["--text", job["text"]]
    if job.get("audio"):
        cmd += ["--audio", job["audio"]]
    if job.get("duration"):
        cmd += ["--duration", str(job["duration"])]
    if job.get("animation"):
        cmd += ["--animation", job["animation"]]
    if job.get("cta"):
        cmd += ["--cta", job["cta"]]
    if job.get("emoji") == "auto":
        cmd += ["--emoji", "auto"]
    if job.get("letterbox"):
        cmd.append("--letterbox")
    env = os.environ.copy()
    env["CAPTION_STUDIO_ROOT"] = str(ROOT)
    env["CAPTION_STUDIO_MAX_SECONDS"] = str(MAX_SECONDS)
    env["PYTHONPATH"] = str(ENGINE) + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    env.setdefault("OMP_NUM_THREADS", "2")
    env.setdefault("MKL_NUM_THREADS", "2")
    try:
        _update(job_id, status="running", progress=15, message="Making your video…")
        with _pool:
            proc = subprocess.run(cmd, capture_output=True, text=True, env=env)
        if proc.returncode != 0:
            err = (proc.stderr or proc.stdout or "Render failed").strip()
            _update(job_id, status="error", progress=100, message="Something went wrong.", error=err[-1200:])
            _cleanup_work_files(work)
            _schedule_delete(job_id, AFTER_DOWNLOAD_SECONDS)
            return
        if not output.is_file() or output.stat().st_size < 1000:
            _update(job_id, status="error", progress=100, message="The video could not be saved.", error=(proc.stderr or "")[-800:])
            _cleanup_work_files(work)
            _schedule_delete(job_id, AFTER_DOWNLOAD_SECONDS)
            return
        # Keep only the finished file. Uploads and work files are deleted here.
        _cleanup_work_files(work, keep=output)
        _update(job_id, status="done", progress=100, message="Ready to save.", output=str(output))
    except Exception as exc:
        _update(job_id, status="error", progress=100, message="Something went wrong.", error=str(exc))
        _cleanup_work_files(work)
        _schedule_delete(job_id, AFTER_DOWNLOAD_SECONDS)


@app.get("/")
def index():
    return render_template(
        "index.html",
        styles=list_styles(),
        palettes=list_palettes(),
        animations=list_animations(),
        languages=list_languages(),
        placements=list_placements(),
        default_style=DEFAULT_STYLE,
        default_palette=DEFAULT_PALETTE,
        max_mb=MAX_UPLOAD // (1024 * 1024),
        max_seconds=MAX_SECONDS,
    )


@app.get("/health")
def health():
    return jsonify({"ok": True, "name": "Caption Studio"})


@app.get("/api/styles")
def api_styles():
    return jsonify({"styles": list_styles(), "default": DEFAULT_STYLE})


@app.get("/api/palettes")
def api_palettes():
    return jsonify({"palettes": list_palettes(), "default": DEFAULT_PALETTE})


@app.get("/api/animations")
def api_animations():
    return jsonify({"animations": list_animations()})


@app.get("/api/languages")
def api_languages():
    return jsonify({"languages": list_languages(), "default": "auto"})


@app.get("/api/placements")
def api_placements():
    return jsonify({"placements": list_placements(), "default": "auto"})


@app.get("/previews/<name>")
def preview_file(name: str):
    safe = Path(name).name
    path = PREVIEWS / safe
    if not path.is_file():
        abort(404)
    return send_from_directory(PREVIEWS, safe)


@app.post("/api/render")
def api_render():
    uploaded = request.files.get("file") or request.files.get("video") or request.files.get("image")
    if uploaded is None or not uploaded.filename:
        return jsonify({"error": "Please upload a video or an image."}), 400
    suffix = Path(uploaded.filename).suffix.lower()
    if suffix not in IMAGE_EXTS | VIDEO_EXTS:
        return jsonify({"error": "Please upload a video (mp4, mov, webm) or an image (png, jpg, webp)."}), 400

    style = (request.form.get("style") or DEFAULT_STYLE).strip().lower()
    if style not in STYLES:
        return jsonify({"error": f"Unknown style. Choose one of: {', '.join(STYLES)}"}), 400
    color = (request.form.get("color") or "").strip()
    if color:
        try:
            resolve_palette(color)
        except SystemExit as exc:
            return jsonify({"error": str(exc)}), 400
    text = (request.form.get("text") or "").strip()
    vertical = str(request.form.get("vertical") or "").lower() in {"1", "true", "yes", "on", "vertical"}
    animation = (request.form.get("animation") or "").strip().lower()
    if animation in {"", "auto", "default"}:
        animation = None
    elif animation not in ANIMATIONS:
        return jsonify({"error": f"Unknown animation. Choose one of: {', '.join(ANIMATIONS)}"}), 400
    placement = (request.form.get("placement") or "auto").strip().lower()
    if placement not in PLACEMENTS:
        return jsonify({"error": f"Unknown placement. Choose one of: {', '.join(PLACEMENTS)}"}), 400
    try:
        lang = get_language(request.form.get("lang") or "auto")
    except SystemExit as exc:
        return jsonify({"error": str(exc)}), 400
    cta = (request.form.get("cta") or "").strip() or None
    emoji = "auto" if str(request.form.get("emoji") or "").lower() in {"1", "true", "yes", "on", "auto"} else "off"
    letterbox = str(request.form.get("letterbox") or "").lower() in {"1", "true", "yes", "on"}
    duration_raw = request.form.get("duration") or ""
    duration = None
    if duration_raw:
        try:
            duration = max(1.0, min(float(MAX_SECONDS), float(duration_raw)))
        except ValueError:
            return jsonify({"error": "Duration must be a number of seconds."}), 400

    if suffix in IMAGE_EXTS and not text and "audio" not in request.files:
        return jsonify({"error": "For an image, add a short caption in the text box (or attach a voice track)."}), 400

    job_id = uuid.uuid4().hex[:12]
    work = _job_dir(job_id)
    in_path = work / _safe_name(uploaded.filename, f"input{suffix}")
    uploaded.save(in_path)
    if in_path.stat().st_size > MAX_UPLOAD:
        _rm_tree(work)
        return jsonify({"error": f"Please keep files to {MAX_UPLOAD // (1024 * 1024)} MB or less."}), 400

    if suffix in VIDEO_EXTS:
        length = _probe_duration(in_path)
        if length > MAX_SECONDS + 0.25:
            _rm_tree(work)
            return jsonify({"error": f"Please keep videos to {MAX_SECONDS} seconds or less (this one is {length:.0f}s)."}), 400

    audio_path = None
    audio = request.files.get("audio")
    if audio and audio.filename:
        asuf = Path(audio.filename).suffix.lower()
        if asuf not in AUDIO_EXTS:
            _rm_tree(work)
            return jsonify({"error": "Optional audio should be wav, mp3, m4a, or aac."}), 400
        audio_path = work / _safe_name(audio.filename, f"voice{asuf}")
        audio.save(audio_path)
        if audio_path.stat().st_size + in_path.stat().st_size > MAX_UPLOAD:
            _rm_tree(work)
            return jsonify({"error": f"Please keep files to {MAX_UPLOAD // (1024 * 1024)} MB or less."}), 400

    # Photos default to a short clip so free-CPU renders stay quick.
    if suffix in IMAGE_EXTS and duration is None:
        duration = 6.0

    job = {
        "id": job_id,
        "status": "queued",
        "progress": 5,
        "message": "Queued…",
        "error": None,
        "dir": str(work),
        "input": str(in_path),
        "audio": str(audio_path) if audio_path else None,
        "style": style,
        "color": color or None,
        "text": text or None,
        "vertical": vertical,
        "duration": duration,
        "animation": animation,
        "placement": placement,
        "lang": lang,
        "cta": cta,
        "emoji": emoji,
        "letterbox": letterbox,
        "filename": "captioned.mp4",
        "output": None,
        "created": time.time(),
    }
    with _lock:
        _jobs[job_id] = job
    threading.Thread(target=_run_job, args=(job_id,), daemon=True).start()
    return jsonify(_public_job(job))


@app.get("/api/jobs/<job_id>")
def job_status(job_id: str):
    with _lock:
        job = _jobs.get(job_id)
    if not job:
        abort(404)
    return jsonify(_public_job(job))


@app.get("/api/jobs/<job_id>/video")
def job_video(job_id: str):
    with _lock:
        job = _jobs.get(job_id)
    if not job or job["status"] != "done" or not job.get("output"):
        abort(404)
    path = Path(job["output"])
    if not path.is_file():
        abort(404)
    # Client has the file (or is about to); drop the leftover shortly after.
    _schedule_delete(job_id, AFTER_DOWNLOAD_SECONDS)
    return send_file(path, mimetype="video/mp4", as_attachment=True, download_name=job.get("filename") or "captioned.mp4")


@app.errorhandler(413)
def too_large(_err):
    return jsonify({"error": f"Please keep files to {MAX_UPLOAD // (1024 * 1024)} MB or less."}), 413


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Caption Studio (Hugging Face Space).")
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=int(os.environ.get("PORT", "7860")))
    args = p.parse_args(argv)
    JOBS.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=_janitor_loop, daemon=True).start()
    print(f"Caption Studio → http://127.0.0.1:{args.port}/  (bound on {args.host})")
    app.run(host=args.host, port=args.port, threaded=True, use_reloader=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
