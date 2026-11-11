"""Local subject detection and caption placement (CPU only, no cloud).

Prefers OpenCV Haar face detection when available, then motion, then a
simple colour-saliency blob. Falls back to rotating safe zones.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np

# OpenCV is a regular pip dependency in the Space image.

try:
    import cv2  # type: ignore

    _HAS_CV = True
except Exception:
    cv2 = None  # type: ignore
    _HAS_CV = False


def safe_margins(out_w: int, out_h: int, vertical: bool) -> tuple[int, int, int, int]:
    """Return (left, top, right, bottom) safe inset in pixels."""
    if vertical:
        return (int(out_w * 0.07), int(out_h * 0.14), int(out_w * 0.07), int(out_h * 0.16))
    return (int(out_w * 0.06), int(out_h * 0.08), int(out_w * 0.06), int(out_h * 0.10))


def estimate_text_box(text: str, fontsize: int, outline: float = 6.0) -> tuple[int, int]:
    width = int(0.58 * fontsize * max(1, len(text)) + 2 * outline + 24)
    height = int(1.20 * fontsize + 2 * outline + 16)
    return width, height


def cover_crop_frame(frame: np.ndarray, out_w: int, out_h: int) -> np.ndarray:
    h, w = frame.shape[:2]
    scale = max(out_w / w, out_h / h)
    nw, nh = int(round(w * scale)), int(round(h * scale))
    if _HAS_CV:
        resized = cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_AREA)
    else:
        # Nearest-neighbour fallback (rare).
        ys = (np.linspace(0, h - 1, nh)).astype(np.int32)
        xs = (np.linspace(0, w - 1, nw)).astype(np.int32)
        resized = frame[ys][:, xs]
    x0 = max(0, (nw - out_w) // 2)
    y0 = max(0, (nh - out_h) // 2)
    return resized[y0 : y0 + out_h, x0 : x0 + out_w]


def _read_frames(video: Path, out_w: int, out_h: int, fps: float = 5.0) -> tuple[list[np.ndarray], list[float]]:
    import subprocess

    # Decode at a low rate, already colour, then cover-crop in Python so the
    # geometry matches the 720p (or vertical) output frame.
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(video),
        "-vf",
        f"fps={fps}",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
    ]
    proc = subprocess.run(cmd, capture_output=True)
    # Need source width/height to reshape. Probe from ffprobe via a small header frame? 
    # Instead, ask ffmpeg to scale to a known size first then we cover-crop... 
    # Simpler: have ffmpeg do the cover crop.
    return [], []


def read_cover_frames(video: Path, out_w: int, out_h: int, fps: float = 5.0) -> tuple[list[np.ndarray], list[float]]:
    import subprocess

    vf = (
        f"fps={fps},"
        f"scale={out_w}:{out_h}:force_original_aspect_ratio=increase,"
        f"crop={out_w}:{out_h},setsar=1,format=rgb24"
    )
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(video),
        "-vf",
        vf,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
    ]
    proc = subprocess.run(cmd, capture_output=True)
    raw = proc.stdout or b""
    stride = out_w * out_h * 3
    if stride <= 0 or len(raw) < stride:
        return [], []
    n = len(raw) // stride
    frames = []
    times = []
    for i in range(n):
        buf = np.frombuffer(raw, dtype=np.uint8, count=stride, offset=i * stride)
        frames.append(buf.reshape(out_h, out_w, 3).copy())
        times.append(i / fps)
    return frames, times



from paths import HAAR as _HAAR, YUNET as _YUNET  # noqa: E402
_yunet_det = None


def _yunet(frame):
    """OpenCV YuNet face detector (CPU). Cached per process."""
    global _yunet_det
    if not _HAS_CV or not _YUNET.is_file():
        return []
    h, w = frame.shape[:2]
    try:
        if _yunet_det is None:
            _yunet_det = cv2.FaceDetectorYN_create(str(_YUNET), "", (w, h), score_threshold=0.6, nms_threshold=0.3, top_k=5)
        _yunet_det.setInputSize((w, h))
        # YuNet expects BGR
        bgr = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR) if frame.shape[2] == 3 else frame
        _retval, faces = _yunet_det.detect(bgr)
        if faces is None or len(faces) == 0:
            return []
        # faces: x, y, w, h, ...
        return [(int(r[0]), int(r[1]), int(r[2]), int(r[3])) for r in faces]
    except Exception:
        return []


def _faces(frame: np.ndarray) -> list[tuple[int, int, int, int]]:
    hits = _yunet(frame)
    if hits:
        return hits
    # Haar was removed from some OpenCV 5 builds; try it only if the API exists.
    try:
        if not _HAS_CV or not hasattr(cv2, "CascadeClassifier") or not _HAAR.is_file():
            return []
        casc = cv2.CascadeClassifier(str(_HAAR))
        if casc.empty():
            return []
        gray = cv2.cvtColor(frame, cv2.COLOR_RGB2GRAY)
        found = casc.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(48, 48))
        return [(int(x), int(y), int(w), int(h)) for (x, y, w, h) in found]
    except Exception:
        return []


def _motion_bbox(prev: np.ndarray, cur: np.ndarray) -> tuple[int, int, int, int] | None:
    a = prev.astype(np.int16)
    b = cur.astype(np.int16)
    diff = np.abs(a - b).mean(axis=2)
    thresh = max(18.0, float(np.percentile(diff, 88)))
    mask = diff >= thresh
    if mask.mean() < 0.004 or mask.mean() > 0.45:
        return None
    ys, xs = np.where(mask)
    if len(xs) < 80:
        return None
    x0, x1 = int(xs.min()), int(xs.max())
    y0, y1 = int(ys.min()), int(ys.max())
    # Tighten to the densest region using a centroid box if the span is huge.
    cy, cx = int(ys.mean()), int(xs.mean())
    if (x1 - x0) * (y1 - y0) > 0.22 * prev.shape[0] * prev.shape[1]:
        h, w = prev.shape[:2]
        bw, bh = max(80, int(0.22 * w)), max(80, int(0.28 * h))
        x0, y0 = max(0, cx - bw // 2), max(0, cy - bh // 2)
        x1, y1 = min(w - 1, x0 + bw), min(h - 1, y0 + bh)
    return x0, y0, x1 - x0, y1 - y0


def _saliency_bbox(frame: np.ndarray) -> tuple[int, int, int, int] | None:
    # Bright, saturated regions that stand out from the median colour.
    img = frame.astype(np.float32)
    mean = img.reshape(-1, 3).mean(axis=0)
    sat = img.max(axis=2) - img.min(axis=2)
    lum = img.mean(axis=2)
    dist = np.sqrt(((img - mean) ** 2).sum(axis=2))
    score = dist + 0.6 * sat + 0.25 * lum
    thresh = float(np.percentile(score, 92))
    mask = score >= thresh
    if mask.mean() < 0.003:
        return None
    ys, xs = np.where(mask)
    if len(xs) < 40:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max() - xs.min()), int(ys.max() - ys.min())


def detect_subjects(frames: list[np.ndarray], times: list[float]) -> list[dict]:
    """One detection record per sampled frame: {t, bbox, kind}."""
    out = []
    prev = None
    for t, frame in zip(times, frames):
        kind = "none"
        bbox = None
        faces = _faces(frame)
        if faces:
            # Largest face.
            bbox = max(faces, key=lambda b: b[2] * b[3])
            kind = "face"
        if bbox is None and prev is not None:
            bbox = _motion_bbox(prev, frame)
            if bbox is not None:
                kind = "motion"
        if bbox is None:
            bbox = _saliency_bbox(frame)
            if bbox is not None:
                kind = "saliency"
        if bbox is not None:
            x, y, bw, bh = bbox
            area = bw * bh
            frame_area = frame.shape[0] * frame.shape[1]
            if area < 0.35 * frame_area and bw >= 28 and bh >= 28:
                out.append({"t": t, "bbox": bbox, "kind": kind})
        prev = frame
    return out


def subject_at(detections: list[dict], t: float) -> dict | None:
    if not detections:
        return None
    return min(detections, key=lambda d: abs(d["t"] - t))


def project_bbox(bbox: tuple[int, int, int, int], t: float, plan: dict | None, out_w: int, out_h: int) -> tuple[int, int, int, int]:
    """Map a cover-crop bbox into the post-Ken-Burns output frame."""
    if not plan:
        return bbox
    from effects import camera_window

    zoom, x0, y0, cw, ch = camera_window(t, plan, out_w, out_h)
    sx, sy, sw, sh = bbox
    # Intersection in crop space, then scale to the output.
    rx = (sx - x0) * (out_w / max(1, cw))
    ry = (sy - y0) * (out_h / max(1, ch))
    rw = sw * (out_w / max(1, cw))
    rh = sh * (out_h / max(1, ch))
    return int(rx), int(ry), int(rw), int(rh)


def _zone(out_w, out_h, left, top, right, bottom, name: str) -> tuple[int, int, int]:
    cx = (left + out_w - right) // 2
    mid_y = (top + out_h - bottom) // 2
    low_y = out_h - bottom - 8
    high_y = top + int(0.18 * out_h)
    if name == "bottom":
        return cx, low_y, 2
    if name == "center":
        return cx, mid_y, 5
    if name == "top":
        return cx, high_y, 8
    if name == "left":
        return left + int(0.30 * (out_w - left - right)), mid_y, 5
    if name == "right":
        return out_w - right - int(0.30 * (out_w - left - right)), mid_y, 5
    if name == "lower-left":
        return left + int(0.32 * (out_w - left - right)), low_y - 10, 2
    if name == "lower-right":
        return out_w - right - int(0.32 * (out_w - left - right)), low_y - 10, 2
    return cx, low_y, 2


def _overlap(ax, ay, aw, ah, box) -> float:
    if box is None:
        return 0.0
    bx, by, bw, bh = box
    x0, y0 = max(ax, bx), max(ay, by)
    x1, y1 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    inter = max(0, x1 - x0) * max(0, y1 - y0)
    return inter / max(1, aw * ah)


def _candidates_near_subject(box, tw, th, out_w, out_h, left, top, right, bottom, prefer: str):
    sx, sy, sw, sh = box
    scx, scy = sx + sw / 2, sy + sh / 2
    gap = 18
    opts = {
        "right": (int(sx + sw + gap + tw / 2), int(scy), 5),
        "left": (int(sx - gap - tw / 2), int(scy), 5),
        "above": (int(scx), int(sy - gap - th / 2), 2),
        "below": (int(scx), int(sy + sh + gap + th / 2), 8),
    }
    order = [prefer, "right", "left", "above", "below"]
    seen = []
    for name in order:
        if name in seen or name not in opts:
            continue
        seen.append(name)
        yield name, opts[name]


def plan_placements(
    groups: list[list[dict]],
    detections: list[dict],
    out_w: int,
    out_h: int,
    vertical: bool,
    mode: str,
    fontsize: int,
    plan: dict | None = None,
) -> list[dict]:
    """Return one {x, y, an, zone, subject_kind} per caption group."""
    left, top, right, bottom = safe_margins(out_w, out_h, vertical)
    mode = (mode or "auto").lower()
    fallback_cycle = ["bottom", "right", "top", "left", "lower-right", "lower-left"]
    prefer_cycle = ["right", "above", "left", "below"]
    results = []
    for i, group in enumerate(groups):
        text = " ".join(w["text"] for w in group)
        tw, th = estimate_text_box(text, fontsize)
        t = group[0]["start"]
        if mode == "bottom":
            x, y, an = _zone(out_w, out_h, left, top, right, bottom, "bottom")
            results.append({"x": x, "y": y, "an": an, "zone": "bottom", "subject_kind": "forced"})
            continue
        if mode == "center":
            x, y, an = _zone(out_w, out_h, left, top, right, bottom, "center")
            results.append({"x": x, "y": y, "an": an, "zone": "center", "subject_kind": "forced"})
            continue
        if mode in {"top", "left", "right", "lower-left", "lower-right"}:
            x, y, an = _zone(out_w, out_h, left, top, right, bottom, mode)
            results.append({"x": x, "y": y, "an": an, "zone": mode, "subject_kind": "forced"})
            continue
        det = subject_at(detections, t)
        box = None
        kind = "none"
        if det and det.get("bbox"):
            box = project_bbox(det["bbox"], t, plan, out_w, out_h)
            kind = det.get("kind", "subject")
        chosen = None
        if box is not None:
            prefer = prefer_cycle[i % len(prefer_cycle)]
            for zone, (x, y, an) in _candidates_near_subject(box, tw, th, out_w, out_h, left, top, right, bottom, prefer):
                # Text box around the anchor depending on alignment.
                ax, ay = _box_origin(x, y, tw, th, an)
                if ax < left or ay < top or ax + tw > out_w - right or ay + th > out_h - bottom:
                    # Clamp if only slightly out, otherwise skip.
                    ax = min(max(ax, left), out_w - right - tw)
                    ay = min(max(ay, top), out_h - bottom - th)
                    x, y = _box_anchor(ax, ay, tw, th, an)
                if _overlap(ax, ay, tw, th, box) > 0.12:
                    continue
                chosen = (x, y, an, zone)
                break
        if chosen is None:
            zone = fallback_cycle[i % len(fallback_cycle)]
            x, y, an = _zone(out_w, out_h, left, top, right, bottom, zone)
            chosen = (x, y, an, zone)
            if kind == "none":
                kind = "zone"
        x, y, an, zone = chosen
        results.append({"x": int(x), "y": int(y), "an": int(an), "zone": zone, "subject_kind": kind})
    return results


def _box_origin(x, y, tw, th, an) -> tuple[int, int]:
    # Top-left of the text box given a \pos anchor and \an value.
    if an == 2:  # bottom-centre
        return int(x - tw / 2), int(y - th)
    if an == 8:  # top-centre
        return int(x - tw / 2), int(y)
    if an == 5:  # centre
        return int(x - tw / 2), int(y - th / 2)
    if an == 4:  # left-middle
        return int(x), int(y - th / 2)
    if an == 6:  # right-middle
        return int(x - tw), int(y - th / 2)
    return int(x - tw / 2), int(y - th / 2)


def _box_anchor(ax, ay, tw, th, an) -> tuple[int, int]:
    if an == 2:
        return int(ax + tw / 2), int(ay + th)
    if an == 8:
        return int(ax + tw / 2), int(ay)
    if an == 5:
        return int(ax + tw / 2), int(ay + th / 2)
    if an == 4:
        return int(ax), int(ay + th / 2)
    if an == 6:
        return int(ax + tw), int(ay + th / 2)
    return int(ax + tw / 2), int(ay + th / 2)
