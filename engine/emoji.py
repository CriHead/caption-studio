"""Keyword-to-emoji helpers and PNG burst overlays (Noto Color Emoji, OFL).

libass on this box cannot render the color-emoji font, so glyphs are composited
as PNG overlays with ffmpeg after the ASS burn.
"""

from __future__ import annotations

import re
from pathlib import Path

from paths import EMOJI_DIR  # noqa: E402

# word (lowercase, punctuation stripped) -> (filename, unicode char)
KEYWORD_EMOJI: dict[str, tuple[str, str]] = {
    "love": ("u2764_heart.png", "❤"),
    "loving": ("u2764_heart.png", "❤"),
    "heart": ("u2764_heart.png", "❤"),
    "hearts": ("u2764_heart.png", "❤"),
    "fire": ("u1f525_fire.png", "🔥"),
    "hot": ("u1f525_fire.png", "🔥"),
    "lit": ("u1f525_fire.png", "🔥"),
    "wow": ("u2728_sparkles.png", "✨"),
    "amazing": ("u2728_sparkles.png", "✨"),
    "magic": ("u2728_sparkles.png", "✨"),
    "sparkle": ("u2728_sparkles.png", "✨"),
    "star": ("u2b50_star.png", "⭐"),
    "stars": ("u1f31f_glowing_star.png", "🌟"),
    "best": ("u1f3c6_trophy.png", "🏆"),
    "win": ("u1f3c6_trophy.png", "🏆"),
    "shop": ("u1f6d2_shopping_cart.png", "🛒"),
    "shopping": ("u1f6d2_shopping_cart.png", "🛒"),
    "buy": ("u1f6d2_shopping_cart.png", "🛒"),
    "sale": ("u1f6cd_bags.png", "🛍"),
    "bags": ("u1f6cd_bags.png", "🛍"),
    "money": ("u1f4b0_moneybag.png", "💰"),
    "price": ("u1f4b0_moneybag.png", "💰"),
    "dollar": ("u1f4b0_moneybag.png", "💰"),
    "song": ("u1f3b5_music.png", "🎵"),
    "songs": ("u1f3b5_music.png", "🎵"),
    "music": ("u1f3b5_music.png", "🎵"),
    "sing": ("u1f3b5_music.png", "🎵"),
    "lyrics": ("u1f3b5_music.png", "🎵"),
    "yes": ("u2705_check.png", "✅"),
    "done": ("u2705_check.png", "✅"),
    "check": ("u2705_check.png", "✅"),
    "sun": ("u2600_sun.png", "☀"),
    "party": ("u1f389_party.png", "🎉"),
    "celebrate": ("u1f389_party.png", "🎉"),
    "cool": ("u1f60e_cool.png", "😎"),
    "boom": ("u1f4a5_boom.png", "💥"),
    "woww": ("u1f4a5_boom.png", "💥"),
    "gem": ("u1f48e_gem.png", "💎"),
    "gift": ("u1f381_gift.png", "🎁"),
    "phone": ("u1f4f1_phone.png", "📱"),
    "call": ("u1f4f1_phone.png", "📱"),
    "now": ("u1f449_point.png", "👉"),
    "perfect": ("u1f4af_100.png", "💯"),
}

# Burst uses a lively mix, not only the keyword's own glyph.
BURST_FILES = [
    "u1f525_fire.png",
    "u2728_sparkles.png",
    "u2764_heart.png",
    "u2b50_star.png",
    "u1f389_party.png",
    "u1f4a5_boom.png",
    "u1f31f_glowing_star.png",
]


def _stem(word: str) -> str:
    return re.sub(r"\W+", "", (word or "")).lower()


def lookup(word: str) -> tuple[Path, str] | None:
    key = _stem(word)
    item = KEYWORD_EMOJI.get(key)
    if not item:
        return None
    path = EMOJI_DIR / item[0]
    if not path.is_file():
        return None
    return path, item[1]


def tag_words(words: list[dict]) -> list[dict]:
    """Attach emoji metadata; do not put color-emoji characters into ASS text."""
    for w in words:
        hit = lookup(w.get("text") or "")
        if hit:
            w["emoji_png"] = str(hit[0])
            w["emoji_char"] = hit[1]
    return words


def burst_overlays(
    words: list[dict],
    play_w: int,
    play_h: int,
    cx: int | None = None,
    cy: int | None = None,
    count: int = 5,
) -> list[dict]:
    """Several small emojis pop out from a point and fade (around tagged words)."""
    hits = [w for w in words if w.get("emoji_png")]
    if not hits:
        # still burst once on the strongest/longest word if --emoji auto
        if not words:
            return []
        host = max(words, key=lambda w: len(_stem(w.get("text") or "")))
        hits = [host]
    overlays = []
    files = [EMOJI_DIR / name for name in BURST_FILES if (EMOJI_DIR / name).is_file()]
    if not files:
        return []
    import math

    for hi, host in enumerate(hits[:2]):
        t0 = float(host.get("start") or 0.0)
        t1 = t0 + 0.9
        origin_x = int(cx if cx is not None else play_w * 0.5)
        origin_y = int(cy if cy is not None else play_h * 0.62)
        for i in range(count):
            png = files[(hi * count + i) % len(files)]
            ang = (i / count) * 2 * math.pi + hi * 0.4
            dist = 90 + (i % 3) * 28
            overlays.append(
                {
                    "path": str(png),
                    "x": origin_x,
                    "y": origin_y,
                    "x2": int(origin_x + math.cos(ang) * dist),
                    "y2": int(origin_y + math.sin(ang) * dist * 0.85),
                    "start": t0,
                    "end": t1,
                    "size": 52 if i % 2 == 0 else 40,
                }
            )
        # also a slightly larger keyword glyph sitting near the word
        own = Path(host["emoji_png"]) if host.get("emoji_png") else files[0]
        if own.is_file():
            overlays.append(
                {
                    "path": str(own),
                    "x": origin_x + 80,
                    "y": origin_y - 10,
                    "x2": origin_x + 80,
                    "y2": origin_y - 18,
                    "start": t0,
                    "end": min(t0 + 1.2, float(host.get("end") or t0) + 0.8),
                    "size": 64,
                }
            )
    return overlays
