"""Original video effects driven by word timing and local audio analysis.

Ken Burns zoom/pan, camera sway, punch-in zooms, pause/cut flash-whip, and
optional beat-synced zooms are generated as ffmpeg sendcmd + crop/eq/rotate
filters. No third-party overlays.
"""

from __future__ import annotations

import math
import re
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf

from captions_ass import is_sentence_end


def even(n: int | float) -> int:
    n = int(round(n))
    return n if n % 2 == 0 else n - 1


def load_mono(path: Path) -> tuple[np.ndarray, int]:
    y, sr = sf.read(str(path), always_2d=True)
    return y.mean(axis=1).astype(np.float64), int(sr)


def rms_envelope(y: np.ndarray, sr: int, hop=0.02, win=0.05) -> tuple[np.ndarray, np.ndarray]:
    hop_n = max(1, int(sr * hop))
    win_n = max(hop_n, int(sr * win))
    if len(y) < win_n:
        return np.array([0.0]), np.array([0.0])
    n = 1 + (len(y) - win_n) // hop_n
    rms = np.empty(n, dtype=np.float64)
    for i in range(n):
        frame = y[i * hop_n : i * hop_n + win_n]
        rms[i] = math.sqrt(float(np.mean(frame * frame)) + 1e-12)
    times = (np.arange(n) * hop_n + win_n / 2) / sr
    return times, rms


def spectral_flux_onsets(y: np.ndarray, sr: int, hop=512, win=1024, min_gap=0.48) -> list[float]:
    if len(y) < win:
        return []
    window = np.hanning(win)
    n_frames = 1 + (len(y) - win) // hop
    flux = np.zeros(n_frames, dtype=np.float64)
    prev = None
    for i in range(n_frames):
        frame = y[i * hop : i * hop + win] * window
        mag = np.abs(np.fft.rfft(frame))
        if prev is not None:
            flux[i] = float(np.sum(np.maximum(0.0, mag - prev)))
        prev = mag
    if flux.max() <= 0:
        return []
    # High-pass the flux slightly, then pick peaks above a robust threshold.
    med = float(np.median(flux))
    mad = float(np.median(np.abs(flux - med))) + 1e-9
    thresh = med + 4.2 * mad
    times = []
    last = -999.0
    for i in range(1, n_frames - 1):
        t = (i * hop + win / 2) / sr
        if flux[i] >= thresh and flux[i] >= flux[i - 1] and flux[i] >= flux[i + 1]:
            if t - last >= min_gap:
                times.append(float(t))
                last = t
    return times


def word_rms(words: list[dict], times: np.ndarray, rms: np.ndarray) -> list[float]:
    values = []
    for w in words:
        mask = (times >= w["start"]) & (times <= w["end"])
        values.append(float(rms[mask].mean()) if mask.any() else 0.0)
    return values


def detect_scene_cuts(video: Path, threshold=0.42) -> list[float]:
    """Return timestamps where ffmpeg's scene score exceeds threshold."""
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-i",
        str(video),
        "-filter:v",
        f"select='gt(scene,{threshold})',showinfo",
        "-an",
        "-f",
        "null",
        "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    times = []
    for match in re.finditer(r"pts_time:([0-9.]+)", proc.stderr or ""):
        t = float(match.group(1))
        if t > 0.12:
            times.append(t)
    return _dedupe(times, 0.35)


def _dedupe(times: list[float], gap: float) -> list[float]:
    out = []
    last = -999.0
    for t in sorted(times):
        if t - last >= gap:
            out.append(t)
            last = t
    return out


def _overlap(t: float, windows: list[tuple[float, float]]) -> bool:
    return any(a - 0.05 <= t <= b + 0.05 for a, b in windows)


CAMERA = {
    "low": {"z0": 1.12, "z1": 1.22, "sway": 18.0, "rot_deg": 1.0, "punch": 0.12, "punch_s": 0.16, "beat": 0.07, "work": 1.45, "seg": 5.0, "whip_px": 90.0, "whip_z": 0.10},
    "medium": {"z0": 1.20, "z1": 1.36, "sway": 42.0, "rot_deg": 2.2, "punch": 0.16, "punch_s": 0.22, "beat": 0.10, "work": 1.55, "seg": 3.8, "whip_px": 140.0, "whip_z": 0.14},
    "high": {"z0": 1.26, "z1": 1.50, "sway": 62.0, "rot_deg": 3.4, "punch": 0.22, "punch_s": 0.30, "beat": 0.14, "work": 1.62, "seg": 3.2, "whip_px": 180.0, "whip_z": 0.18},
}

# Corner-to-corner pan anchors (fractions of the leftover crop margin).
_PAN_PATHS = (
    (0.12, 0.18, 0.88, 0.82),
    (0.88, 0.20, 0.14, 0.84),
    (0.18, 0.86, 0.86, 0.16),
    (0.86, 0.84, 0.14, 0.18),
)


def work_dims(out_w: int, out_h: int, strength: str) -> tuple[int, int]:
    scale = CAMERA[strength]["work"]
    return even(out_w * scale), even(out_h * scale)


def mark_emphasis(words: list[dict], audio_path: Path) -> list[dict]:
    """Flag long, loud, or sentence-starting words for punch-ins and shake-word."""
    try:
        y, sr = load_mono(audio_path)
        times, rms = rms_envelope(y, sr)
        energies = word_rms(words, times, rms)
    except Exception:
        energies = [0.0] * len(words)
    cut = float(np.quantile([e for e in energies if e > 0], 0.72)) if any(energies) else 0.0
    for i, w in enumerate(words):
        sentence = i == 0 or is_sentence_end(words[i - 1]["text"])
        longish = (w["end"] - w["start"]) >= 0.32 or len(re.sub(r"\W", "", w["text"])) >= 7
        loud = energies[i] >= cut and energies[i] > 0
        w["emphasized"] = bool(sentence or (longish and loud) or loud)
        w["energy"] = energies[i]
    return words


def _camera_segments(duration: float, pauses: list[float], cfg: dict) -> list[dict]:
    bounds = [0.0]
    for t in pauses:
        if 0.8 < t < duration - 0.6:
            bounds.append(t)
    bounds.append(duration)
    bounds = sorted(set(bounds))
    # Split long spans so direction can alternate often enough to stay interesting.
    max_len = float(cfg["seg"])
    cuts = [0.0]
    for a, b in zip(bounds, bounds[1:]):
        span = b - a
        if span <= max_len + 0.2:
            cuts.append(b)
            continue
        n = max(2, int(math.ceil(span / max_len)))
        for i in range(1, n):
            cuts.append(a + span * i / n)
        cuts.append(b)
    cuts = sorted(set(round(c, 4) for c in cuts))
    segs = []
    for i, (a, b) in enumerate(zip(cuts, cuts[1:])):
        if b - a < 0.2:
            continue
        ax0, ay0, ax1, ay1 = _PAN_PATHS[i % len(_PAN_PATHS)]
        # Alternate zoom in / zoom out each segment.
        if i % 2 == 0:
            z0, z1 = cfg["z0"], cfg["z1"]
        else:
            z0, z1 = cfg["z1"], cfg["z0"]
        segs.append({"start": a, "end": b, "z0": z0, "z1": z1, "ax0": ax0, "ay0": ay0, "ax1": ax1, "ay1": ay1})
    return segs


def plan_effects(
    words: list[dict],
    audio_path: Path,
    video_path: Path,
    duration: float,
    beat_sync: bool = True,
    motion_strength: str = "medium",
) -> dict:
    strength = motion_strength if motion_strength in CAMERA else "medium"
    cfg = CAMERA[strength]
    y, sr = load_mono(audio_path)
    times, rms = rms_envelope(y, sr)
    mean = float(rms.mean()) if len(rms) else 0.0
    std = float(rms.std()) if len(rms) else 0.0
    energies = word_rms(words, times, rms)
    energy_cut = float(np.quantile(energies, 0.72)) if energies else 0.0

    zooms = []
    used = []
    for i, w in enumerate(words):
        sentence = i == 0 or is_sentence_end(words[i - 1]["text"])
        longish = (w["end"] - w["start"]) >= 0.32 or len(re.sub(r"\W", "", w["text"])) >= 7
        loud = energies[i] >= energy_cut and energies[i] > 0
        if not (sentence or loud or (longish and loud)):
            continue
        if _overlap(w["start"], used):
            continue
        start = max(0.0, w["start"] - 0.04)
        hold_end = min(duration, max(w["end"], start + 0.50))
        end = min(duration, hold_end + 0.28)
        bonus = cfg["punch_s"] if sentence else cfg["punch"]
        zooms.append({"start": start, "hold": min(start + 0.20, hold_end), "hold_end": hold_end, "end": end, "bonus": bonus, "kind": "punch"})
        used.append((start, end))

    pauses = []
    for i in range(len(words) - 1):
        gap = words[i + 1]["start"] - words[i]["end"]
        if gap >= 0.38:
            pauses.append(words[i]["end"] + min(0.06, gap / 2))

    cuts = []
    try:
        cuts = detect_scene_cuts(video_path)
    except Exception:
        cuts = []

    marks = _dedupe(pauses + cuts, 0.8)
    whips = []
    flashes = []
    direction = 1
    for t in marks:
        if t < 0.15 or t > duration - 0.12:
            continue
        end = min(duration, t + 0.20)
        whips.append({"start": t, "end": end, "direction": direction, "pixels": cfg["whip_px"], "bonus": cfg["whip_z"]})
        flashes.append({"start": t, "end": min(duration, t + 0.09), "amount": 0.30})
        direction *= -1

    if beat_sync:
        onsets = spectral_flux_onsets(y, sr)
        for t in onsets:
            if t < 0.2 or t > duration - 0.15:
                continue
            if _overlap(t, used) or any(abs(t - w["start"]) < 0.2 for w in whips):
                continue
            end = min(duration, t + 0.24)
            zooms.append({"start": t, "hold": t + 0.08, "hold_end": t + 0.12, "end": end, "bonus": cfg["beat"], "kind": "beat"})
            used.append((t, end))

    camera = {
        "strength": strength,
        "sway": cfg["sway"],
        "rot_deg": cfg["rot_deg"],
        "work": cfg["work"],
        "segments": _camera_segments(duration, pauses, cfg),
    }
    return {"zooms": zooms, "whips": whips, "flashes": flashes, "camera": camera}


def _ease_in_out(t: float) -> float:
    t = max(0.0, min(1.0, t))
    return 3 * t * t - 2 * t * t * t


def _ease_out(t: float) -> float:
    t = max(0.0, min(1.0, t))
    return 1 - (1 - t) ** 3


def _bonus_at(t: float, z: dict) -> float:
    if t < z["start"] or t > z["end"]:
        return 0.0
    bonus = float(z.get("bonus") or 0.0)
    if t <= z["hold"]:
        p = _ease_out((t - z["start"]) / max(1e-3, z["hold"] - z["start"]))
        return bonus * p
    if t <= z["hold_end"]:
        return bonus
    p = _ease_in_out((t - z["hold_end"]) / max(1e-3, z["end"] - z["hold_end"]))
    return bonus * (1.0 - p)


def _camera_at(t: float, plan: dict) -> tuple[float, float, float, float]:
    """Return (zoom, ax, ay, angle_radians) for the Ken Burns path plus sway."""
    cam = plan["camera"]
    segs = cam["segments"] or [{"start": 0.0, "end": 1.0, "z0": 1.2, "z1": 1.2, "ax0": 0.5, "ay0": 0.5, "ax1": 0.5, "ay1": 0.5}]
    seg = segs[-1]
    for item in segs:
        if item["start"] <= t <= item["end"] or t < item["end"]:
            if t <= item["end"]:
                seg = item
                if t >= item["start"]:
                    break
    span = max(1e-3, seg["end"] - seg["start"])
    p = _ease_in_out((t - seg["start"]) / span)
    zoom = seg["z0"] + (seg["z1"] - seg["z0"]) * p
    ax = seg["ax0"] + (seg["ax1"] - seg["ax0"]) * p
    ay = seg["ay0"] + (seg["ay1"] - seg["ay0"]) * p
    sway = float(cam["sway"])
    # Slow sines; periods do not beat with 30 fps in an obvious way.
    ax_px_phase = math.sin(2 * math.pi * t / 2.85)
    ay_px_phase = math.sin(2 * math.pi * t / 3.40 + 0.6)
    rot = math.radians(float(cam["rot_deg"])) * math.sin(2 * math.pi * t / 4.20)
    return zoom, ax, ay, ax_px_phase * sway, ay_px_phase * sway * 0.75, rot


def _sample(t: float, plan: dict, work_w: int, work_h: int) -> tuple[float, float, float, float, float]:
    zoom, ax, ay, sx, sy, angle = _camera_at(t, plan)
    for z in plan["zooms"]:
        zoom += _bonus_at(t, z)
    for w in plan["whips"]:
        if w["start"] <= t <= w["end"]:
            p = _ease_out((t - w["start"]) / max(1e-3, w["end"] - w["start"]))
            fade = 1.0 - p
            sx += w["direction"] * w["pixels"] * fade
            zoom += w.get("bonus", 0.10) * fade
    zoom = min(max(zoom, 1.08), 1.72)
    bright = 0.0
    for f in plan["flashes"]:
        if f["start"] <= t <= f["end"]:
            u = (t - f["start"]) / max(1e-3, f["end"] - f["start"])
            bright = max(bright, f["amount"] * (1.0 - _ease_out(u)))
    return zoom, ax, ay, sx, sy, angle, bright



def camera_window(t: float, plan: dict, out_w: int, out_h: int) -> tuple[float, int, int, int, int]:
    """Return (zoom, crop_x, crop_y, crop_w, crop_h) on the cover-cropped output frame."""
    zoom, ax, ay, sx, sy, _angle, _bright = _sample(t, plan, out_w, out_h)
    zoom = min(max(zoom, 1.08), 1.72)
    cw = even(out_w / zoom)
    ch = even(out_h / zoom)
    cw = max(2, min(out_w, cw))
    ch = max(2, min(out_h, ch))
    mx, my = out_w - cw, out_h - ch
    x = int(round(ax * mx + sx))
    y = int(round(ay * my + sy))
    x = max(0, min(mx, x))
    y = max(0, min(my, y))
    return zoom, x, y, cw, ch


def _ff_expr(s: str) -> str:
    # Commas and colons are special inside an ffmpeg filtergraph.
    return s.replace("\\", "\\\\").replace(":", r"\:").replace(",", r"\,")


def _ease_expr(t: str, s: float, e: float) -> str:
    span = max(1e-3, e - s)
    p = f"min(max(({t}-({s:.4f}))/({span:.4f}),0),1)"
    return f"({p})*({p})*(3-2*({p}))"


def _bonus_expr(t: str, z: dict) -> str:
    s, h, he, e = z["start"], z["hold"], z["hold_end"], z["end"]
    bonus = float(z.get("bonus") or 0.0)
    span_a = max(1e-3, h - s)
    pa = f"min(max(({t}-({s:.4f}))/({span_a:.4f}),0),1)"
    rise = f"(1-pow(1-({pa}),3))*({bonus:.4f})"
    fall = f"(1-({_ease_expr(t, he, e)}))*({bonus:.4f})"
    return (
        f"if(lt({t},{s:.4f}),0,if(lte({t},{h:.4f}),{rise},"
        f"if(lte({t},{he:.4f}),{bonus:.4f},if(lte({t},{e:.4f}),{fall},0))))"
    )


def _segment_zoom_expr(t: str, segs: list[dict]) -> str:
    expr = f"{(segs[-1]['z1'] if segs else 1.2):.4f}"
    for seg in reversed(segs):
        inner = _ease_expr(t, seg["start"], seg["end"])
        body = f"({seg['z0']:.4f})+(({seg['z1']:.4f})-({seg['z0']:.4f}))*({inner})"
        expr = f"if(between({t},{seg['start']:.4f},{seg['end']:.4f}),{body},{expr})"
    return expr


def _segment_anchor_expr(t: str, segs: list[dict], axis: str) -> str:
    key0, key1 = ("ax0", "ax1") if axis == "x" else ("ay0", "ay1")
    expr = f"{(segs[-1][key1] if segs else 0.5):.4f}"
    for seg in reversed(segs):
        inner = _ease_expr(t, seg["start"], seg["end"])
        body = f"({seg[key0]:.4f})+(({seg[key1]:.4f})-({seg[key0]:.4f}))*({inner})"
        expr = f"if(between({t},{seg['start']:.4f},{seg['end']:.4f}),{body},{expr})"
    return expr


def camera_filter(plan: dict, out_w: int, out_h: int) -> str:
    """Continuous Ken Burns + punch-ins as crop/rotate/eq expressions (no sendcmd)."""
    import math as _math
    t = "if(isnan(t),0,t)"
    cam = plan.get("camera") or {}
    segs = cam.get("segments") or []
    z = _segment_zoom_expr(t, segs)
    for item in plan.get("zooms") or []:
        z = f"({z})+({_bonus_expr(t, item)})"
    whip_z = "0"
    whip_x = "0"
    for w in plan.get("whips") or []:
        span = max(1e-3, w["end"] - w["start"])
        fade = f"(1-min(max(({t}-({w['start']:.4f}))/({span:.4f}),0),1))"
        fade3 = f"pow({fade},3)"
        whip_z = f"({whip_z})+if(between({t},{w['start']:.4f},{w['end']:.4f}),({w.get('bonus', 0.1):.4f})*({fade3}),0)"
        whip_x = f"({whip_x})+if(between({t},{w['start']:.4f},{w['end']:.4f}),({w['direction']})*({w['pixels']:.1f})*({fade3}),0)"
    z = f"min(max(({z})+({whip_z}),1.08),1.70)"
    sway = float(cam.get("sway") or 0.0)
    rot = float(cam.get("rot_deg") or 0.0)
    ax = _segment_anchor_expr(t, segs, "x")
    ay = _segment_anchor_expr(t, segs, "y")
    sx = f"({sway:.2f})*sin(2*PI*({t})/2.85)+({whip_x})"
    sy = f"({sway:.2f}*0.75)*sin(2*PI*({t})/3.40+0.6)"
    wexpr = f"trunc({out_w}/({z})/2)*2"
    hexpr = f"trunc({out_h}/({z})/2)*2"
    xexpr = f"min(max(({ax})*({out_w}-({wexpr}))+({sx}),0),{out_w}-({wexpr}))"
    yexpr = f"min(max(({ay})*({out_h}-({hexpr}))+({sy}),0),{out_h}-({hexpr}))"
    rot_expr = f"{_math.radians(rot):.5f}*sin(2*PI*({t})/4.20)"
    parts = []
    if rot >= 0.4:
        parts.append(f"rotate=a='{_ff_expr(rot_expr)}':ow=iw:oh=ih:c=black")
    parts.append(
        f"crop=w='{_ff_expr(wexpr)}':h='{_ff_expr(hexpr)}':x='{_ff_expr(xexpr)}':y='{_ff_expr(yexpr)}'"
    )
    parts.append(f"scale={out_w}:{out_h}:flags=bicubic")
    flashes = plan.get("flashes") or []
    if flashes:
        enable = "+".join(f"between(t,{f['start']:.3f},{f['end']:.3f})" for f in flashes)
        amt = max(f["amount"] for f in flashes)
        parts.append(f"eq=brightness={amt:.3f}:enable='{_ff_expr(enable)}'")
    parts.append("setsar=1")
    return ",".join(parts)


def write_sendcmd(
    path: Path,
    plan: dict,
    out_w: int,
    out_h: int,
    duration: float,
    fps: int = 30,
) -> Path:
    work_w, work_h = work_dims(out_w, out_h, plan.get("camera", {}).get("strength", "medium"))
    lines = ["# auto-edit Ken Burns + punch-in / whip / flash keyframes"]
    dt = 1.0 / max(24, int(fps))
    last = None
    t = 0.0
    # Inclusive coverage of the whole clip so the camera never holds still on a stale crop.
    times = []
    while t <= duration + 1e-9:
        times.append(round(t, 4))
        t += dt
    if times[-1] < duration:
        times.append(round(duration, 4))
    for t in times:
        zoom, ax, ay, sx, sy, angle, bright = _sample(t, plan, work_w, work_h)
        crop_w = even(work_w / zoom)
        crop_h = even(work_h / zoom)
        crop_w = max(2, min(work_w, crop_w))
        crop_h = max(2, min(work_h, crop_h))
        mx = work_w - crop_w
        my = work_h - crop_h
        x = int(round(ax * mx + sx))
        y = int(round(ay * my + sy))
        x = max(0, min(mx, x))
        y = max(0, min(my, y))
        state = (crop_w, crop_h, x, y, round(angle, 5), round(bright, 3))
        tw = f"{t:.3f}"
        if last is None:
            lines += [
                f"{tw} [enter] crop@fx w {crop_w};",
                f"{tw} [enter] crop@fx h {crop_h};",
                f"{tw} [enter] crop@fx x {x};",
                f"{tw} [enter] crop@fx y {y};",
                f"{tw} [enter] rotate@fx angle {angle:.5f};",
                f"{tw} [enter] eq@fx brightness {bright:.3f};",
            ]
            last = state
            continue
        if state == last:
            continue
        if state[0] != last[0]:
            lines.append(f"{tw} [enter] crop@fx w {state[0]};")
        if state[1] != last[1]:
            lines.append(f"{tw} [enter] crop@fx h {state[1]};")
        if state[2] != last[2]:
            lines.append(f"{tw} [enter] crop@fx x {state[2]};")
        if state[3] != last[3]:
            lines.append(f"{tw} [enter] crop@fx y {state[3]};")
        if state[4] != last[4]:
            lines.append(f"{tw} [enter] rotate@fx angle {state[4]:.5f};")
        if state[5] != last[5]:
            lines.append(f"{tw} [enter] eq@fx brightness {state[5]:.3f};")
        last = state
    path = Path(path)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def effects_filter(cmd_path: Path, out_w: int, out_h: int, work_w: int, work_h: int) -> str:
    # Upscale for pan/zoom/rotate headroom, then crop back to the 720p frame.
    return (
        f"scale={work_w}:{work_h}:flags=bicubic,"
        f"sendcmd=f={_ff_path(cmd_path)},"
        f"rotate@fx=0:ow={work_w}:oh={work_h}:c=black:bilinear=1,"
        f"crop@fx={out_w}:{out_h}:0:0:exact=0,"
        f"scale={out_w}:{out_h}:flags=bicubic,"
        "eq@fx=brightness=0,"
        "setsar=1"
    )


def _ff_path(path: Path) -> str:
    # Escape characters that are special inside an ffmpeg filtergraph.
    text = str(path.resolve())
    return text.replace("\\", "\\\\").replace(":", r"\:").replace("'", r"\'")
