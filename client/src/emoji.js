import catalog from "./catalog.json";

const KEYWORD = catalog.emoji;
const BURST = catalog.burst;

export function emojiFileForWord(word) {
  const key = String(word || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return KEYWORD[key] || null;
}

export function burstFiles() {
  return BURST.slice();
}

/** Deterministic pops around a caption, matching the server's short burst. */
export function burstsAt(words, time, originX, originY) {
  const tagged = words.filter((word) => emojiFileForWord(word.text));
  const hosts = tagged.length ? tagged.slice(0, 2) : words.length ? [words.reduce((a, b) => (a.text.length >= b.text.length ? a : b))] : [];
  const sprites = [];
  hosts.forEach((host, hi) => {
    const t0 = host.start;
    const t1 = t0 + 0.9;
    if (time < t0 || time > t1) return;
    const p = (time - t0) / 0.9;
    const ease = 1 - Math.pow(1 - Math.min(1, p * 1.15), 3);
    const fade = p < 0.62 ? 1 : 1 - (p - 0.62) / 0.38;
    for (let i = 0; i < 5; i++) {
      const file = BURST[(hi * 5 + i) % BURST.length];
      const ang = (i / 5) * Math.PI * 2 + hi * 0.4;
      const dist = (90 + (i % 3) * 28) * ease;
      sprites.push({
        file,
        x: originX + Math.cos(ang) * dist,
        y: originY + Math.sin(ang) * dist * 0.85,
        size: (i % 2 === 0 ? 52 : 40) * (0.72 + 0.28 * ease),
        alpha: Math.max(0, fade),
      });
    }
    const own = emojiFileForWord(host.text) || BURST[0];
    sprites.push({
      file: own,
      x: originX + 78,
      y: originY - 18 - 10 * ease,
      size: 64 * (0.85 + 0.15 * ease),
      alpha: Math.max(0, fade),
    });
  });
  return sprites;
}
