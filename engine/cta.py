"""Animated 'click the link' CTA drawn with ASS vector paths (\\p1)."""

from __future__ import annotations


def cta_events(
    text: str,
    start: float,
    end: float,
    play_x: int,
    play_y: int,
    fill: str = "&H00C8A012",
    ink: str = "&H00FFFFFF",
    outline: str = "&H00101820",
    ass_time=None,
) -> list[str]:
    """Button + moving pointer + tap ripple, near the lower third / end of the clip."""
    if ass_time is None:
        from captions_ass import ass_time as _at
        ass_time = _at
    label = (text or "Shop now").strip()[:28] or "Shop now"
    bw = max(200, min(play_x - 80, int(len(label) * 28 + 80)))
    bh = 72
    cx = play_x // 2
    cy = int(play_y * 0.78)
    r = 14
    # an7 + positive coordinates so libass anchors from the top-left.
    path = (
        f"m {r} 0 l {bw - r} 0 {bw} {r} {bw} {bh - r} "
        f"{bw - r} {bh} {r} {bh} 0 {bh - r} 0 {r} {r} 0"
    )
    pointer = "m 0 0 l 0 34 8 26 14 42 18 40 11 24 24 24 0 0"
    t0 = start
    t_click = start + max(0.45, (end - start) * 0.45)
    t_rip = min(end, t_click + 0.55)
    ev = []
    bx, by = cx - bw // 2, cy - bh // 2
    ev.append(
        "Dialogue: 5,%s,%s,Default,,0,0,0,,"
        "{\\an7\\pos(%d,%d)\\fs64\\bord2\\shad3\\c%s&\\3c%s&\\p1}%s{\\p0}"
        % (ass_time(t0), ass_time(end), bx, by, fill, outline, path)
    )
    safe = label.replace("{", "\\{").replace("}", "\\}")
    ev.append(
        "Dialogue: 6,%s,%s,Default,,0,0,0,,"
        "{\\an5\\pos(%d,%d)\\fnMontserrat Black\\fs40\\b1\\bord2\\shad0\\c%s&\\3c%s&}%s"
        % (ass_time(t0), ass_time(end), cx, cy, ink, outline, safe)
    )
    x1, y1 = cx - 280, cy - 180
    x2, y2 = cx + 8, cy + 6
    fly = max(0.25, t_click - t0)
    ev.append(
        "Dialogue: 7,%s,%s,Default,,0,0,0,,"
        "{\\an7\\move(%d,%d,%d,%d,0,%d)\\fs64\\bord1\\shad2\\c&H00FFFFFF&\\3c&H00000000&\\p1}%s{\\p0}"
        % (ass_time(t0), ass_time(t_click), x1, y1, x2, y2, int(fly * 1000), pointer)
    )
    ev.append(
        "Dialogue: 7,%s,%s,Default,,0,0,0,,"
        "{\\an7\\pos(%d,%d)\\fs64\\bord1\\shad2\\c&H00FFFFFF&\\3c&H00000000&\\p1}%s{\\p0}"
        % (ass_time(t_click), ass_time(end), x2, y2, pointer)
    )

    def ring(t_a: float, t_b: float, scale0: int, scale1: int, alpha_end: str = "&HFF") -> str:
        import math
        pts = []
        for i in range(12):
            a = i / 12 * 2 * math.pi
            cmd = "m" if i == 0 else "l"
            pts.append("%s %d %d" % (cmd, int(40 + math.cos(a) * 40), int(40 + math.sin(a) * 40)))
        pts.append("l 80 40")
        shape = " ".join(pts)
        dur = max(80, int((t_b - t_a) * 1000))
        return (
            "Dialogue: 4,%s,%s,Default,,0,0,0,,"
            "{\\an7\\pos(%d,%d)\\fs64\\bord2\\shad0\\c&H00000000&\\3c&H00FFFFFF&\\p1"
            "\\fscx%d\\fscy%d\\alpha&H40&\\3a&H40&"
            "\\t(0,%d,\\fscx%d\\fscy%d\\alpha%s\\3a%s)}%s{\\p0}"
            % (
                ass_time(t_a), ass_time(t_b), x2 - 40, y2 - 40,
                scale0, scale0, dur, scale1, scale1, alpha_end, alpha_end, shape,
            )
        )

    ev.append(ring(t_click, t_rip, 40, 180))
    ev.append(ring(t_click + 0.08, min(end, t_rip + 0.12), 30, 220))
    return ev
