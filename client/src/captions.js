/** Word grouping, timing, and animation poses. Pure functions, shared by preview and encode. */

const FILLERS = new Set(
  "a an the and or but to of in on for with at from is are was be it this that as by we you i".split(" "),
);

const LETTER_ANIMS = new Set([
  "cinematic-reveal",
  "typewriter",
  "typewriter-cursor",
  "explode",
  "tumble",
  "bounce-letters",
  "wave",
]);

const COMPLEX_SCRIPT = new Set(["ar", "he", "hi"]);

export function isLetterAnimation(name) {
  return LETTER_ANIMS.has(name);
}

export function wordsFromText(text, duration) {
  const tokens = String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!tokens.length) return [];
  const length = Math.max(1, Number(duration) || 1);
  const lead = 0.15;
  const tail = 0.25;
  const usable = Math.max(0.8, length - lead - tail);
  const slot = usable / tokens.length;
  const hold = Math.max(0.22, slot * 0.86);
  let t = lead;
  return tokens.map((tok) => {
    const start = t;
    let end = Math.min(length - 0.04, t + hold);
    if (end <= start) end = start + 0.18;
    t += slot;
    const bare = tok.replace(/[.,!?;:"']/g, "").toLowerCase();
    return {
      text: tok,
      start: round3(start),
      end: round3(end),
      emphasized: bare.length >= 5 && !FILLERS.has(bare),
    };
  });
}

export function chunksToWords(output, duration) {
  const chunks = Array.isArray(output?.chunks) ? output.chunks : [];
  const words = [];
  chunks.forEach((chunk, index) => {
    const text = String(chunk?.text || "").trim();
    if (!text) return;
    const stamp = chunk.timestamp || [];
    let start = Number(stamp[0]);
    let end = Number(stamp[1]);
    const parts = text.split(/\s+/).filter(Boolean);
    if (!Number.isFinite(start)) start = words.length ? words[words.length - 1].end : 0;
    if (!Number.isFinite(end) || end <= start) {
      const nextStart = Number(chunks[index + 1]?.timestamp?.[0]);
      end = Number.isFinite(nextStart) && nextStart > start
        ? nextStart
        : start + Math.max(0.24, 0.32 * parts.length);
    }
    if (parts.length <= 1) {
      words.push({ text: parts[0] || text, start, end: Math.max(end, start + 0.08) });
      return;
    }
    const slot = (end - start) / parts.length;
    parts.forEach((part, i) => {
      const partStart = start + i * slot;
      words.push({
        text: part,
        start: partStart,
        end: Math.max(partStart + 0.08, partStart + slot * 0.92),
      });
    });
  });
  if (!words.length && output?.text) return wordsFromText(output.text, duration);
  return words.map((word) => ({
    ...word,
    start: round3(word.start),
    end: round3(Math.max(word.end, word.start + 0.08)),
  }));
}

function isSentenceEnd(text) {
  return /[.!?]"?$/.test(String(text || "").trim());
}

export function groupWords(words, wordsPerLine) {
  const limit = Math.max(1, Number(wordsPerLine) || 2);
  const groups = [];
  let current = [];
  for (const word of words) {
    current.push(word);
    if (current.length >= limit || isSentenceEnd(word.text)) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length) groups.push(current);
  return groups.map((group, index, all) => {
    const start = group[0].start;
    const naturalEnd = group[group.length - 1].end;
    const nextStart = all[index + 1]?.[0]?.start;
    const end = nextStart != null ? Math.max(naturalEnd, nextStart) : naturalEnd + 0.22;
    return { words: group, start, end, index, flags: keywordFlags(group) };
  });
}

export function keywordFlags(group) {
  if (group.some((word) => word.emphasized)) return group.map((word) => Boolean(word.emphasized));
  const lengths = group.map((word) => word.text.replace(/[^\p{L}\p{N}]+/gu, "").length);
  const top = Math.max(0, ...lengths);
  if (top >= 4) {
    const flags = group.map(() => false);
    flags[lengths.indexOf(top)] = true;
    return flags;
  }
  return group.map((_word, index) => index === group.length - 1);
}

export function activeGroup(groups, time) {
  for (const group of groups) {
    if (time >= group.start && time < group.end) return group;
  }
  return null;
}

export function anchorFor(placement, width, height, marginV, groupIndex, fallback = "auto") {
  const spots = {
    bottom: [0.5, height - marginV],
    center: [0.5, height * 0.5],
    top: [0.5, marginV + 36],
    left: [width * 0.3, height * 0.5],
    right: [width * 0.7, height * 0.5],
    "lower-left": [width * 0.32, height - marginV],
    "lower-right": [width * 0.68, height - marginV],
  };
  let key = placement || "auto";
  if (key === "auto") {
    if (fallback && fallback !== "auto") key = fallback;
    else {
      const cycle = ["bottom", "center", "lower-left", "lower-right", "top"];
      key = cycle[groupIndex % cycle.length];
    }
  }
  const spot = spots[key] || spots.bottom;
  return { x: spot[0], y: spot[1], key };
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function easeOut(value) {
  const t = clamp01(value);
  return 1 - Math.pow(1 - t, 3);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function ramp(u, duration, from, to) {
  return lerp(from, to, easeOut(duration <= 0 ? 1 : u / duration));
}

/** Whole-line entrance. Times are seconds from the group's start. */
export function linePose(animation, u, span) {
  const pose = { opacity: 1, scaleX: 1, scaleY: 1, x: 0, y: 0, rot: 0, blur: 0, skew: 0 };
  const anim = animation || "fade";
  if (anim === "pop") pose.scaleX = pose.scaleY = ramp(u, 0.14, 0.68, 1);
  else if (anim === "bounce") pose.scaleX = pose.scaleY = keyScale(u, [[0, 0.55], [0.09, 1.28], [0.17, 0.9], [0.23, 1]]);
  else if (anim === "grow") pose.scaleX = pose.scaleY = ramp(u, 0.28, 0.42, 1);
  else if (anim === "shrink") pose.scaleX = pose.scaleY = ramp(u, 0.26, 1.4, 1);
  else if (anim === "zoom-out-in") pose.scaleX = pose.scaleY = keyScale(u, [[0, 1.6], [0.18, 0.88], [0.3, 1]]);
  else if (anim === "elastic") pose.scaleX = pose.scaleY = keyScale(u, [[0, 0.4], [0.14, 1.18], [0.23, 0.9], [0.3, 1.06], [0.36, 1]]);
  else if (anim === "slide-up") pose.y = ramp(u, 0.18, 90, 0);
  else if (anim === "drop-in") {
    pose.y = ramp(u, 0.32, -140, 0);
    pose.opacity = ramp(u, 0.32, 0.75, 1);
  } else if (anim === "rise-up") {
    pose.y = ramp(u, 0.32, 130, 0);
    pose.opacity = ramp(u, 0.32, 0.75, 1);
  } else if (anim === "fade") pose.opacity = ramp(u, 0.15, 0, 1);
  else if (anim === "appear") {
    pose.opacity = ramp(u, 0.22, 0, 1);
    pose.blur = ramp(u, 0.22, 3.5, 0);
  } else if (anim === "blur-focus") {
    pose.blur = ramp(u, 0.34, 7, 0);
    pose.scaleX = pose.scaleY = ramp(u, 0.34, 1.08, 1);
  } else if (anim === "glow") {
    pose.opacity = ramp(u, 0.14, 0.45, 1);
    pose.blur = ramp(u, 0.14, 1.4, 0);
  } else if (anim === "spin-in") {
    pose.rot = ramp(u, 0.36, -160, 0) * Math.PI / 180;
    pose.scaleX = pose.scaleY = ramp(u, 0.36, 0.55, 1);
  } else if (anim === "swing") pose.rot = ramp(u, 0.34, 18, 0) * Math.PI / 180;
  else if (anim === "glitch") Object.assign(pose, glitchPose(u));

  if (anim === "fade" || anim === "appear" || anim === "blur-focus") {
    const fade = Math.min(0.14, Math.max(0.05, span * 0.28));
    const start = Math.max(0, span - fade);
    if (u > start) {
      const p = clamp01((u - start) / fade);
      pose.opacity *= 1 - p;
      if (anim !== "fade") pose.blur = Math.max(pose.blur, 3 * p);
    }
  }
  return pose;
}

function keyScale(u, keys) {
  if (u <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t0, v0] = keys[i - 1];
    const [t1, v1] = keys[i];
    if (u <= t1) {
      const p = t1 === t0 ? 1 : (u - t0) / (t1 - t0);
      return lerp(v0, v1, easeOut(p));
    }
  }
  return keys[keys.length - 1][1];
}

function glitchPose(u) {
  const steps = [
    [0, 0.18, 1.08, 0.96, 0.82],
    [0.04, -0.12, 0.94, 1.08, 1],
    [0.08, 0.08, 1.1, 0.97, 1],
    [0.14, -0.04, 0.98, 1.02, 1],
    [0.2, 0, 1, 1, 1],
  ];
  let prev = steps[0];
  let next = steps[steps.length - 1];
  for (let i = 1; i < steps.length; i++) {
    if (u <= steps[i][0]) {
      prev = steps[i - 1];
      next = steps[i];
      break;
    }
  }
  const span = next[0] - prev[0] || 1;
  const p = clamp01((u - prev[0]) / span);
  return {
    skew: lerp(prev[1], next[1], p),
    scaleX: lerp(prev[2], next[2], p),
    scaleY: lerp(prev[3], next[3], p),
    opacity: lerp(prev[4], next[4], p),
  };
}

export function letterPose(animation, u, span, index) {
  const pose = { opacity: 1, scaleX: 1, scaleY: 1, x: 0, y: 0, rot: 0, reveal: true };
  if (animation === "cinematic-reveal") {
    const delay = index * 0.09;
    pose.opacity = ramp(u - delay, 0.24, 0, 1);
    pose.x = ramp(u - delay, 0.24, 10, 0);
  } else if (animation === "tumble") {
    const delay = index * 0.07;
    pose.y = ramp(u - delay, 0.32, -90, 0);
    pose.rot = ramp(u - delay, 0.32, -75, 0) * Math.PI / 180;
    pose.opacity = ramp(u - delay, 0.32, 0, 1);
  } else if (animation === "bounce-letters") {
    const delay = index * 0.075;
    const local = u - delay;
    pose.opacity = local < 0 ? 0 : ramp(local, 0.16, 0, 1);
    pose.scaleX = keyScale(Math.max(0, local), [[0, 0.7], [0.16, 1]]);
    pose.scaleY = keyScale(Math.max(0, local), [[0, 0.4], [0.16, 1.24], [0.26, 0.88], [0.34, 1.08], [0.42, 1]]);
  } else if (animation === "wave") {
    const phase = index * 0.07;
    pose.scaleY = 1 + 0.16 * Math.sin((2 * Math.PI * (u + phase)) / 0.9);
  } else if (animation === "typewriter" || animation === "typewriter-cursor") {
    const delay = index * 0.07;
    pose.opacity = u + 0.02 >= delay ? 1 : 0;
    pose.reveal = pose.opacity > 0;
  } else if (animation === "explode") {
    const hold = Math.max(0.18, span - 0.42);
    const p = clamp01((u - hold) / Math.max(0.12, span - hold));
    const ang = hash(index + 1) * Math.PI * 2;
    const dist = (90 + (index % 3) * 43) * p * p;
    pose.x = Math.cos(ang) * dist;
    pose.y = Math.sin(ang) * dist * 0.75;
    pose.rot = (hash(index + 9) - 0.5) * 0.9 * p;
    pose.scaleX = pose.scaleY = 1 - 0.3 * p;
    pose.opacity = 1 - p;
  }
  return pose;
}

export function motionOffset(motion, time) {
  const t = Math.max(0, time);
  if (!motion || motion === "none") return { x: 0, y: 0, rot: 0, scaleX: 1, scaleY: 1 };
  if (motion === "wiggle") {
    return { x: 0, y: 0, rot: (7.5 * Math.sin((2 * Math.PI * t) / 0.46) * Math.PI) / 180, scaleX: 1, scaleY: 1 };
  }
  if (motion === "float") {
    return {
      x: 10 * Math.sin((2 * Math.PI * t) / 1.35 + 0.4),
      y: 38 * Math.sin((2 * Math.PI * t) / 0.92),
      rot: (3 * Math.sin((2 * Math.PI * t) / 0.92) * Math.PI) / 180,
      scaleX: 1,
      scaleY: 1,
    };
  }
  if (motion === "swing") {
    const s = Math.sin((2 * Math.PI * t) / 0.8);
    return { x: 8 * s, y: 0, rot: (15 * s * Math.PI) / 180, scaleX: 1, scaleY: 1 };
  }
  if (motion === "bounce-loop") {
    const wave = Math.sin((2 * Math.PI * t) / 0.42);
    return { x: 0, y: 0, rot: 0, scaleX: 1 - 0.24 * 0.62 * wave, scaleY: 1 + 0.24 * wave };
  }
  if (motion === "shake-word") {
    return {
      x: 11 * Math.sin((2 * Math.PI * t) / 0.1),
      y: 9.35 * Math.sin((2 * Math.PI * t) / 0.08 + 0.8),
      rot: ((8 * Math.sin((2 * Math.PI * t) / 0.11) + 3.2 * Math.sin((2 * Math.PI * t) / 0.07 + 1.1)) * Math.PI) / 180,
      scaleX: 1,
      scaleY: 1,
    };
  }
  return { x: 0, y: 0, rot: 0, scaleX: 1, scaleY: 1 };
}

export function stillMotion(time, duration) {
  const p = duration > 0 ? clamp01(time / duration) : 0;
  return {
    scale: 1 + 0.08 * p,
    panX: (p - 0.5) * 36,
    panY: (0.5 - p) * 18,
  };
}

export function emphasisPunch(words, time) {
  let extra = 0;
  for (const word of words) {
    if (!word.emphasized) continue;
    const dt = time - word.start;
    if (dt >= 0 && dt < 0.28) extra = Math.max(extra, Math.sin((dt / 0.28) * Math.PI) * 0.035);
  }
  return extra;
}

export function ctaWindow(duration, words, label) {
  const length = Math.max(0.8, duration || 0);
  let start = Math.max(length * 0.55, length - 2.7);
  const needle = String(label || "").trim().toLowerCase();
  if (needle && words?.length) {
    const hit = words.find((word) => needle.includes(word.text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")));
    if (hit) start = Math.min(start, hit.start);
  }
  start = Math.max(0.2, Math.min(start, length - 0.4));
  return { start, end: length };
}

export function prefersWholeWords(script) {
  return COMPLEX_SCRIPT.has(script);
}

function hash(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}
