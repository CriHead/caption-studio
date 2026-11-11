/** Pick a caption spot that stays off faces and subjects, and ease into it. */

const SPOTS = [
  [0.5, 0.1],
  [0.22, 0.14],
  [0.78, 0.14],
  [0.16, 0.42],
  [0.84, 0.42],
  [0.22, 0.86],
  [0.78, 0.86],
  [0.5, 0.93],
];

let smooth = null;

export function resetPlacement() {
  smooth = null;
}

function groupAt(groups, time) {
  for (const group of groups || []) {
    if (time >= group.start && time < group.end) return group;
  }
  return null;
}

function boxesNear(samples, time) {
  const near = (samples || []).filter((sample) => Math.abs(sample.time - time) <= 0.5);
  const chosen = near.length ? near : (samples || []).slice(-1);
  return chosen.flatMap((sample) => sample.boxes || []);
}

function grow(boxes) {
  return boxes.map((box) => ({
    x: Math.max(0, box.x - 0.05),
    y: Math.max(0, box.y - 0.04),
    w: box.w + 0.1,
    h: box.h + 0.14,
  }));
}

function nudge(spot, boxes) {
  let x = spot[0];
  let y = spot[1];
  for (const box of boxes) {
    const hitsX = x + 0.3 > box.x && x - 0.3 < box.x + box.w;
    const hitsY = y + 0.06 > box.y && y - 0.06 < box.y + box.h;
    if (!hitsX || !hitsY) continue;
    const above = box.y - 0.08;
    const below = box.y + box.h + 0.08;
    y = above >= 0.08 ? Math.min(y, above) : Math.max(y, below);
  }
  return [
    Math.min(0.86, Math.max(0.14, x)),
    Math.min(0.94, Math.max(0.08, y)),
  ];
}

function overlap(cx, cy, boxes) {
  const halfW = 0.36;
  const halfH = 0.09;
  let area = 0;
  for (const box of boxes) {
    const left = Math.max(cx - halfW, box.x);
    const right = Math.min(cx + halfW, box.x + box.w);
    const top = Math.max(cy - halfH, box.y);
    const bottom = Math.min(cy + halfH, box.y + box.h);
    if (right > left && bottom > top) area += (right - left) * (bottom - top);
  }
  return area;
}

export function captionPoint(time, groups, samples) {
  const group = groupAt(groups, time);
  const id = group ? group.index : -1;
  const avoid = grow(boxesNear(samples, time));
  const start = group ? Math.abs(group.index) % SPOTS.length : 0;
  let best = nudge(SPOTS[start], avoid);
  let bestScore = Infinity;
  for (let step = 0; step < SPOTS.length; step += 1) {
    const spot = nudge(SPOTS[(start + step) % SPOTS.length], avoid);
    const score = overlap(spot[0], spot[1], avoid) * 20 + step * 0.01;
    if (score < bestScore) {
      bestScore = score;
      best = spot;
    }
  }
  if (!smooth || smooth.id !== id) smooth = { id, x: best[0], y: best[1] };
  smooth.x += (best[0] - smooth.x) * 0.3;
  smooth.y += (best[1] - smooth.y) * 0.3;
  return { x: smooth.x, y: smooth.y };
}
