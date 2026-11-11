/** ASS colour helpers ported from engine/styles.py. ASS alpha 00 is opaque. */

export function assToCss(value, fallback = "rgba(255,255,255,1)") {
  if (!value) return fallback;
  let raw = String(value).trim().replace(/&/g, "").replace(/^H/i, "");
  if (raw.length === 6) raw = "00" + raw;
  if (raw.length !== 8 || /[^0-9a-f]/i.test(raw)) return fallback;
  const a = parseInt(raw.slice(0, 2), 16);
  const b = parseInt(raw.slice(2, 4), 16);
  const g = parseInt(raw.slice(4, 6), 16);
  const r = parseInt(raw.slice(6, 8), 16);
  const alpha = 1 - a / 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
}

function clamp(n) {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function mix(c, other, t) {
  return c.map((channel, i) => clamp(channel + (other[i] - channel) * t));
}

function rgbToAss(r, g, b, a = 0) {
  const hex = (n) => n.toString(16).padStart(2, "0").toUpperCase();
  return `&H${hex(a)}${hex(b)}${hex(g)}${hex(r)}`;
}

export function paletteFromHex(input) {
  let raw = String(input || "").trim().replace(/^#/, "");
  if (raw.length === 3 && /^[0-9a-f]{3}$/i.test(raw)) raw = raw.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(raw)) return null;
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  const base = [r, g, b];
  const light = mix(base, [255, 250, 245], 0.72);
  const primary = (r + g + b) / 3 < 220 ? light : mix(base, [255, 255, 255], 0.2);
  const outline = mix(base, [20, 16, 14], 0.72);
  const glow = mix(base, [255, 240, 230], 0.25);
  const back = [...mix(base, [20, 16, 14], 0.8), 0x66];
  const box = mix(base, [40, 24, 32], 0.25);
  const name = `#${raw.toUpperCase()}`;
  return {
    name,
    label: name,
    swatch: name,
    primary: rgbToAss(...primary),
    highlight: rgbToAss(...base),
    outline: rgbToAss(...outline),
    glow: rgbToAss(...glow),
    back: rgbToAss(back[0], back[1], back[2], back[3]),
    box_color: rgbToAss(...box),
  };
}

export function dimCss(color, amount = 0.52) {
  const match = String(color).match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!match) return color;
  const r = Math.round(Number(match[1]) * (1 - amount));
  const g = Math.round(Number(match[2]) * (1 - amount));
  const b = Math.round(Number(match[3]) * (1 - amount));
  return `rgba(${r}, ${g}, ${b}, 1)`;
}
