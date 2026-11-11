"""Original caption animation presets for auto-edit (ASS / libass)."""

from __future__ import annotations

import math
import random

# Existing plus the new mature/fun set. Default remain smooth (fade / appear).
ANIMATIONS = (
    "pop",
    "bounce",
    "typewriter",
    "typewriter-cursor",
    "slide-up",
    "fade",
    "glow",
    "appear",
    "grow",
    "shrink",
    "zoom-out-in",
    "cinematic-reveal",
    "explode",
    "tumble",
    "bounce-letters",
    "wave",
    "drop-in",
    "rise-up",
    "blur-focus",
    "spin-in",
    "glitch",
    "swing",
    "elastic",
    "karaoke",
)

ANIMATION_CATEGORIES = {
    "Smooth": ("fade", "appear", "grow", "shrink", "blur-focus", "rise-up", "drop-in", "zoom-out-in"),
    "Playful": ("pop", "bounce", "bounce-letters", "elastic", "wave", "swing"),
    "Cinematic": ("cinematic-reveal", "appear", "fade", "blur-focus", "spin-in"),
    "Cool": ("glitch", "shrink", "zoom-out-in", "glow", "slide-up", "grow"),
    "Letters": ("cinematic-reveal", "typewriter", "typewriter-cursor", "explode", "tumble", "bounce-letters", "wave"),
    "Fun / Emoji": ("explode", "bounce-letters", "pop", "bounce", "elastic"),
}

LETTER_ANIMS = {
    "cinematic-reveal",
    "typewriter-cursor",
    "explode",
    "tumble",
    "bounce-letters",
    "wave",
}

# Typewriter stays inline (existing letter tags) except the cursor variant.


def _clamp(requested: int, event_ms: float) -> int:
    budget = max(40, int(event_ms * 0.9))
    return max(40, min(int(requested), budget))


def entrance_tags(animation: str, event_ms: float, cx: int, cy: int, motion_drives_pos: bool) -> str:
    """Whole-line entrance tags. Empty for letter animations (those use per-glyph events)."""
    if animation in LETTER_ANIMS or animation in ("typewriter", "karaoke"):
        return ""
    if animation == "pop":
        d = _clamp(140, event_ms)
        return rf"{{\fscx68\fscy68\t(0,{d},\fscx100\fscy100)}}"
    if animation == "bounce":
        a = _clamp(90, event_ms)
        b = _clamp(170, event_ms)
        c = _clamp(230, event_ms)
        if b <= a:
            b = a + 30
        if c <= b:
            c = b + 30
        return (
            rf"{{\fscx55\fscy55\t(0,{a},\fscx128\fscy128)"
            rf"\t({a},{b},\fscx90\fscy90)\t({b},{c},\fscx100\fscy100)}}"
        )
    if animation == "slide-up" and not motion_drives_pos:
        d = _clamp(180, event_ms)
        return rf"{{\move({cx},{cy + 90},{cx},{cy},0,{d})}}"
    if animation == "fade":
        d = _clamp(150, event_ms)
        return rf"{{\fad({d},0)}}"
    if animation == "glow":
        d = _clamp(140, event_ms)
        return rf"{{\alpha&H80&\blur1.2\t(0,{d},\alpha&H00&\blur0)}}"
    if animation == "appear":
        d = _clamp(220, event_ms)
        return rf"{{\alpha&HFF&\blur3.5\t(0,{d},\alpha&H00&\blur0)}}"
    if animation == "grow":
        d = _clamp(280, event_ms)
        return rf"{{\fscx42\fscy42\t(0,{d},\fscx100\fscy100)}}"
    if animation == "shrink":
        d = _clamp(260, event_ms)
        return rf"{{\fscx140\fscy140\t(0,{d},\fscx100\fscy100)}}"
    if animation == "zoom-out-in":
        a = _clamp(180, event_ms)
        b = _clamp(300, event_ms)
        if b <= a:
            b = a + 40
        return rf"{{\fscx160\fscy160\t(0,{a},\fscx88\fscy88)\t({a},{b},\fscx100\fscy100)}}"
    if animation == "drop-in" and not motion_drives_pos:
        d = _clamp(320, event_ms)
        return rf"{{\move({cx},{cy - 140},{cx},{cy},0,{d})\alpha&H40&\t(0,{d},\alpha&H00&)}}"
    if animation == "rise-up" and not motion_drives_pos:
        d = _clamp(320, event_ms)
        return rf"{{\move({cx},{cy + 130},{cx},{cy},0,{d})\alpha&H40&\t(0,{d},\alpha&H00&)}}"
    if animation == "blur-focus":
        d = _clamp(340, event_ms)
        return rf"{{\blur7\fscx108\fscy108\t(0,{d},\blur0\fscx100\fscy100)}}"
    if animation == "spin-in":
        d = _clamp(360, event_ms)
        return rf"{{\frz-160\fscx55\fscy55\t(0,{d},\frz0\fscx100\fscy100)}}"
    if animation == "glitch":
        # Subtle, short, then settle. Cool but still readable.
        return (
            r"{\fax0.18\fscx108\fscy96\alpha&H30&"
            r"\t(0,40,\fax-0.12\fscx94\fscy108\alpha&H00&)"
            r"\t(40,80,\fax0.08\fscx110\fscy97)"
            r"\t(80,140,\fax-0.04\fscx98\fscy102)"
            r"\t(140,200,\fax0\fscx100\fscy100)}"
        )
    if animation == "swing":
        d = _clamp(340, event_ms)
        return rf"{{\frz18\t(0,{d},\frz0)}}"
    if animation == "elastic":
        a = _clamp(140, event_ms)
        b = _clamp(230, event_ms)
        c = _clamp(300, event_ms)
        d = _clamp(360, event_ms)
        if b <= a:
            b = a + 40
        if c <= b:
            c = b + 30
        if d <= c:
            d = c + 30
        return (
            rf"{{\fscx40\fscy40\t(0,{a},\fscx118\fscy118)"
            rf"\t({a},{b},\fscx90\fscy90)\t({b},{c},\fscx106\fscy106)"
            rf"\t({c},{d},\fscx100\fscy100)}}"
        )
    return ""


def fade_out_tags(animation: str, event_ms: float) -> str:
    if animation in ("fade", "appear", "blur-focus"):
        fade = min(140, max(50, int(event_ms * 0.28)))
        start = max(0, int(event_ms) - fade)
        extra = r"\blur3" if animation in ("appear", "blur-focus") else ""
        return rf"{{\t({start},{int(event_ms)},\alpha&HFF&{extra})}}"
    return ""


def char_width(ch: str, fs: float) -> float:
    if ch == " ":
        return fs * 0.30
    if ch in "il.,'!|I:j;`":
        return fs * 0.32
    if ch in "mwMW@%":
        return fs * 0.78
    return fs * 0.56


def letter_layout(
    group: list[dict],
    keys: list[bool],
    fill_font: str,
    display_font: str,
    base: int,
    kw: int,
    primary: str,
    highlight: str,
    cx: int,
    cy: int,
) -> list[dict]:
    letters: list[dict] = []
    for i, w in enumerate(group):
        is_kw = keys[i] if i < len(keys) else False
        font = display_font if is_kw else fill_font
        fs = kw if is_kw else base
        color = highlight if is_kw else primary
        if i:
            letters.append(
                {
                    "ch": " ",
                    "fs": fs,
                    "font": fill_font,
                    "color": primary,
                    "word_i": i,
                    "is_space": True,
                    "is_kw": False,
                }
            )
        for ch in w["text"]:
            letters.append(
                {
                    "ch": ch,
                    "fs": fs,
                    "font": font,
                    "color": color,
                    "word_i": i,
                    "is_space": ch == " ",
                    "is_kw": is_kw,
                }
            )
    widths = [char_width(L["ch"], L["fs"]) for L in letters]
    total = sum(widths)
    x = cx - total / 2.0
    out = []
    for L, w in zip(letters, widths):
        out.append({**L, "x": x + w / 2.0, "y": cy, "w": w})
        x += w
    return out


def _rng(seed: str) -> random.Random:
    r = random.Random()
    r.seed(seed)
    return r


def letter_events(
    animation: str,
    letters: list[dict],
    group_start: float,
    group_end: float,
    an_tag: int,
    escape,
    ass_time,
) -> list[str]:
    """Per-character Dialogue lines with staggered \\t / \\move timing."""
    events: list[str] = []
    dur_ms = max(200.0, (group_end - group_start) * 1000)
    n = max(1, len([L for L in letters if not L["is_space"]]))
    glyph_i = 0
    for L in letters:
        if L["is_space"]:
            continue
        x, y, fs = L["x"], L["y"], L["fs"]
        face = "{\\fn%s}{\\fs%s\\c%s&}" % (L["font"], int(fs), L["color"])
        ch = escape(L["ch"])
        prefix = "{\\an5}" + rf"{{\pos({int(round(x))},{int(round(y))})}}"
        tags = ""
        start, end = group_start, group_end
        if animation == "cinematic-reveal":
            delay = int(glyph_i * 90)
            inn = 240
            tags = rf"{{\alpha&HFF&\fsp7\t({delay},{delay + inn},\alpha&H00&\fsp0)}}"
        elif animation == "tumble":
            delay = int(glyph_i * 70)
            inn = 320
            y0 = y - 90
            tags = (
                rf"{{\move({int(x)},{int(y0)},{int(x)},{int(y)},{delay},{delay + inn})"
                rf"\frz-75\alpha&H60&\t({delay},{delay + inn},\frz0\alpha&H00&)}}"
            )
        elif animation == "bounce-letters":
            delay = int(glyph_i * 75)
            a, b, c, d = delay + 160, delay + 260, delay + 340, delay + 420
            tags = (
                rf"{{\fscx70\fscy40\alpha&HFF&\t({delay},{a},\fscx100\fscy124\alpha&H00&)"
                rf"\t({a},{b},\fscy88)\t({b},{c},\fscy108)\t({c},{d},\fscy100)}}"
            )
        elif animation == "wave":
            # Slow, smooth vertical scale wave, phase-shifted per letter.
            phase = glyph_i * 70
            parts = [rf"\fscy100"]
            t = 0
            step = 180
            while t < dur_ms:
                t2 = min(dur_ms, t + step)
                # sine via sampled targets
                u = math.sin(2 * math.pi * ((t + phase) / 900.0))
                sc = 100 + 16 * u
                parts.append(rf"\t({int(t)},{int(t2)},\fscy{sc:.1f})")
                t = t2
            tags = "{" + "".join(parts) + "}"
        elif animation == "explode":
            # Hold, then letters scatter on exit.
            hold = max(180, int(dur_ms - 420))
            rng = _rng(f"{L['ch']}{glyph_i}{int(x)}")
            ang = rng.uniform(0, 2 * math.pi)
            dist = rng.uniform(90, 220)
            x2 = x + math.cos(ang) * dist
            y2 = y + math.sin(ang) * dist * 0.75
            rot = rng.uniform(-40, 40)
            tags = (
                rf"{{\move({int(x)},{int(y)},{int(x2)},{int(y2)},{hold},{int(dur_ms)})"
                rf"\t({hold},{int(dur_ms)},\frz{rot:.1f}\fscx70\fscy70\alpha&HFF&)}}"
            )
        elif animation == "typewriter-cursor":
            delay = int(glyph_i * 70)
            inn = 40
            tags = rf"{{\alpha&HFF&\t({delay},{delay + inn},\alpha&H00&)}}"
        else:
            tags = ""
        body = prefix + tags + face + ch
        events.append(
            f"Dialogue: 1,{ass_time(start)},{ass_time(end)},Default,,0,0,0,,{body}"
        )
        glyph_i += 1
    if animation == "typewriter-cursor":
        events.extend(
            _cursor_events(letters, group_start, group_end, escape, ass_time)
        )
    return events


def _cursor_events(letters, group_start, group_end, escape, ass_time) -> list[str]:
    visible = [L for L in letters if not L["is_space"]]
    if not visible:
        return []
    per = 0.070
    events = []
    for i, L in enumerate(visible):
        t0 = group_start + i * per
        t1 = min(group_end, t0 + per + 0.02)
        if t1 <= t0:
            continue
        cx = L["x"] + L["w"] * 0.55
        cy = L["y"]
        # Slim block cursor drawn as a rectangle.
        draw = (
            "{\\an5\\pos(%d,%d)\\p1\\bord0\\shad0\\c&H00FFFFFF&}"
            % (int(cx), int(cy))
            + "m 0 -28 l 8 -28 8 28 0 28{\\p0}"
        )
        events.append(
            f"Dialogue: 2,{ass_time(t0)},{ass_time(t1)},Default,,0,0,0,,{draw}"
        )
    return events


def karaoke_line(
    group: list[dict],
    style: dict,
    keys: list[bool],
    start: float,
    end: float,
    cx: int,
    cy: int,
    an_tag: int,
    escape,
    ass_time,
    font_base: int,
    font_kw: int,
) -> str:
    """One event; \\kf wipes each word for a lyrics / karaoke fill."""
    fill = style["font"]
    display = style.get("display_font") or fill
    sung = style.get("primary") or style.get("highlight")
    unsung = style.get("secondary") or sung
    parts = [rf"{{\an{an_tag}\pos({cx},{cy})}}"]
    for i, w in enumerate(group):
        is_kw = keys[i] if i < len(keys) else False
        fn = display if is_kw else fill
        fs = font_kw if is_kw else font_base
        dur_cs = max(8, int(round((w["end"] - w["start"]) * 100)))
        gap = " " if i else ""
        parts.append(
            gap
            + "{\\fn%s}{\\fs%s\\c%s&\\2c%s&}" % (fn, fs, sung, unsung)
            + rf"{{\kf{dur_cs}}}"
            + escape(w["text"])
        )
    body = "".join(parts)
    return f"Dialogue: 1,{ass_time(start)},{ass_time(end)},Default,,0,0,0,,{body}"


def list_animations() -> list[dict]:
    seen = set()
    items = []
    for cat, names in ANIMATION_CATEGORIES.items():
        for name in names:
            if name in seen or name not in ANIMATIONS:
                continue
            seen.add(name)
            items.append({"id": name, "label": name.replace("-", " "), "category": cat})
    for name in ANIMATIONS:
        if name not in seen:
            items.append({"id": name, "label": name.replace("-", " "), "category": "More"})
    return items
