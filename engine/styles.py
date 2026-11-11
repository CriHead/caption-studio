"""Caption style presets, color palettes, and motion names for the local auto-edit tool.

Fonts are OFL 1.1 or Apache 2.0 families stored under tools/fonts/ with their
license files. These presets are original; they do not copy another app's assets.
"""

from __future__ import annotations

import copy
import re

from animations import ANIMATION_CATEGORIES, ANIMATIONS, list_animations  # noqa: F401
MOTIONS = ("wiggle", "float", "swing", "bounce-loop", "shake-word", "none")
STRENGTHS = ("low", "medium", "high")
PLACEMENTS = ("auto", "bottom", "center", "top", "left", "right", "lower-left", "lower-right")

# Default look: the smooth float/drift from sample-motion-kids, plus placement around the subject.
DEFAULT_STYLE = "elegant-serif"
DEFAULT_MOTION = "float"
DEFAULT_PALETTE = "pearl"


def rgb_to_ass(r: int, g: int, b: int, a: int = 0) -> str:
    """ASS colour &HAABBGGRR."""
    return f"&H{a:02X}{b:02X}{g:02X}{r:02X}"


def ass_to_rgb(value: str) -> tuple[int, int, int] | None:
    raw = (value or "").strip().lstrip("&").lstrip("H").lstrip("h")
    raw = raw.rstrip("&")
    if len(raw) == 8:
        raw = raw[2:]  # drop AA
    if len(raw) == 6 and all(c in "0123456789abcdefABCDEF" for c in raw):
        bb, gg, rr = raw[0:2], raw[2:4], raw[4:6]
        return int(rr, 16), int(gg, 16), int(bb, 16)
    return None


def dim_ass(value: str, amount: float = 0.45) -> str:
    rgb = ass_to_rgb(value)
    if not rgb:
        return value
    return rgb_to_ass(*_mix(rgb, (24, 24, 24), amount))


def parse_hex(value: str) -> tuple[int, int, int] | None:
    raw = (value or "").strip().lstrip("#")
    if len(raw) == 3 and all(c in "0123456789abcdefABCDEF" for c in raw):
        raw = "".join(c * 2 for c in raw)
    if len(raw) == 6 and all(c in "0123456789abcdefABCDEF" for c in raw):
        return int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16)
    return None


def _clamp(n: int) -> int:
    return max(0, min(255, int(n)))


def _mix(c: tuple[int, int, int], other: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return tuple(_clamp(a + (b - a) * t) for a, b in zip(c, other))  # type: ignore[return-value]


def _dark(c: tuple[int, int, int], amount: float = 0.55) -> tuple[int, int, int]:
    return _mix(c, (20, 16, 14), amount)


def palette_from_rgb(r: int, g: int, b: int, name: str = "custom") -> dict:
    base = (r, g, b)
    light = _mix(base, (255, 250, 245), 0.72)
    # Keep typography readable on mixed video: pale fill, vivid keyword, dark outline.
    primary = light if (r + g + b) / 3 < 220 else _mix(base, (255, 255, 255), 0.2)
    highlight = base
    outline = _dark(base, 0.72)
    glow = _mix(base, (255, 240, 230), 0.25)
    back = rgb_to_ass(*_dark(base, 0.8), a=0x66)
    return {
        "name": name,
        "swatch": f"#{r:02X}{g:02X}{b:02X}",
        "primary": rgb_to_ass(*primary),
        "highlight": rgb_to_ass(*highlight),
        "outline": rgb_to_ass(*outline),
        "glow": rgb_to_ass(*glow),
        "back": back,
        "box_color": rgb_to_ass(*_mix(base, (40, 24, 32), 0.25)),
        "label": name.replace("-", " ").title(),
    }


# Named palettes. Values are RGB and converted to ASS below.
_PALETTE_RGB: dict[str, tuple[int, int, int]] = {
    "rose-gold": (224, 176, 152),
    "pearl": (236, 226, 214),
    "sage": (138, 165, 138),
    "lavender": (184, 160, 216),
    "ocean": (74, 142, 190),
    "sunset": (232, 120, 80),
    "mono-black": (28, 28, 28),
    "mono-white": (250, 250, 250),
    "gold": (212, 175, 55),
    "blush": (232, 160, 176),
    "mint": (126, 200, 176),
    "neon": (80, 255, 180),
}

PALETTES: dict[str, dict] = {name: palette_from_rgb(r, g, b, name) for name, (r, g, b) in _PALETTE_RGB.items()}

# Readable exceptions for mono palettes (black type vs white type).
PALETTES["mono-black"].update(
    {
        "primary": rgb_to_ass(18, 18, 18),
        "highlight": rgb_to_ass(40, 40, 40),
        "outline": rgb_to_ass(255, 255, 255),
        "glow": rgb_to_ass(200, 200, 200),
        "back": rgb_to_ass(255, 255, 255, 0x66),
        "box_color": rgb_to_ass(20, 20, 20),
        "label": "Mono Black",
    }
)
PALETTES["mono-white"].update(
    {
        "primary": rgb_to_ass(255, 255, 255),
        "highlight": rgb_to_ass(245, 245, 245),
        "outline": rgb_to_ass(20, 18, 16),
        "glow": rgb_to_ass(230, 230, 230),
        "back": rgb_to_ass(0, 0, 0, 0x66),
        "box_color": rgb_to_ass(250, 250, 250),
        "label": "Mono White",
    }
)
PALETTES["neon"].update(
    {
        "primary": rgb_to_ass(230, 255, 240),
        "highlight": rgb_to_ass(80, 255, 180),
        "outline": rgb_to_ass(10, 20, 18),
        "glow": rgb_to_ass(120, 255, 220),
        "label": "Neon",
    }
)


def _style(
    *,
    font: str,
    display_font: str,
    font_files: list[str],
    display_font_files: list[str],
    primary: str,
    highlight: str,
    outline: str,
    glow: str,
    label: str,
    blurb: str,
    fontsize_landscape: int = 122,
    fontsize_vertical: int = 110,
    keyword_fontsize_landscape: int = 148,
    keyword_fontsize_vertical: int = 132,
    outline_w: float = 4.0,
    shadow: float = 3.0,
    bold: int = 0,
    back: str = "&H66000000",
    border_style: int = 1,
    box_color: str | None = None,
    words_per_line: int = 2,
    default_animation: str = "fade",
    default_motion: str = "float",
    margin_v_landscape: int = 110,
    margin_v_vertical: int = 250,
    spacing: int = 0,
    letterbox: bool = False,
    karaoke: bool = False,
    family: str = "",
    default_placement: str = "auto",
    secondary: str = "&HFF000000",
) -> dict:
    data = {
        "font": font,
        "display_font": display_font,
        "font_files": font_files,
        "display_font_files": display_font_files,
        "fontsize_landscape": fontsize_landscape,
        "fontsize_vertical": fontsize_vertical,
        "keyword_fontsize_landscape": keyword_fontsize_landscape,
        "keyword_fontsize_vertical": keyword_fontsize_vertical,
        "primary": primary,
        "secondary": secondary,
        "outline": outline,
        "back": back,
        "bold": bold,
        "outline_w": outline_w,
        "shadow": shadow,
        "highlight": highlight,
        "glow": glow,
        "margin_v_landscape": margin_v_landscape,
        "margin_v_vertical": margin_v_vertical,
        "border_style": border_style,
        "words_per_line": words_per_line,
        "default_animation": default_animation,
        "default_motion": default_motion,
        "label": label,
        "blurb": blurb,
        "spacing": spacing,
        "letterbox": letterbox,
        "karaoke": karaoke,
        "family": family,
        "default_placement": default_placement,
    }
    if box_color:
        data["box_color"] = box_color
    return data


STYLES: dict[str, dict] = {
    "elegant-serif": _style(
        label="Elegant Serif",
        blurb="Soft serif, calm and grown-up",
        font="Cormorant Garamond",
        display_font="Playfair Display",
        font_files=["cormorant/CormorantGaramond-SemiBold.ttf"],
        display_font_files=["playfair/PlayfairDisplay-Bold.ttf"],
        primary="&H00E4EDF4",
        highlight="&H0078B4C8",
        outline="&H00121824",
        glow="&H00A0C8D8",
        outline_w=3.5,
        shadow=4.0,
        default_animation="fade",
    ),
    "soft-luxe": _style(
        label="Soft Luxe",
        blurb="Champagne gold with a soft shadow",
        font="Playfair Display",
        display_font="DM Serif Display",
        font_files=["playfair/PlayfairDisplay-Regular.ttf"],
        display_font_files=["dmserif/DMSerifDisplay-Regular.ttf"],
        primary="&H00B8D7FF",
        highlight="&H0000E4FF",
        outline="&H00182A48",
        glow="&H0068C8FF",
        back="&H66201000",
        outline_w=3.5,
        shadow=6.0,
        default_animation="fade",
    ),
    "modern-clean": _style(
        label="Modern Clean",
        blurb="Simple sans, airy and precise",
        font="Outfit",
        display_font="Outfit Bold",
        font_files=["outfit/Outfit-Medium.ttf"],
        display_font_files=["outfit/Outfit-Bold.ttf"],
        primary="&H00F0F3F5",
        highlight="&H00B0C8D8",
        outline="&H00181820",
        glow="&H00C8DCE8",
        outline_w=2.5,
        shadow=1.5,
        fontsize_landscape=118,
        fontsize_vertical=108,
        keyword_fontsize_landscape=140,
        keyword_fontsize_vertical=126,
        default_animation="fade",
    ),
    "champagne": _style(
        label="Champagne",
        blurb="Cream and gold, quietly festive",
        font="Playfair Display",
        display_font="Cinzel",
        font_files=["playfair/PlayfairDisplay-Regular.ttf"],
        display_font_files=["cinzel/Cinzel-SemiBold.ttf"],
        primary="&H00E8F0F8",
        highlight="&H0078C8E8",
        outline="&H00201A12",
        glow="&H00A0D8F0",
        outline_w=3.5,
        shadow=4.5,
        default_animation="fade",
    ),
    "minimal-glow": _style(
        label="Minimal Glow",
        blurb="Thin type with a soft light",
        font="Outfit",
        display_font="Outfit Bold",
        font_files=["outfit/Outfit-Medium.ttf"],
        display_font_files=["outfit/Outfit-Bold.ttf"],
        primary="&H00F2F6F8",
        highlight="&H0090C0D0",
        outline="&H00202020",
        glow="&H00A8D8E0",
        outline_w=2.0,
        shadow=0.0,
        default_animation="glow",
    ),
    "editorial": _style(
        label="Editorial",
        blurb="Magazine serif with a sharp keyword",
        font="Libre Baskerville",
        display_font="Playfair Display",
        font_files=["librebaskerville/LibreBaskerville-Regular.ttf"],
        display_font_files=["playfair/PlayfairDisplay-Bold.ttf"],
        primary="&H00F4F4F4",
        highlight="&H002A2AFF",
        outline="&H00000000",
        glow="&H002A2AFF",
        outline_w=3.5,
        shadow=3.0,
        default_animation="slide-up",
    ),
    "rounded-soft": _style(
        label="Rounded Soft",
        blurb="Friendly rounds, muted and calm",
        font="Fredoka",
        display_font="Baloo 2",
        font_files=["fredoka/Fredoka-Medium.ttf"],
        display_font_files=["baloo2/Baloo2-Bold.ttf"],
        primary="&H00ECF0F6",
        highlight="&H00C8B0C8",
        outline="&H00403848",
        glow="&H00D0C0D8",
        outline_w=4.0,
        shadow=2.5,
        bold=-1,
        default_animation="fade",
    ),
    "bold-classy": _style(
        label="Bold Classy",
        blurb="Strong letters, still refined",
        font="Cinzel",
        display_font="Montserrat Black",
        font_files=["cinzel/Cinzel-SemiBold.ttf"],
        display_font_files=["montserrat/Montserrat-Black.ttf"],
        primary="&H00E6EFF3",
        highlight="&H0078C8E0",
        outline="&H00101018",
        glow="&H00A0D0E8",
        outline_w=5.0,
        shadow=3.5,
        bold=-1,
        default_animation="pop",
    ),
    "script-accent": _style(
        label="Script Accent",
        blurb="Serif body, handwritten keywords",
        font="Cormorant Garamond",
        display_font="Great Vibes",
        font_files=["cormorant/CormorantGaramond-SemiBold.ttf"],
        display_font_files=["greatvibes/GreatVibes-Regular.ttf"],
        primary="&H00EAF1F6",
        highlight="&H00D8B4C8",
        outline="&H00181624",
        glow="&H00E8D0E0",
        fontsize_landscape=120,
        fontsize_vertical=108,
        keyword_fontsize_landscape=168,
        keyword_fontsize_vertical=150,
        outline_w=2.8,
        shadow=3.0,
        default_animation="fade",
    ),
    "luxe": _style(
        label="Luxe",
        blurb="Gold serif with a rich shadow",
        font="Playfair Display",
        display_font="DM Serif Display",
        font_files=["playfair/PlayfairDisplay-Regular.ttf"],
        display_font_files=["dmserif/DMSerifDisplay-Regular.ttf"],
        primary="&H00B8D7FF",
        highlight="&H0000E4FF",
        outline="&H00182A48",
        glow="&H0068C8FF",
        back="&H66201000",
        outline_w=3.5,
        shadow=6.0,
        default_animation="fade",
    ),
    "clean-minimal": _style(
        label="Clean Minimal",
        blurb="Slim sans, quiet highlight",
        font="Poppins SemiBold",
        display_font="Poppins",
        font_files=["poppins/Poppins-SemiBold.ttf"],
        display_font_files=["poppins/Poppins-Bold.ttf"],
        primary="&H00F5F5F5",
        highlight="&H00F0C070",
        outline="&H00201818",
        glow="&H00F0C070",
        outline_w=3.0,
        shadow=2.0,
        default_animation="fade",
    ),
    "magazine": _style(
        label="Magazine",
        blurb="Sans body, serif keyword, editorial red",
        font="Poppins SemiBold",
        display_font="Playfair Display",
        font_files=["poppins/Poppins-SemiBold.ttf"],
        display_font_files=["playfair/PlayfairDisplay-Bold.ttf"],
        primary="&H00F4F4F4",
        highlight="&H002A2AFF",
        outline="&H00000000",
        glow="&H002A2AFF",
        outline_w=4.0,
        shadow=3.0,
        default_animation="slide-up",
    ),
    "bold-pop": _style(
        label="Bold Pop",
        blurb="Big and clear, still smooth",
        font="Montserrat Black",
        display_font="Anton",
        font_files=["montserrat/Montserrat-Black.ttf"],
        display_font_files=["anton/Anton-Regular.ttf"],
        primary="&H00FFFFFF",
        highlight="&H0000D7FF",
        outline="&H00000000",
        glow="&H0000D7FF",
        back="&H80000000",
        outline_w=6.0,
        shadow=4.0,
        bold=-1,
        fontsize_landscape=128,
        fontsize_vertical=116,
        keyword_fontsize_landscape=156,
        keyword_fontsize_vertical=140,
        default_animation="pop",
    ),
    "kids-pastel": _style(
        label="Kids Pastel",
        blurb="Soft cream and pink, playful float",
        font="Baloo 2",
        display_font="Fredoka",
        font_files=["baloo2/Baloo2-Bold.ttf"],
        display_font_files=["fredoka/Fredoka-Bold.ttf"],
        primary="&H00FFF8FF",
        highlight="&H00C8A0FF",
        outline="&H00AA6688",
        glow="&H00E0B0FF",
        back="&H662A1838",
        outline_w=5.0,
        shadow=3.0,
        bold=-1,
        fontsize_landscape=124,
        fontsize_vertical=112,
        keyword_fontsize_landscape=148,
        keyword_fontsize_vertical=132,
        default_animation="bounce",
    ),
    "hormozi": _style(
        label="Hormozi",
        blurb="One huge yellow word, heavy outline",
        font="Montserrat Black",
        display_font="Anton",
        font_files=["montserrat/Montserrat-Black.ttf"],
        display_font_files=["anton/Anton-Regular.ttf"],
        primary="&H00FFFFFF",
        highlight="&H0000F0FF",
        outline="&H00000000",
        glow="&H0000E0FF",
        back="&H80000000",
        outline_w=10.0,
        shadow=5.0,
        bold=-1,
        fontsize_landscape=148,
        fontsize_vertical=132,
        keyword_fontsize_landscape=168,
        keyword_fontsize_vertical=148,
        words_per_line=1,
        default_animation="pop",
        margin_v_landscape=120,
        margin_v_vertical=260,
    ),
    "bubble": _style(
        label="Bubble",
        blurb="Rounded letters on a soft color box",
        font="Fredoka",
        display_font="Baloo 2",
        font_files=["fredoka/Fredoka-Medium.ttf"],
        display_font_files=["baloo2/Baloo2-Bold.ttf"],
        primary="&H00FFFFFF",
        highlight="&H0040E8FF",
        outline="&H00C86A9A",
        glow="&H00C8A0FF",
        back="&H00C86A9A",
        box_color="&H00C86A9A",
        outline_w=12.0,
        shadow=0.0,
        bold=-1,
        border_style=3,
        default_animation="fade",
    ),
    "neon": _style(
        label="Neon",
        blurb="Bright outline, evening-party glow",
        font="Poppins SemiBold",
        display_font="Bangers",
        font_files=["poppins/Poppins-SemiBold.ttf"],
        display_font_files=["bangers/Bangers-Regular.ttf"],
        primary="&H00FFF3C8",
        highlight="&H00FF44FF",
        outline="&H00FF8A00",
        glow="&H00FF66CC",
        back="&H6600FFAA",
        outline_w=5.0,
        shadow=0.0,
        fontsize_landscape=126,
        fontsize_vertical=114,
        keyword_fontsize_landscape=158,
        keyword_fontsize_vertical=142,
        default_animation="glow",
    ),
    "comic": _style(
        label="Comic",
        blurb="Display lettering, warm highlight",
        font="Poppins SemiBold",
        display_font="Luckiest Guy",
        font_files=["poppins/Poppins-SemiBold.ttf"],
        display_font_files=["luckiestguy/LuckiestGuy-Regular.ttf"],
        primary="&H00F8F8FF",
        highlight="&H000064FF",
        outline="&H00101840",
        glow="&H0000A0FF",
        back="&H80001030",
        outline_w=6.0,
        shadow=4.0,
        fontsize_landscape=124,
        fontsize_vertical=112,
        keyword_fontsize_landscape=152,
        keyword_fontsize_vertical=136,
        default_animation="slide-up",
    ),
    "instrument": _style(
        label="Instrument",
        blurb="Warm literary serif, very quiet",
        font="Instrument Serif",
        display_font="Instrument Serif",
        font_files=["instrumentserif/InstrumentSerif-Regular.ttf"],
        display_font_files=["instrumentserif/InstrumentSerif-Regular.ttf"],
        primary="&H00E6EEF3",
        highlight="&H0090B0C8",
        outline="&H00101620",
        glow="&H00A8C8D8",
        outline_w=3.0,
        shadow=3.5,
        fontsize_landscape=128,
        fontsize_vertical=116,
        keyword_fontsize_landscape=152,
        keyword_fontsize_vertical=136,
        default_animation="fade",
    ),
    "cinematic": _style(
        label="Cinematic",
        blurb="Wide-tracking serif, slow letter reveal",
        font="Playfair Display",
        display_font="Playfair Display",
        font_files=["playfair/PlayfairDisplay-Regular.ttf"],
        display_font_files=["playfair/PlayfairDisplay-Bold.ttf"],
        primary="&H00F2EDE4",
        highlight="&H00B8D0E8",
        outline="&H00101418",
        glow="&H00C8D8E8",
        outline_w=3.0,
        shadow=5.0,
        fontsize_landscape=126,
        fontsize_vertical=114,
        keyword_fontsize_landscape=150,
        keyword_fontsize_vertical=134,
        default_animation="cinematic-reveal",
        spacing=8,
        letterbox=True,
        family="cinematic",
    ),
    "playful": _style(
        label="Playful",
        blurb="Bouncy Poppins, friendly and bright",
        font="Poppins",
        display_font="Poppins Black",
        font_files=["poppins/Poppins-Bold.ttf"],
        display_font_files=["poppins/Poppins-Black.ttf"],
        primary="&H00FFF8F0",
        highlight="&H0068C8F8",
        outline="&H00302028",
        glow="&H00A0D8FF",
        outline_w=4.0,
        shadow=2.5,
        default_animation="bounce-letters",
        family="playful",
    ),
    "cool-serious": _style(
        label="Cool Serious",
        blurb="Clean Poppins, subtle glitch and slide",
        font="Poppins SemiBold",
        display_font="Poppins ExtraBold",
        font_files=["poppins/Poppins-SemiBold.ttf"],
        display_font_files=["poppins/Poppins-ExtraBold.ttf"],
        primary="&H00F3F3F3",
        highlight="&H00D8D8D8",
        outline="&H00101010",
        glow="&H00C0C0C0",
        outline_w=2.5,
        shadow=1.0,
        default_animation="glitch",
        family="cool-serious",
    ),
    "pastel": _style(
        label="Pastel",
        blurb="Soft Poppins, calm colors",
        font="Poppins SemiBold",
        display_font="Poppins",
        font_files=["poppins/Poppins-SemiBold.ttf"],
        display_font_files=["poppins/Poppins-Bold.ttf"],
        primary="&H00F8F0F4",
        highlight="&H00D8B8C8",
        outline="&H00483840",
        glow="&H00E8D0DC",
        outline_w=3.5,
        shadow=2.0,
        default_animation="appear",
        family="pastel",
    ),
    "commercial": _style(
        label="Commercial",
        blurb="Extra-bold Poppins, built for a CTA",
        font="Poppins Black",
        display_font="Archivo Black",
        font_files=["poppins/Poppins-Black.ttf"],
        display_font_files=["archivoblack/ArchivoBlack-Regular.ttf"],
        primary="&H00FFFFFF",
        highlight="&H0000D0FF",
        outline="&H00000000",
        glow="&H0000E0FF",
        back="&H80000000",
        outline_w=6.0,
        shadow=3.0,
        bold=-1,
        fontsize_landscape=136,
        fontsize_vertical=122,
        keyword_fontsize_landscape=160,
        keyword_fontsize_vertical=142,
        default_animation="pop",
        family="commercial",
    ),
    "newspaper": _style(
        label="Newspaper",
        blurb="News serif, blackletter masthead word",
        font="Old Standard TT",
        display_font="UnifrakturMaguntia",
        font_files=["oldstandard/OldStandardTT-Regular.ttf", "oldstandard/OldStandardTT-Bold.ttf"],
        display_font_files=["unifraktur/UnifrakturMaguntia-Regular.ttf", "librecaslon/LibreCaslonText-Bold.ttf"],
        primary="&H00F4F0E8",
        highlight="&H00181818",
        outline="&H00FFFFFF",
        glow="&H00E8E0D0",
        outline_w=3.0,
        shadow=2.0,
        fontsize_landscape=124,
        fontsize_vertical=112,
        keyword_fontsize_landscape=148,
        keyword_fontsize_vertical=132,
        default_animation="drop-in",
        family="newspaper",
    ),
    "lyrics": _style(
        label="Lyrics",
        blurb="Centered karaoke fill, made for songs",
        font="Poppins SemiBold",
        display_font="Poppins ExtraBold",
        font_files=["poppins/Poppins-SemiBold.ttf"],
        display_font_files=["poppins/Poppins-ExtraBold.ttf"],
        primary="&H00B0B0B0",
        highlight="&H00FFFFFF",
        secondary="&H00B0B0B0",
        outline="&H00000000",
        glow="&H00FFE0A0",
        back="&H66000000",
        outline_w=5.0,
        shadow=2.0,
        fontsize_landscape=72,
        fontsize_vertical=68,
        keyword_fontsize_landscape=78,
        keyword_fontsize_vertical=72,
        words_per_line=5,
        default_animation="karaoke",
        default_motion="none",
        karaoke=True,
        family="lyrics",
        default_placement="center",
    ),
    "extra-bold": _style(
        label="Extra Bold",
        blurb="Poppins Black and Archivo, big type",
        font="Poppins ExtraBold",
        display_font="Anton",
        font_files=["poppins/Poppins-ExtraBold.ttf"],
        display_font_files=["anton/Anton-Regular.ttf", "poppins/Poppins-Black.ttf"],
        primary="&H00FFFFFF",
        highlight="&H0000E4FF",
        outline="&H00000000",
        glow="&H0000F0FF",
        outline_w=7.0,
        shadow=4.0,
        bold=-1,
        fontsize_landscape=140,
        fontsize_vertical=126,
        keyword_fontsize_landscape=168,
        keyword_fontsize_vertical=148,
        default_animation="elastic",
        family="extra-bold",
    ),
}


def get_style(name: str | None) -> dict:
    key = (name or DEFAULT_STYLE).strip().lower()
    if key not in STYLES:
        known = ", ".join(STYLES)
        raise SystemExit(f"Unknown style {name!r}. Choose one of: {known}")
    return copy.deepcopy(STYLES[key])


def get_animation(name: str | None, style: dict) -> str:
    if not name:
        return style["default_animation"]
    key = name.strip().lower()
    if key not in ANIMATIONS:
        known = ", ".join(ANIMATIONS)
        raise SystemExit(f"Unknown animation {name!r}. Choose one of: {known}")
    return key


def get_motion(name: str | None, style: dict) -> str:
    if not name:
        return style.get("default_motion", DEFAULT_MOTION)
    key = name.strip().lower()
    if key not in MOTIONS:
        known = ", ".join(MOTIONS)
        raise SystemExit(f"Unknown motion {name!r}. Choose one of: {known}")
    return key


def get_strength(name: str | None) -> str:
    key = (name or "medium").strip().lower()
    if key not in STRENGTHS:
        known = ", ".join(STRENGTHS)
        raise SystemExit(f"Unknown motion strength {name!r}. Choose one of: {known}")
    return key


def get_placement(name: str | None) -> str:
    key = (name or "auto").strip().lower()
    if key not in PLACEMENTS:
        known = ", ".join(PLACEMENTS)
        raise SystemExit(f"Unknown placement {name!r}. Choose one of: {known}")
    return key


def strength_scale(name: str) -> float:
    return {"low": 0.55, "medium": 1.0, "high": 1.55}[get_strength(name)]


def all_font_files(style: dict) -> list[str]:
    files = list(style.get("font_files") or [])
    for rel in style.get("display_font_files") or []:
        if rel not in files:
            files.append(rel)
    return files


def resolve_palette(color: str | None) -> dict | None:
    """Return a palette dict from a name or #hex, or None if color is empty."""
    if not color or not str(color).strip():
        return None
    key = str(color).strip().lower().replace(" ", "-")
    if key in PALETTES:
        return copy.deepcopy(PALETTES[key])
    rgb = parse_hex(str(color))
    if rgb:
        pal = palette_from_rgb(*rgb, name=f"#{rgb[0]:02X}{rgb[1]:02X}{rgb[2]:02X}")
        pal["label"] = pal["name"]
        return pal
    known = ", ".join(PALETTES)
    raise SystemExit(f"Unknown color {color!r}. Choose a palette ({known}) or a hex like #C9A36A.")


def apply_color(style: dict, color: str | None) -> dict:
    """Overlay a named palette or hex onto a style copy."""
    out = copy.deepcopy(style)
    pal = resolve_palette(color)
    if pal:
        for key in ("primary", "highlight", "outline", "glow", "back", "box_color"):
            if pal.get(key):
                out[key] = pal[key]
        out["palette"] = pal.get("name")
    if out.get("karaoke"):
        sung = out.get("highlight") or out.get("primary")
        unsung = dim_ass(sung or out.get("primary") or "&H00FFFFFF", 0.52)
        out["secondary"] = unsung
        out["primary"] = sung
    return out


def list_styles() -> list[dict]:
    items = []
    for key, style in STYLES.items():
        items.append(
            {
                "id": key,
                "label": style.get("label") or key,
                "blurb": style.get("blurb") or "",
                "family": style.get("family") or "",
                "animation": style.get("default_animation") or "",
            }
        )
    return items


def list_palettes() -> list[dict]:
    items = []
    for key, pal in PALETTES.items():
        items.append({"id": key, "label": pal.get("label") or key, "swatch": pal.get("swatch")})
    return items


LANGUAGES = {
    "auto": "Detect automatically",
    "en": "English",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "it": "Italian",
    "pt": "Portuguese",
    "ar": "Arabic",
    "he": "Hebrew",
    "hi": "Hindi",
    "ru": "Russian",
    "el": "Greek",
    "zh": "Chinese",
    "ja": "Japanese",
    "ko": "Korean",
}

# Extra fonts staged so other scripts can render (Noto, OFL). CJK is a system TTC symlink.
SCRIPT_FONTS = {
    "ar": ["noto-naskh/NotoNaskhArabic-Regular.ttf", "noto-arabic/NotoSansArabic-Regular.ttf"],
    "he": ["noto-hebrew/NotoSansHebrew-Regular.ttf"],
    "hi": ["noto-devanagari/NotoSansDevanagari-Regular.ttf"],
    "ru": ["noto-sans/NotoSans-Regular.ttf", "noto-sans/NotoSans-Bold.ttf"],
    "el": ["noto-sans/NotoSans-Regular.ttf", "noto-sans/NotoSans-Bold.ttf"],
    "zh": ["noto-cjk/NotoSerifCJK-Regular.ttc"],
    "ja": ["noto-cjk/NotoSerifCJK-Regular.ttc"],
    "ko": ["noto-cjk/NotoSerifCJK-Regular.ttc"],
}

FALLBACK_FONTS = [
    "noto-sans/NotoSans-Regular.ttf",
    "noto-sans/NotoSans-Bold.ttf",
    "noto-serif/NotoSerif-Regular.ttf",
]


def get_language(name: str | None) -> str:
    key = (name or "auto").strip().lower()
    if key in ("", "none"):
        key = "auto"
    if key not in LANGUAGES:
        known = ", ".join(LANGUAGES)
        raise SystemExit(f"Unknown language {name!r}. Choose one of: {known}")
    return key


def script_font_files(lang: str | None) -> list[str]:
    key = get_language(lang)
    files = list(FALLBACK_FONTS)
    for rel in SCRIPT_FONTS.get(key, []):
        if rel not in files:
            files.append(rel)
    return files


def list_languages() -> list[dict]:
    return [{"id": k, "label": v} for k, v in LANGUAGES.items()]


PLACEMENT_LABELS = {
    "auto": "Around the subject",
    "bottom": "Bottom",
    "center": "Center",
    "top": "Top",
    "left": "Left",
    "right": "Right",
    "lower-left": "Lower left",
    "lower-right": "Lower right",
}


def list_placements() -> list[dict]:
    return [{"id": k, "label": PLACEMENT_LABELS.get(k, k)} for k in PLACEMENTS]
