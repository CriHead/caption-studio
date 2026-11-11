"""Build original ASS captions from word timestamps (libass / ffmpeg)."""

from __future__ import annotations

import math
import re
from pathlib import Path

from styles import strength_scale
from animations import (
    LETTER_ANIMS,
    entrance_tags,
    fade_out_tags,
    karaoke_line,
    letter_events,
    letter_layout,
)

_SENTENCE_END = re.compile(r'[.!?]"?$')


def ass_time(seconds: float) -> str:
    cs = max(0, int(round(float(seconds) * 100)))
    s, cs = divmod(cs, 100)
    m, s = divmod(s, 60)
    h, m = divmod(m, 60)
    return f"{h:d}:{m:02d}:{s:02d}.{cs:02d}"


def escape_ass(text: str) -> str:
    return text.replace("\\", r"\\").replace("{", r"\{").replace("}", r"\}")


def load_words(path: Path) -> list[dict]:
    import json

    data = json.loads(Path(path).read_text(encoding="utf-8"))
    src = list(data.get("word_segments") or [])
    if not src:
        for seg in data.get("segments") or []:
            src.extend(seg.get("words") or [])
    words = []
    for item in src:
        text = (item.get("word") or item.get("text") or "").strip()
        if not text or "start" not in item or "end" not in item:
            continue
        start = float(item["start"])
        end = float(item["end"])
        if end <= start:
            end = start + 0.08
        words.append(
            {
                "text": text,
                "start": start,
                "end": end,
                "score": float(item.get("score") or 0.0),
                "emphasized": bool(item.get("emphasized", False)),
            }
        )
    words.sort(key=lambda w: w["start"])
    return words


def is_sentence_end(text: str) -> bool:
    return bool(_SENTENCE_END.search((text or "").strip()))


def group_words(words: list[dict], words_per_line: int) -> list[list[dict]]:
    n = max(1, int(words_per_line))
    groups: list[list[dict]] = []
    cur: list[dict] = []
    for w in words:
        cur.append(w)
        if len(cur) >= n or is_sentence_end(w["text"]):
            groups.append(cur)
            cur = []
    if cur:
        groups.append(cur)
    return groups


def sentence_starts(words: list[dict]) -> set[int]:
    starts = set()
    if words:
        starts.add(0)
    for i in range(1, len(words)):
        if is_sentence_end(words[i - 1]["text"]):
            starts.add(i)
    return starts


def _margin_v(style: dict, vertical: bool) -> int:
    key = "margin_v_vertical" if vertical else "margin_v_landscape"
    return int(style[key])


def _fontsize(style: dict, vertical: bool) -> int:
    key = "fontsize_vertical" if vertical else "fontsize_landscape"
    return int(style[key])



def _keyword_fontsize(style: dict, vertical: bool) -> int:
    key = "keyword_fontsize_vertical" if vertical else "keyword_fontsize_landscape"
    if key in style:
        return int(style[key])
    return int(round(_fontsize(style, vertical) * 1.2))


def _fit_fontsizes(text: str, base: int, keyword: int, max_w: int) -> tuple[int, int]:
    est = 0.62 * keyword * max(1, len(text))
    if est <= max_w:
        return base, keyword
    scale = max(0.62, max_w / max(1.0, est))
    return max(72, int(base * scale)), max(86, int(keyword * scale))


def _keyword_flags(group: list[dict]) -> list[bool]:
    flags = [bool(w.get("emphasized")) for w in group]
    if any(flags):
        return flags
    import re as _re
    lens = [len(_re.sub(r"\W", "", w["text"])) for w in group]
    top = max(lens) if lens else 0
    if top >= 4:
        out_flags = [False] * len(group)
        for i, n in enumerate(lens):
            if n == top:
                out_flags[i] = True
                break
        return out_flags
    if group:
        out_flags = [False] * len(group)
        out_flags[-1] = True
        return out_flags
    return flags


def _clamp_anim_ms(requested: int, event_ms: float) -> int:
    budget = max(40, int(event_ms * 0.9))
    return max(40, min(int(requested), budget))


def _anchor(play_x: int, play_y: int, margin_v: int) -> tuple[int, int]:
    return play_x // 2, play_y - margin_v


def motion_pose(
    motion: str,
    abs_ms: float,
    strength: str,
    cx: int,
    cy: int,
    emphasized: bool = False,
) -> dict:
    """Caption pose at an absolute time (ms from the group's first appearance)."""
    s = strength_scale(strength)
    t = max(0.0, float(abs_ms)) / 1000.0
    x, y = float(cx), float(cy)
    frz = 0.0
    fscx = 100.0
    fscy = 100.0
    if motion in ("none", "", None):
        return {"x": x, "y": y, "frz": frz, "fscx": fscx, "fscy": fscy}
    if motion == "wiggle":
        amp = 7.5 * s
        frz = amp * math.sin(2 * math.pi * t / 0.46)
    elif motion == "float":
        y += 38.0 * s * math.sin(2 * math.pi * t / 0.92)
        x += 10.0 * s * math.sin(2 * math.pi * t / 1.35 + 0.4)
        frz = 3.0 * s * math.sin(2 * math.pi * t / 0.92)
    elif motion == "swing":
        amp = 15.0 * s
        frz = amp * math.sin(2 * math.pi * t / 0.80)
        x += 8.0 * s * math.sin(2 * math.pi * t / 0.80)
    elif motion == "bounce-loop":
        amp = 24.0 * s
        u = math.sin(2 * math.pi * t / 0.42)
        fscy = 100.0 + amp * u
        fscx = 100.0 - amp * 0.62 * u
    elif motion == "shake-word":
        bump = 1.65 if emphasized else 1.0
        amp_r = 8.0 * s * bump
        amp_p = 11.0 * s * bump
        # Two incommensurate mid-speed sines: lively jitter, still readable at 30 fps.
        frz = amp_r * math.sin(2 * math.pi * t / 0.11) + 0.4 * amp_r * math.sin(2 * math.pi * t / 0.07 + 1.1)
        x += amp_p * math.sin(2 * math.pi * t / 0.10)
        y += amp_p * 0.85 * math.sin(2 * math.pi * t / 0.08 + 0.8)
    return {"x": x, "y": y, "frz": frz, "fscx": fscx, "fscy": fscy}


def _needs_pos(motion: str) -> bool:
    return motion in ("float", "swing", "shake-word")


def _uses_scale_loop(motion: str) -> bool:
    return motion == "bounce-loop"


def _motion_t_tags(motion: str, start_ms: float, event_ms: float, strength: str, cx: int, cy: int, emphasized: bool) -> str:
    """Chained \\t tags that keep motion going for the whole event, phase-continuous."""
    if motion in ("none", "", None) or event_ms <= 1:
        return ""
    step = 70 if motion != "shake-word" else 50
    times = list(range(0, max(1, int(event_ms)), step))
    if not times or times[-1] != int(event_ms):
        times.append(int(event_ms))
    poses = [motion_pose(motion, start_ms + tm, strength, cx, cy, emphasized) for tm in times]
    # Opening state at t=0 of this event
    p0 = poses[0]
    tags = [rf"\frz{p0['frz']:.2f}"]
    if _uses_scale_loop(motion):
        tags.append(rf"\fscx{p0['fscx']:.1f}\fscy{p0['fscy']:.1f}")
    parts = ["".join(tags)]
    for i in range(1, len(times)):
        p = poses[i]
        chunk = rf"\frz{p['frz']:.2f}"
        if _uses_scale_loop(motion):
            chunk += rf"\fscx{p['fscx']:.1f}\fscy{p['fscy']:.1f}"
        parts.append(rf"\t({times[i-1]},{times[i]},{chunk})")
    return "{" + "".join(parts) + "}"


def _pos_tag(x: float, y: float) -> str:
    return rf"{{\pos({int(round(x))},{int(round(y))})}}"


def _entrance_tags(animation: str, event_ms: float, play_x: int, play_y: int, margin_v: int, motion: str) -> str:
    cx, cy = _anchor(play_x, play_y, margin_v)
    return entrance_tags(animation, event_ms, cx, cy, _needs_pos(motion))


def _fade_out_tags(animation: str, event_ms: float) -> str:
    return fade_out_tags(animation, event_ms)


def _typewriter_letters(
    word: str,
    duration_ms: float,
    highlight: bool,
    hi: str,
    primary: str,
    offset_ms: float = 0.0,
) -> str:
    chars = list(word)
    if not chars:
        return ""
    per = max(18, min(70, int(duration_ms / max(1, len(chars)))))
    color = rf"{{\c{hi}&}}" if highlight else rf"{{\c{primary}&}}"
    parts = [color]
    for i, ch in enumerate(chars):
        t0 = i * per
        t1 = t0 + max(16, per // 2)
        esc = escape_ass(ch)
        if t1 <= offset_ms:
            parts.append(rf"{{\alpha&H00&}}{esc}")
        elif t0 < offset_ms < t1:
            parts.append(rf"{{\alpha&H00&}}{esc}")
        else:
            a = max(0, int(t0 - offset_ms))
            b = max(a + 8, int(t1 - offset_ms))
            parts.append(rf"{{\alpha&HFF&\t({a},{b},\alpha&H00&)}}{esc}")
    return "".join(parts)


def _active_word_tags(animation: str, highlight: str, event_ms: float, motion: str = "none") -> str:
    if animation == "glow":
        pulse = []
        t = 0
        step = 120
        blur_hi, blur_lo = 2.8, 0.5
        on = True
        while t < int(event_ms):
            nxt = min(int(event_ms), t + step)
            blur = blur_hi if on else blur_lo
            pulse.append(rf"\t({t},{nxt},\blur{blur})")
            t = nxt
            on = not on
        return rf"{{\c{highlight}&\blur0.5{''.join(pulse)}}}"
    if _uses_scale_loop(motion):
        # Scale is owned by the bounce-loop \t chain.
        return rf"{{\c{highlight}&}}"
    return rf"{{\c{highlight}&\fscx112\fscy112}}"


def _inactive_word_tags(primary: str, motion: str = "none") -> str:
    if _uses_scale_loop(motion):
        return rf"{{\c{primary}&\blur0\alpha&H00&}}"
    return rf"{{\c{primary}&\fscx100\fscy100\blur0\alpha&H00&}}"


def _line_text(
    group: list[dict],
    active_index: int,
    animation: str,
    style: dict,
    event_ms: float,
    motion: str = "none",
    offset_ms: float = 0.0,
    vertical: bool = False,
    font_base: int | None = None,
    font_kw: int | None = None,
) -> str:
    primary = style["primary"]
    hi = style["highlight"]
    fill_font = style.get("font")
    display_font = style.get("display_font") or fill_font
    base = font_base or _fontsize(style, vertical)
    kw = font_kw or _keyword_fontsize(style, vertical)
    keys = _keyword_flags(group)
    parts = []
    for i, w in enumerate(group):
        gap = " " if i else ""
        is_kw = keys[i] if i < len(keys) else False
        fn = display_font if is_kw else fill_font
        fs = kw if is_kw else base
        color = hi if i == active_index else (hi if is_kw else primary)
        # Isolate \fn in its own override so names with spaces/digits (Baloo 2, Playfair Display) are not leaked as visible text.
        face = "{\\fn%s}{\\fs%s\\c%s&}" % (fn, fs, color)
        if animation == "typewriter":
            if i < active_index:
                parts.append(gap + face + _inactive_word_tags(primary, motion) + escape_ass(w["text"]))
            elif i == active_index:
                dur = max(80.0, (w["end"] - w["start"]) * 1000)
                parts.append(gap + face + _typewriter_letters(w["text"], dur, True, hi, primary, offset_ms))
            else:
                parts.append(gap + face + r"{\alpha&HFF&}" + escape_ass(w["text"]))
        else:
            if i == active_index:
                parts.append(gap + face + _active_word_tags(animation, hi, event_ms, motion) + escape_ass(w["text"]))
            else:
                parts.append(gap + face + _inactive_word_tags(primary, motion) + escape_ass(w["text"]))
    return "".join(parts)


def _glow_underlay(group: list[dict], active_index: int, style: dict, event_ms: float, motion: str = "none") -> str:
    glow = style["glow"]
    parts = []
    for i, w in enumerate(group):
        gap = " " if i else ""
        if i == active_index:
            tags = _active_word_tags("glow", glow, event_ms, motion)
            parts.append(gap + tags + rf"{{\bord7\3c{glow}&\c{glow}&\4c{glow}&}}" + escape_ass(w["text"]))
        else:
            parts.append(gap + r"{\alpha&HFF&}" + escape_ass(w["text"]))
    return "".join(parts)


def _slice_times(start: float, end: float, motion: str) -> list[tuple[float, float]]:
    """Subdivide float/shake events so \\pos can keep moving. Other motions stay one piece."""
    if not _needs_pos(motion):
        return [(start, end)]
    step = 0.05 if motion == "shake-word" else 0.08
    out = []
    t = start
    while t < end - 1e-4:
        t2 = min(end, t + step)
        if t2 > t:
            out.append((t, t2))
        t = t2
    return out or [(start, end)]


def build_ass(
    words: list[dict],
    style: dict,
    animation: str,
    words_per_line: int,
    play_x: int,
    play_y: int,
    vertical: bool,
    motion: str = "none",
    strength: str = "medium",
    placements: list[dict] | None = None,
    cta: str | None = None,
    duration: float | None = None,
) -> str:
    groups = group_words(words, words_per_line)
    margin_v = _margin_v(style, vertical)
    fontsize = _fontsize(style, vertical)
    kwsize = _keyword_fontsize(style, vertical)
    cx_default, cy_default = _anchor(play_x, play_y, margin_v)
    alignment = 2  # events may override with n
    margin_lr = 48 if vertical else 80
    border_style = int(style.get("border_style") or 1)
    outline_colour = style.get("box_color") or style["outline"]

    header = [
        "[Script Info]",
        "Title: auto-edit captions",
        "ScriptType: v4.00+",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        f"PlayResX: {play_x}",
        f"PlayResY: {play_y}",
        "YCbCr Matrix: TV.709",
        f"LayoutResX: {play_x}",
        f"LayoutResY: {play_y}",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        (
            f"Style: Default,{style['font']},{fontsize},{style['primary']},{style['secondary']},"
            f"{outline_colour},{style['back']},{style['bold']},0,0,0,100,100,{int(style.get('spacing') or 0)},0,{border_style},"
            f"{style['outline_w']},{style['shadow']},{alignment},{margin_lr},{margin_lr},{margin_v},1"
        ),
        (
            f"Style: Glow,{style['font']},{fontsize},{style['glow']},{style['secondary']},"
            f"{style['glow']},{style['glow']},{style['bold']},0,0,0,100,100,0,0,1,"
            f"{max(style['outline_w'] + 3, 7)},0,{alignment},{margin_lr},{margin_lr},{margin_v},1"
        ),
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]

    events: list[str] = []
    for gi, group in enumerate(groups):
        place = placements[gi] if placements and gi < len(placements) else None
        if place:
            cx, cy, an_tag = int(place["x"]), int(place["y"]), int(place.get("an") or 2)
        else:
            cx, cy, an_tag = cx_default, cy_default, 2
        line_text = " ".join(w["text"] for w in group)
        fs_use, kw_use = _fit_fontsizes(line_text, fontsize, kwsize, play_x - 2 * margin_lr)
        group_start = group[0]["start"]
        group_end = group[-1]["end"]
        if gi + 1 < len(groups):
            nxt = groups[gi + 1][0]["start"]
            if nxt > group_end:
                group_end = min(nxt - 0.03, group_end + 0.12)
        keys = _keyword_flags(group)
        is_karaoke = animation == "karaoke" or bool(style.get("karaoke"))
        if is_karaoke:
            events.append(
                karaoke_line(
                    group, style, keys, group_start, group_end, cx, cy, an_tag,
                    escape_ass, ass_time, fs_use, kw_use,
                )
            )
            continue
        if animation in LETTER_ANIMS:
            letters = letter_layout(
                group, keys,
                style.get("font"), style.get("display_font") or style.get("font"),
                fs_use, kw_use, style["primary"], style["highlight"], cx, cy,
            )
            events.extend(
                letter_events(animation, letters, group_start, group_end, an_tag, escape_ass, ass_time)
            )
            continue
        for i, w in enumerate(group):
            start = w["start"]
            end = group[i + 1]["start"] if i + 1 < len(group) else group_end
            if end <= start:
                end = start + 0.05
            emphasized = bool(w.get("emphasized")) or (i == 0 and gi == 0) or (i == 0)
            # Sentence-starting words (first in a group after punctuation) already sit at i==0
            # after our sentence-aware grouping; treat those as emphasized for shake-word.
            slices = _slice_times(start, end, motion)
            for si, (s0, s1) in enumerate(slices):
                event_ms = (s1 - s0) * 1000
                offset_ms = (s0 - start) * 1000
                abs_ms = (s0 - group_start) * 1000
                first_chunk = i == 0 and si == 0
                last_chunk = (i == len(group) - 1) and (si == len(slices) - 1)
                pose = motion_pose(motion, abs_ms, strength, cx, cy, emphasized)
                prefix = chr(123) + ('\\an%d' % an_tag) + chr(125)
                if _needs_pos(motion):
                    x, y = pose["x"], pose["y"]
                    if first_chunk and animation == "slide-up":
                        y += 90
                    # Piecewise \move keeps float/shake traveling; \pos is a fallback anchor.
                    if event_ms > 20:
                        nxt = motion_pose(motion, abs_ms + event_ms, strength, cx, cy, emphasized)
                        prefix += rf"{{\move({int(round(x))},{int(round(y))},{int(round(nxt['x']))},{int(round(nxt['y']))},0,{int(event_ms)})}}"
                    else:
                        prefix += _pos_tag(x, y)
                elif animation == "slide-up":
                    prefix += _pos_tag(cx, cy)
                if first_chunk and not _needs_pos(motion):
                    # Full-word duration so pop/bounce/fade can finish even if this slice is short.
                    prefix += _entrance_tags(animation, (end - start) * 1000, play_x, play_y, margin_v, motion)
                elif first_chunk and animation not in LETTER_ANIMS and animation not in ("typewriter", "karaoke"):
                    prefix += _entrance_tags(animation, (end - start) * 1000, play_x, play_y, margin_v, motion)
                prefix += _motion_t_tags(motion, abs_ms, event_ms, strength, cx, cy, emphasized)
                suffix = _fade_out_tags(animation, event_ms) if last_chunk else ""
                body = _line_text(group, i, animation, style, event_ms, motion, offset_ms, vertical, fs_use, kw_use)
                if animation == "glow":
                    under = _glow_underlay(group, i, style, event_ms, motion)
                    events.append(
                        f"Dialogue: 0,{ass_time(s0)},{ass_time(s1)},Glow,,0,0,0,,{prefix}{under}{suffix}"
                    )
                    events.append(
                        f"Dialogue: 1,{ass_time(s0)},{ass_time(s1)},Default,,0,0,0,,{prefix}{body}{suffix}"
                    )
                else:
                    events.append(
                        f"Dialogue: 1,{ass_time(s0)},{ass_time(s1)},Default,,0,0,0,,{prefix}{body}{suffix}"
                    )

    if cta and str(cta).strip():
        from cta import cta_events
        clip_end = float(duration) if duration else (words[-1]["end"] + 1.6 if words else 4.0)
        # Prefer a matching word; otherwise sit near the end of the clip.
        hit = None
        needle = str(cta).strip().lower()
        for w in words:
            text = (w.get("text") or "").lower()
            if needle in text or text in needle.split():
                # Prefer a late match so the button is not covered by early captions.
                if float(w.get("start") or 0) >= clip_end * 0.45:
                    hit = w
        if hit:
            c0 = max(0.0, float(hit["start"]) - 0.15)
            c1 = min(clip_end, max(float(hit["end"]) + 1.8, c0 + 2.4))
        else:
            c0 = max(0.0, clip_end - 3.2)
            c1 = clip_end
        events.extend(cta_events(str(cta).strip(), c0, c1, play_x, play_y, ass_time=ass_time))

    return "\n".join(header + events) + "\n"


def write_ass(path: Path, **kwargs) -> Path:
    path = Path(path)
    path.write_text(build_ass(**kwargs), encoding="utf-8")
    return path
