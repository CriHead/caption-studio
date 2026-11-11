"""Resolve Caption Studio paths without depending on the local tools tree."""

from __future__ import annotations

import os
from pathlib import Path

# engine/ is one level below the Space root.
ROOT = Path(os.environ.get("CAPTION_STUDIO_ROOT", Path(__file__).resolve().parent.parent))
FONTS = Path(os.environ.get("CAPTION_STUDIO_FONTS", ROOT / "fonts"))
MODELS = Path(os.environ.get("CAPTION_STUDIO_MODELS", ROOT / "models"))
YUNET = MODELS / "opencv" / "face_detection_yunet_2023mar.onnx"
HAAR = MODELS / "opencv" / "haarcascade_frontalface_default.xml"
EMOJI_DIR = FONTS / "emoji-png"
WHISPER_ROOT = Path(os.environ.get("WHISPER_DOWNLOAD_ROOT", MODELS / "faster-whisper"))
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "tiny")

# Job scratch: /tmp on a Space, overridable for tests.
_default_jobs = Path(os.environ.get("TMPDIR", "/tmp")) / "caption-studio-jobs"
if Path("/data").is_dir() and not os.environ.get("CAPTION_STUDIO_JOBS"):
    _default_jobs = Path("/data") / "caption-studio-jobs"
JOBS = Path(os.environ.get("CAPTION_STUDIO_JOBS", _default_jobs))


def link_cjk_font() -> Path | None:
    """If the image has Noto CJK from apt, expose it under fonts/noto-cjk/."""
    dest_dir = FONTS / "noto-cjk"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / "NotoSerifCJK-Regular.ttc"
    if dest.is_file() or dest.is_symlink():
        return dest
    candidates = [
        Path("/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc"),
        Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
        Path("/usr/share/fonts/truetype/noto/NotoSerifCJK-Regular.ttc"),
        Path("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"),
    ]
    for src in candidates:
        if src.is_file():
            try:
                dest.symlink_to(src)
            except OSError:
                return None
            return dest
    return None
