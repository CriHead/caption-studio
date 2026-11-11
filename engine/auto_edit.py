#!/usr/bin/env python3
"""Auto-caption + auto-effects renderer (original workflow, 720p)."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from captions_ass import group_words, load_words, write_ass  # noqa: E402
from effects import camera_filter, mark_emphasis, plan_effects  # noqa: E402
from placement import detect_subjects, plan_placements, read_cover_frames  # noqa: E402
from styles import (  # noqa: E402
    ANIMATIONS,
    DEFAULT_STYLE,
    LANGUAGES,
    MOTIONS,
    PALETTES,
    PLACEMENTS,
    STRENGTHS,
    STYLES,
    all_font_files,
    apply_color,
    get_animation,
    get_language,
    get_motion,
    get_placement,
    get_strength,
    get_style,
    script_font_files,
)
from emoji import burst_overlays, tag_words  # noqa: E402

from paths import FONTS as DEFAULT_FONTS, ROOT as SPACE_ROOT, link_cjk_font  # noqa: E402

link_cjk_font()
LANDSCAPE = (1280, 720)
VERTICAL = (720, 1280)
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
DEFAULT_STILL_SECONDS = 8.0


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, **kwargs)


def probe(path: Path) -> dict:
    proc = run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type,width,height,sample_rate",
            "-of",
            "json",
            str(path),
        ],
        capture_output=True,
        text=True,
    )
    data = json.loads(proc.stdout)
    duration = float((data.get("format") or {}).get("duration") or 0.0)
    width = height = 0
    has_audio = False
    for stream in data.get("streams") or []:
        if stream.get("codec_type") == "video" and not width:
            width = int(stream.get("width") or 0)
            height = int(stream.get("height") or 0)
            if stream.get("duration"):
                duration = max(duration, float(stream["duration"]))
        if stream.get("codec_type") == "audio":
            has_audio = True
            if stream.get("duration"):
                duration = max(duration, float(stream["duration"]))
    return {"duration": duration, "width": width, "height": height, "has_audio": has_audio}


def is_image(path: Path) -> bool:
    return path.suffix.lower() in IMAGE_EXTS


def audio_duration(path: Path) -> float:
    return max(0.0, float(probe(path).get("duration") or 0.0))


def words_from_text(text: str, duration: float) -> list[dict]:
    """Spread manual caption text evenly across the clip."""
    tokens = [tok for tok in (text or "").replace("\n", " ").split() if tok]
    if not tokens:
        raise SystemExit("No words found in --text. Add a short caption.")
    duration = max(1.0, float(duration))
    lead, tail = 0.15, 0.25
    usable = max(0.8, duration - lead - tail)
    slot = usable / len(tokens)
    hold = max(0.22, slot * 0.86)
    fillers = {
        "a", "an", "the", "and", "or", "but", "to", "of", "in", "on", "for",
        "with", "at", "from", "is", "are", "was", "be", "it", "this", "that",
        "as", "by", "we", "you", "i",
    }
    words = []
    t = lead
    for tok in tokens:
        start = t
        end = min(duration - 0.04, t + hold)
        if end <= start:
            end = start + 0.18
        bare = tok.strip(".,!?;:\"'").lower()
        words.append(
            {
                "text": tok,
                "start": round(start, 3),
                "end": round(end, 3),
                "score": 1.0,
                "emphasized": len(bare) >= 5 and bare not in fillers,
            }
        )
        t += slot
    return words


def write_words_json(path: Path, words: list[dict]) -> Path:
    path.write_text(json.dumps(words, indent=2), encoding="utf-8")
    return path


def still_to_video(image: Path, dest: Path, audio: Path | None, duration: float, out_w: int, out_h: int) -> Path:
    """Make a 30 fps 720p clip from a still. Ken Burns is applied later in the effects pass."""
    duration = max(1.0, float(duration))
    vf = (
        f"scale={out_w}:{out_h}:force_original_aspect_ratio=increase:flags=bicubic,"
        f"crop={out_w}:{out_h},setsar=1,fps=30,format=yuv420p"
    )
    cmd = [
        "ffmpeg", "-hide_banner", "-y",
        "-loop", "1", "-framerate", "30", "-i", str(image),
    ]
    if audio is not None:
        cmd += ["-i", str(audio)]
    else:
        cmd += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
    cmd += [
        "-t", f"{duration:.3f}",
        "-vf", vf,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000",
        "-shortest",
        "-movflags", "+faststart",
        "-threads", "2",
        str(dest),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr[-3000:] if proc.stderr else "ffmpeg still-to-video failed\n")
        raise SystemExit(f"Could not turn the image into a video (ffmpeg exit {proc.returncode}).")
    return dest


def mux_external_audio(video: Path, audio: Path, dest: Path) -> Path:
    cmd = [
        "ffmpeg", "-hide_banner", "-y",
        "-i", str(video), "-i", str(audio),
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000",
        "-shortest",
        str(dest),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr[-3000:] if proc.stderr else "ffmpeg mux failed\n")
        raise SystemExit(f"Could not attach the audio file (ffmpeg exit {proc.returncode}).")
    return dest


def extract_audio(src: Path, dest: Path) -> Path:
    run(
        [
            "ffmpeg",
            "-hide_banner",
            "-y",
            "-i",
            str(src),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(dest),
        ],
        capture_output=True,
        text=True,
    )
    return dest


def transcribe(audio: Path, work: Path, lang: str = "auto") -> Path:
    from transcribe import transcribe_words

    words = work / "words.json"
    transcribe_words(audio, words, lang=lang or "auto")
    return words


def stage_fonts(style: dict, fonts_root: Path, dest: Path, extra: list[str] | None = None) -> Path:
    dest.mkdir(parents=True, exist_ok=True)
    rels = list(all_font_files(style))
    for rel in extra or []:
        if rel not in rels:
            rels.append(rel)
    for rel in rels:
        src = fonts_root / rel
        if not src.is_file() and not src.is_symlink():
            # Script fallbacks are optional so a missing CJK/Arabic file does not block Latin work.
            if extra and rel in extra and rel not in all_font_files(style):
                continue
            raise SystemExit(f"Missing font file {src}. Install OFL/Apache fonts under {fonts_root}.")
        target = dest / src.name
        if target.exists() or target.is_symlink():
            target.unlink()
        target.symlink_to(src.resolve())
    return dest


def write_fontconfig(work: Path, fontsdir: Path) -> Path:
    """Use only the staged OFL/Apache fonts so system families cannot win."""
    cache = work / "fc-cache"
    cache.mkdir(parents=True, exist_ok=True)
    conf = work / "fonts.conf"
    conf.write_text(
        "<?xml version=\"1.0\"?>\n"
        "<!DOCTYPE fontconfig SYSTEM \"urn:fontconfig:fonts.dtd\">\n"
        "<fontconfig>\n"
        f"  <dir>{fontsdir}</dir>\n"
        f"  <cachedir>{cache}</cachedir>\n"
        "  <match target=\"pattern\">\n"
        "    <edit name=\"antialias\" mode=\"assign\"><bool>true</bool></edit>\n"
        "    <edit name=\"hinting\" mode=\"assign\"><bool>true</bool></edit>\n"
        "    <edit name=\"hintstyle\" mode=\"assign\"><const>hintslight</const></edit>\n"
        "    <edit name=\"rgba\" mode=\"assign\"><const>rgb</const></edit>\n"
        "  </match>\n"
        "</fontconfig>\n",
        encoding="utf-8",
    )
    return conf


def cover_crop_filter(src_w: int, src_h: int, out_w: int, out_h: int) -> str:
    return (
        f"scale={out_w}:{out_h}:force_original_aspect_ratio=increase:flags=bicubic,"
        f"crop={out_w}:{out_h},setsar=1,fps=30,format=yuv420p"
    )


def letterbox_filters(out_w: int, out_h: int) -> list[str]:
    # ~2.35:1 bars that stay fixed after the camera move.
    picture = int(round(out_w / 2.35))
    bar = max(56, (out_h - picture) // 2)
    bar = min(bar, out_h // 5)
    return [
        f"drawbox=x=0:y=0:w={out_w}:h={bar}:color=black:t=fill",
        f"drawbox=x=0:y={out_h - bar}:w={out_w}:h={bar}:color=black:t=fill",
    ]


def _ff_path(path: str | Path) -> str:
    return str(Path(path).resolve()).replace("\\", "\\\\").replace(":", r"\:").replace("'", r"\'")


def _overlay_graph(overlays: list[dict], base_label: str) -> tuple[str, str]:
    """Append scale/fade/overlay filters for looped image inputs 1..N. Returns (filter, last_label)."""
    parts: list[str] = []
    current = base_label
    for i, ov in enumerate(overlays):
        size = int(ov.get("size") or 48)
        start = float(ov.get("start") or 0.0)
        end = float(ov.get("end") or (start + 0.9))
        dur = max(0.08, end - start)
        fade_out = min(0.22, dur * 0.35)
        fade_in = min(0.10, dur * 0.2)
        x = int(ov.get("x") or 0)
        y = int(ov.get("y") or 0)
        x2 = int(ov.get("x2") if ov.get("x2") is not None else x)
        y2 = int(ov.get("y2") if ov.get("y2") is not None else y)
        em = f"e{i}"
        nxt = f"v{i}"
        inp = i + 1  # 0 is the source video
        parts.append(
            f"[{inp}:v]scale={size}:{size}:flags=lanczos,format=rgba,"
            f"fade=t=in:st={start:.3f}:d={fade_in:.3f}:alpha=1,"
            f"fade=t=out:st={end - fade_out:.3f}:d={fade_out:.3f}:alpha=1[{em}]"
        )
        # Keep expressions comma-free so they are safe in a filtergraph.
        xexpr = f"{x}+({x2}-{x})*(t-{start})/{dur}"
        yexpr = f"{y}+({y2}-{y})*(t-{start})/{dur}"
        parts.append(
            f"[{current}][{em}]overlay=x='{xexpr}':y='{yexpr}':format=auto:"
            f"enable='between(t,{start:.3f},{end:.3f})'[{nxt}]"
        )
        current = nxt
    return ";".join(parts), current


def render(
    src: Path,
    dest: Path,
    ass_path: Path,
    fontsdir: Path,
    effects_vf: str | None,
    out_w: int,
    out_h: int,
    src_w: int,
    src_h: int,
    fontconfig: Path | None = None,
    letterbox: bool = False,
    overlays: list[dict] | None = None,
    duration: float | None = None,
) -> None:
    vf_parts = [cover_crop_filter(src_w, src_h, out_w, out_h)]
    if effects_vf:
        vf_parts.append(effects_vf)
    if letterbox:
        vf_parts.extend(letterbox_filters(out_w, out_h))
    ass = _ff_path(ass_path)
    fonts = _ff_path(fontsdir)
    vf_parts.append(f"ass=filename={ass}:fontsdir={fonts}")
    overlays = list(overlays or [])
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-y",
        "-i",
        str(src),
    ]
    if overlays:
        clip_d = float(duration) if duration and duration > 0 else 8.0
        for ov in overlays:
            cmd += ["-loop", "1", "-t", f"{clip_d:.3f}", "-i", str(ov["path"])]
        chain = ",".join(vf_parts)
        graph, last = _overlay_graph(overlays, "base")
        filter_complex = f"[0:v]{chain}[base];{graph}"
        cmd += [
            "-filter_complex",
            filter_complex,
            "-map",
            f"[{last}]",
            "-map",
            "0:a?",
        ]
    else:
        cmd += ["-vf", ",".join(vf_parts)]
    cmd += [
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ac",
        "2",
        "-ar",
        "48000",
        "-movflags",
        "+faststart",
        "-threads",
        "2",
    ]
    if duration and duration > 0:
        cmd += ["-t", f"{float(duration):.3f}"]
    cmd.append(str(dest))
    env = os.environ.copy()
    if fontconfig is not None:
        env["FONTCONFIG_FILE"] = str(fontconfig)
        env["FONTCONFIG_PATH"] = str(Path(fontconfig).parent)
    proc = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr[-4000:] if proc.stderr else "ffmpeg failed\n")
        raise SystemExit(f"ffmpeg failed with exit {proc.returncode}")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    styles = ", ".join(STYLES)
    anims = ", ".join(ANIMATIONS)
    motions = ", ".join(MOTIONS)
    strengths = ", ".join(STRENGTHS)
    places = ", ".join(PLACEMENTS)
    palettes = ", ".join(PALETTES)
    langs = ", ".join(LANGUAGES)
    p = argparse.ArgumentParser(
        description="Burn auto captions and original auto effects into a 720p MP4."
    )
    p.add_argument("input", help="Source video or still image")
    p.add_argument("output", help="Output MP4 path")
    p.add_argument("--style", default=DEFAULT_STYLE, help=f"Caption preset: {styles} (default: {DEFAULT_STYLE})")
    p.add_argument(
        "--animation",
        default=None,
        help=f"Caption animation: {anims}. Default is the style's own animation.",
    )
    p.add_argument(
        "--motion",
        default=None,
        help=f"Continuous caption motion: {motions}. Default is the style's own motion (smooth float). Use none to freeze captions after entry.",
    )
    p.add_argument(
        "--motion-strength",
        default="medium",
        help=f"How strong Ken Burns + caption motion are: {strengths} (default: medium, clearly visible).",
    )
    p.add_argument(
        "--placement",
        default="auto",
        help=f"Caption placement: {places}. auto follows a locally detected subject (face/motion/saliency) and stays in the safe margin.",
    )
    p.add_argument(
        "--color",
        default=None,
        help=f"Caption palette: {palettes}, or a hex like #C9A36A. Leave off to keep the style's own colors.",
    )
    p.add_argument("--audio", type=Path, default=None, help="Optional soundtrack. For a still image, also sets the video length.")
    p.add_argument("--text", default=None, help="Manual caption text (timed evenly). For images this can replace transcription.")
    p.add_argument("--duration", type=float, default=None, help="Length in seconds for a still-image clip when no --audio is given (default: 8).")
    p.add_argument("--no-effects", action="store_true", help="Captions only; skip Ken Burns, punch-in, flash, and beat-sync")
    p.add_argument("--vertical", action="store_true", help="Centre-crop to 9:16 at 720x1280")
    p.add_argument("--words-per-line", type=int, default=None, help="Words shown together (1-3). Default comes from the style (usually 2, 1 for hormozi).")
    p.add_argument("--beat-sync", action=argparse.BooleanOptionalAction, default=True, help="Beat-synced zooms from audio onsets (default: on, unless --no-effects)")
    p.add_argument("--cta", default=None, help='Optional call-to-action, e.g. "Shop now". Draws a button and a click/ripple near the matching word, or near the end.')
    p.add_argument(
        "--emoji",
        default="off",
        choices=("off", "auto"),
        help="off (default) or auto: keyword emoji plus a short burst as PNG overlays (Noto Color Emoji, OFL).",
    )
    p.add_argument(
        "--lang",
        default="auto",
        help=f"Speech language for transcription: {langs}. auto detects. Also stages Noto script fallback fonts.",
    )
    p.add_argument("--letterbox", action="store_true", help="Draw cinematic letterbox bars (also on by default for the cinematic style).")
    p.add_argument("--words", type=Path, default=None, help="Existing word-times JSON; skip transcription")
    p.add_argument("--fonts-dir", type=Path, default=DEFAULT_FONTS, help="Root folder of OFL/Apache font families")
    p.add_argument("--work-dir", type=Path, default=None, help="Work directory (created if needed)")
    p.add_argument("--keep-work", action="store_true", help="Do not delete the work directory")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    src = Path(args.input).expanduser().resolve()
    dest = Path(args.output).expanduser().resolve()
    if not src.is_file():
        raise SystemExit(f"Input not found: {src}")
    dest.parent.mkdir(parents=True, exist_ok=True)

    style = apply_color(get_style(args.style), args.color)
    animation = get_animation(args.animation, style)
    motion = get_motion(args.motion, style)
    strength = get_strength(args.motion_strength)
    placement = get_placement(args.placement)
    lang = get_language(getattr(args, "lang", None))
    letterbox = bool(args.letterbox or style.get("letterbox"))
    # Lyrics/karaoke sit centered unless the user picked a specific zone.
    if (
        (args.placement in (None, "auto"))
        and (style.get("default_placement") == "center" or animation == "karaoke" or style.get("karaoke"))
    ):
        placement = "center"
    emoji_mode = (args.emoji or "off").strip().lower()
    cta_text = (args.cta or "").strip() or None
    words_per_line = max(1, int(args.words_per_line if args.words_per_line is not None else style.get("words_per_line") or 2))
    out_w, out_h = VERTICAL if args.vertical else LANDSCAPE
    color_name = (args.color or "").strip() or "default"
    ext_audio = Path(args.audio).expanduser().resolve() if args.audio else None
    if ext_audio is not None and not ext_audio.is_file():
        raise SystemExit(f"Audio file not found: {ext_audio}")

    tmp: tempfile.TemporaryDirectory | None = None
    if args.work_dir:
        work = Path(args.work_dir).expanduser().resolve()
        work.mkdir(parents=True, exist_ok=True)
    else:
        tmp = tempfile.TemporaryDirectory(prefix="auto-edit-")
        work = Path(tmp.name)

    try:
        still = is_image(src)
        if still:
            if ext_audio is not None:
                duration = audio_duration(ext_audio) or DEFAULT_STILL_SECONDS
            elif args.duration:
                duration = max(1.0, float(args.duration))
            else:
                duration = DEFAULT_STILL_SECONDS
            src = still_to_video(src, work / "source-from-image.mp4", ext_audio, duration, out_w, out_h)
            info = probe(src)
        else:
            info = probe(src)
            if ext_audio is not None:
                src = mux_external_audio(src, ext_audio, work / "source-muxed.mp4")
                info = probe(src)
        if info["duration"] <= 0.05:
            raise SystemExit("Input duration is too short.")
        max_seconds = float(os.environ.get("CAPTION_STUDIO_MAX_SECONDS", "60"))
        if info["duration"] > max_seconds + 0.25:
            raise SystemExit(
                f"Please keep videos to {int(max_seconds)} seconds or less "
                f"(this one is {info['duration']:.1f}s)."
            )
        if not info["has_audio"]:
            silent = work / "source-silent.mp4"
            run(
                [
                    "ffmpeg", "-hide_banner", "-y", "-i", str(src),
                    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
                    "-shortest", "-c:v", "copy", "-c:a", "aac", "-ar", "48000", "-ac", "2",
                    str(silent),
                ],
                capture_output=True,
                text=True,
            )
            src = silent
            info = probe(src)

        audio = extract_audio(src, work / "audio.wav")
        if args.words:
            words_path = Path(args.words).expanduser().resolve()
            if not words_path.is_file():
                raise SystemExit(f"Word-times JSON not found: {words_path}")
            shutil.copy2(words_path, work / "words.json")
            words = load_words(work / "words.json")
        elif args.text and str(args.text).strip():
            words = words_from_text(args.text, info["duration"])
            write_words_json(work / "words.json", words)
        else:
            if still and ext_audio is None:
                raise SystemExit("A still image needs --text (manual caption) or --audio (speech to transcribe).")
            try:
                words_path = transcribe(audio, work, lang=lang)
                words = load_words(words_path)
            except Exception as exc:
                raise SystemExit(f"Could not transcribe speech. For a still image, pass --text instead. ({exc})") from exc
        if not words:
            raise SystemExit("No word timestamps were produced. Check the speech audio or --text, then retry.")
        # Leave a quiet beat at the end so a CTA button is not covered by the last caption.
        if cta_text and info["duration"] > 6.0:
            last = max(float(w["end"]) for w in words)
            reserve = 3.0
            limit = info["duration"] - reserve
            if last > limit and last > 0.05:
                scale = limit / last
                for w in words:
                    w["start"] = round(float(w["start"]) * scale, 3)
                    w["end"] = round(float(w["end"]) * scale, 3)
        try:
            mark_emphasis(words, audio)
        except Exception:
            pass
        overlays: list[dict] = []
        if emoji_mode == "auto":
            tag_words(words)
            overlays = burst_overlays(words, out_w, out_h)
            (work / "emoji-overlays.json").write_text(json.dumps(overlays, indent=2), encoding="utf-8")

        plan = None
        effects_vf = None
        if not args.no_effects:
            plan = plan_effects(
                words,
                audio,
                src,
                duration=info["duration"],
                beat_sync=bool(args.beat_sync),
                motion_strength=strength,
            )
            (work / "effects-plan.json").write_text(json.dumps(plan, indent=2), encoding="utf-8")
            effects_vf = camera_filter(plan, out_w, out_h)

        groups = group_words(words, words_per_line)
        detections = []
        try:
            duration = float(info["duration"] or 8.0)
            fps = min(5.0, max(1.0, 24.0 / max(1.0, duration)))
            frames, times = read_cover_frames(src, out_w, out_h, fps=fps)
            detections = detect_subjects(frames, times)
            (work / "placement-detections.json").write_text(
                json.dumps([{**d, "bbox": list(d["bbox"])} for d in detections], indent=2),
                encoding="utf-8",
            )
        except Exception as exc:
            (work / "placement-error.txt").write_text(str(exc), encoding="utf-8")
            detections = []
        fontsize = int(style["fontsize_vertical"] if args.vertical else style["fontsize_landscape"])
        placements = plan_placements(
            groups,
            detections,
            out_w,
            out_h,
            vertical=args.vertical,
            mode=placement,
            fontsize=fontsize,
            plan=plan,
        )
        (work / "placements.json").write_text(json.dumps(placements, indent=2), encoding="utf-8")

        extra_fonts = script_font_files(lang)
        if cta_text:
            extra_fonts = list(extra_fonts) + ["montserrat/Montserrat-Black.ttf"]
        fontsdir = stage_fonts(style, Path(args.fonts_dir), work / "fonts", extra=extra_fonts)
        ass_path = write_ass(
            work / "captions.ass",
            words=words,
            style=style,
            animation=animation,
            words_per_line=words_per_line,
            play_x=out_w,
            play_y=out_h,
            vertical=args.vertical,
            motion=motion,
            strength=strength,
            placements=placements,
            cta=cta_text,
            duration=info["duration"],
        )

        fontconfig = write_fontconfig(work, fontsdir)
        render(
            src,
            dest,
            ass_path=ass_path,
            fontsdir=fontsdir,
            effects_vf=effects_vf,
            out_w=out_w,
            out_h=out_h,
            src_w=info["width"] or out_w,
            src_h=info["height"] or out_h,
            fontconfig=fontconfig,
            letterbox=letterbox,
            overlays=overlays,
            duration=info["duration"],
        )
        kind = "captions only" if args.no_effects else "captions + effects"
        kinds = sorted({d.get("kind", "none") for d in detections}) or ["none"]
        print(
            "Wrote {} ({}x{}, style={}, color={}, animation={}, motion={}, strength={}, placement={}, lang={}, cta={}, emoji={}, letterbox={}, subjects={}, {}, {} words)".format(
                dest, out_w, out_h, args.style, color_name, animation, motion, strength, placement,
                lang, cta_text or "none", emoji_mode, "on" if letterbox else "off",
                ",".join(kinds), kind, len(words),
            )
        )
        return 0
    finally:
        if tmp is not None and not args.keep_work:
            tmp.cleanup()
        elif tmp is not None and args.keep_work:
            kept = dest.parent / (dest.stem + "-work")
            if kept.exists():
                shutil.rmtree(kept)
            shutil.copytree(work, kept)
            print(f"Kept work files in {kept}")
            tmp.cleanup()


if __name__ == "__main__":
    sys.exit(main())
