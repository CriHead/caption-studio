import { assToCss, dimCss, paletteFromHex } from "./color.js";
import {
  activeGroup,
  anchorFor,
  ctaWindow,
  emphasisPunch,
  isLetterAnimation,
  letterPose,
  linePose,
  motionOffset,
  prefersWholeWords,
  stillMotion,
} from "./captions.js";
import { burstsAt } from "./emoji.js";
import { familyName, fontStack } from "./fonts.js";

const REDUCED = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function resolveLook(rawStyle, palette, vertical) {
  const pal = palette || null;
  const primary = assToCss(pal?.primary || rawStyle.primary, "#f4f1ec");
  const highlight = assToCss(pal?.highlight || rawStyle.highlight, primary);
  let sung = primary;
  let unsung = assToCss(rawStyle.secondary, dimCss(primary, 0.45));
  if (rawStyle.karaoke) {
    sung = highlight || primary;
    unsung = dimCss(sung, 0.52);
  }
  const bodyFile = rawStyle.font_files?.[0];
  const displayFile = rawStyle.display_font_files?.[0] || bodyFile;
  return {
    label: rawStyle.label,
    bodyFamily: familyName(bodyFile),
    displayFamily: familyName(displayFile),
    bodyFile,
    displayFile,
    fontSize: vertical ? rawStyle.fontsize_vertical : rawStyle.fontsize_landscape,
    keywordSize: vertical ? rawStyle.keyword_fontsize_vertical : rawStyle.keyword_fontsize_landscape,
    primary,
    highlight,
    sung,
    unsung,
    outline: assToCss(pal?.outline || rawStyle.outline, "#16120f"),
    glow: assToCss(pal?.glow || rawStyle.glow, highlight),
    back: assToCss(pal?.back || rawStyle.back, "rgba(0,0,0,0.4)"),
    box: assToCss(pal?.box_color || rawStyle.box_color || rawStyle.back, "rgba(80,40,60,0.9)"),
    outlineW: Number(rawStyle.outline_w) || 3,
    shadow: Number(rawStyle.shadow) || 0,
    wordsPerLine: rawStyle.words_per_line || 2,
    borderStyle: rawStyle.border_style || 1,
    spacing: Number(rawStyle.spacing) || 0,
    karaoke: Boolean(rawStyle.karaoke),
    letterbox: Boolean(rawStyle.letterbox),
    motion: REDUCED ? "none" : (rawStyle.default_motion || "float"),
    animation: rawStyle.default_animation || "fade",
    marginV: vertical ? rawStyle.margin_v_vertical : rawStyle.margin_v_landscape,
    defaultPlacement: rawStyle.default_placement || "auto",
  };
}

export function paletteById(catalog, id) {
  if (!id) return null;
  if (catalog.palettes[id]) return catalog.palettes[id];
  return paletteFromHex(id);
}

export function drawFrame(ctx, spec) {
  const { width, height } = spec;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#120e0c";
  ctx.fillRect(0, 0, width, height);
  drawPicture(ctx, spec);
  if (spec.letterbox) drawLetterbox(ctx, width, height);
  drawCaptions(ctx, spec);
  if (spec.emojiOn) drawEmoji(ctx, spec);
  if (spec.cta) drawCta(ctx, spec);
}

function drawPicture(ctx, spec) {
  const source = spec.source;
  if (!source) return;
  const sw = spec.sourceWidth || source.videoWidth || source.width || spec.width;
  const sh = spec.sourceHeight || source.videoHeight || source.height || spec.height;
  if (!sw || !sh) return;
  let scale = Math.max(spec.width / sw, spec.height / sh);
  let panX = 0;
  let panY = 0;
  if (spec.still) {
    const drift = stillMotion(spec.time, spec.duration);
    scale *= drift.scale;
    panX = drift.panX;
    panY = drift.panY;
  }
  scale *= 1 + emphasisPunch(spec.words || [], spec.time);
  const dw = sw * scale;
  const dh = sh * scale;
  const x = (spec.width - dw) / 2 + panX;
  const y = (spec.height - dh) / 2 + panY;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  try {
    if (typeof source.draw === "function" && source.displayWidth) source.draw(ctx, x, y, dw, dh);
    else ctx.drawImage(source, x, y, dw, dh);
  } catch {
    /* A seek can briefly lack a frame. The fill underneath stays. */
  }
}

function drawLetterbox(ctx, width, height) {
  const picture = Math.round(width / 2.35);
  let bar = Math.max(56, Math.floor((height - picture) / 2));
  bar = Math.min(bar, Math.floor(height / 5));
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, bar);
  ctx.fillRect(0, height - bar, width, bar);
}

function drawCaptions(ctx, spec) {
  const group = activeGroup(spec.groups || [], spec.time);
  if (!group) return;
  let look = spec.look;
  if (spec.animation === "karaoke" && !look.karaoke) {
    look = { ...look, karaoke: true, sung: look.highlight, unsung: dimCss(look.highlight, 0.5) };
  }
  const local = spec.time - group.start;
  const span = Math.max(0.2, group.end - group.start);
  const anchor = anchorFor(
    spec.placement,
    spec.width,
    spec.height,
    look.marginV,
    group.index,
    look.defaultPlacement,
  );
  const motion = motionOffset(look.motion, local);
  const script = spec.script;
  const letterMode = isLetterAnimation(spec.animation) && !look.karaoke && !prefersWholeWords(script);
  const pose = letterMode || look.karaoke
    ? { opacity: 1, scaleX: 1, scaleY: 1, x: 0, y: 0, rot: 0, blur: 0, skew: 0 }
    : linePose(spec.animation, local, span);

  const direction = script === "ar" || script === "he" ? "rtl" : "ltr";
  const line = layoutLine(ctx, group, look, spec.width * 0.86, direction, letterMode);
  if (!line.items.length) return;

  const pad = 36;
  const poseScaleX = motion.scaleX * pose.scaleX || 1;
  const poseScaleY = motion.scaleY * pose.scaleY || 1;
  let fit = 1;
  if (line.width * Math.abs(poseScaleX) > spec.width - pad * 2) {
    fit = (spec.width - pad * 2) / (line.width * Math.abs(poseScaleX));
  }
  const halfW = (line.width * Math.abs(poseScaleX) * fit) / 2;
  const halfH = (line.height * Math.abs(poseScaleY) * fit) / 2 + look.outlineW + 8;
  let cx = anchor.x + motion.x + (pose.x || 0);
  let cy = anchor.y + motion.y + (pose.y || 0);
  cx = Math.min(Math.max(cx, pad + halfW), spec.width - pad - halfW);
  cy = Math.min(Math.max(cy, pad + halfH), spec.height - pad - halfH);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(motion.rot + (pose.rot || 0));
  ctx.scale(poseScaleX * fit, poseScaleY * fit);
  if (pose.skew) ctx.transform(1, 0, pose.skew, 1, 0, 0);
  ctx.globalAlpha = Math.max(0, Math.min(1, pose.opacity));
  if (pose.blur > 0.2) ctx.filter = `blur(${pose.blur.toFixed(2)}px)`;
  if (look.borderStyle === 3) drawBubble(ctx, line, look);

  if (look.karaoke) drawKaraoke(ctx, line, look, spec.time);
  else if (letterMode) drawLetters(ctx, line, look, spec.animation, local, span);
  else drawRuns(ctx, line, look);

  ctx.filter = "none";
  ctx.restore();
}

function layoutLine(ctx, group, look, maxWidth, direction, letterMode) {
  const items = [];
  group.words.forEach((word, index) => {
    const keyword = group.flags[index];
    const family = keyword ? look.displayFamily : look.bodyFamily;
    const size = keyword ? look.keywordSize : look.fontSize;
    const color = keyword ? look.highlight : look.primary;
    const text = word.text;
    if (letterMode) {
      const chars = [...text];
      chars.forEach((ch, charIndex) => {
        items.push({
          text: ch,
          word,
          keyword,
          family,
          size,
          color,
          wordIndex: index,
          charIndex: items.length,
          spaceBefore: charIndex === 0 && index > 0,
        });
      });
    } else {
      items.push({
        text,
        word,
        keyword,
        family,
        size,
        color,
        wordIndex: index,
        charIndex: index,
        spaceBefore: index > 0,
      });
    }
  });

  const measure = (item, size) => {
    ctx.font = fontStack(size, item.family);
    const width = ctx.measureText(item.text).width;
    const gap = item.spaceBefore ? ctx.measureText(" ").width : 0;
    return { width, gap };
  };

  items.forEach((item) => {
    const box = measure(item, item.size);
    item.natural = box.width;
    item.gap = box.gap;
  });
  const natural = items.reduce((sum, item, index) => sum + item.natural + (index ? item.gap : 0), 0);
  const tracking = look.spacing * Math.max(0, items.length - 1);
  const scale = natural + tracking > maxWidth ? Math.max(0.46, maxWidth / (natural + tracking)) : 1;
  const widths = items.map((item) => item.natural * scale);
  const gaps = items.map((item, index) => (index ? item.gap * scale + look.spacing * scale : 0));
  const total = widths.reduce((sum, width) => sum + width, 0) + gaps.reduce((sum, gap) => sum + gap, 0);
  if (direction === "rtl") {
    let cursor = total / 2;
    items.forEach((item, index) => {
      item.size *= scale;
      item.width = widths[index];
      cursor -= gaps[index] + item.width;
      item.x = cursor;
      item.y = 0;
    });
  } else {
    let cursor = -total / 2;
    items.forEach((item, index) => {
      item.size *= scale;
      item.width = widths[index];
      cursor += gaps[index];
      item.x = cursor;
      item.y = 0;
      cursor += item.width;
    });
  }
  const height = Math.max(look.fontSize * scale, ...items.map((item) => item.size));
  return { items, width: total, height, scale };
}

function drawBubble(ctx, line, look) {
  const padX = Math.max(22, look.outlineW * 1.3);
  const padY = Math.max(12, look.outlineW * 0.7);
  const w = line.width + padX * 2;
  const h = line.height + padY * 2;
  roundRect(ctx, -w / 2, -h / 2, w, h, h / 2);
  ctx.fillStyle = look.box;
  ctx.fill();
}

function drawRuns(ctx, line, look) {
  for (const item of line.items) paintText(ctx, item.text, item.x, item.y, item, look);
}

function drawLetters(ctx, line, look, animation, local, span) {
  let lastVisible = null;
  line.items.forEach((item, index) => {
    const pose = letterPose(animation, local, span, index);
    if (pose.opacity <= 0.01) return;
    ctx.save();
    ctx.translate(item.x + item.width / 2 + pose.x, item.y + pose.y);
    ctx.rotate(pose.rot || 0);
    ctx.scale(pose.scaleX, pose.scaleY);
    ctx.globalAlpha *= pose.opacity;
    paintText(ctx, item.text, -item.width / 2, 0, item, look, "left");
    ctx.restore();
    lastVisible = item;
  });
  if (animation === "typewriter-cursor" && lastVisible && Math.floor(local * 6) % 2 === 0) {
    const x = lastVisible.x + lastVisible.width + 4;
    ctx.fillStyle = "#fff";
    ctx.fillRect(x, -lastVisible.size * 0.42, Math.max(4, lastVisible.size * 0.08), lastVisible.size * 0.84);
  }
}

function drawKaraoke(ctx, line, look, time) {
  for (const item of line.items) {
    const word = item.word;
    const span = Math.max(0.08, word.end - word.start);
    const progress = clamp01((time - word.start) / span);
    paintText(ctx, item.text, item.x, item.y, { ...item, color: look.unsung }, look);
    if (progress > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(item.x, item.y - item.size, item.width * progress, item.size * 2);
      ctx.clip();
      paintText(ctx, item.text, item.x, item.y, { ...item, color: look.sung }, look);
      ctx.restore();
    }
  }
}

function paintText(ctx, text, x, y, item, look, align = "left") {
  ctx.font = fontStack(item.size, item.family);
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  ctx.shadowColor = "transparent";
  ctx.lineWidth = Math.max(2, look.outlineW * 2);
  ctx.strokeStyle = look.outline;
  if (look.borderStyle !== 3) ctx.strokeText(text, x, y);
  ctx.fillStyle = item.color;
  if (look.shadow > 0) {
    ctx.shadowColor = "rgba(0,0,0,0.55)";
    ctx.shadowBlur = look.shadow * 1.15;
    ctx.shadowOffsetY = look.shadow * 0.45;
    ctx.shadowOffsetX = look.shadow * 0.12;
  } else if (look.borderStyle !== 3) {
    ctx.shadowColor = look.glow;
    ctx.shadowBlur = Math.max(8, look.outlineW * 2.4);
  }
  ctx.fillText(text, x, y);
  ctx.shadowColor = "transparent";
}

function drawEmoji(ctx, spec) {
  const group = activeGroup(spec.groups || [], spec.time);
  const anchor = group
    ? anchorFor(spec.placement, spec.width, spec.height, spec.look.marginV, group.index, spec.look.defaultPlacement)
    : { x: spec.width / 2, y: spec.height * 0.62 };
  const sprites = burstsAt(spec.words || [], spec.time, anchor.x, anchor.y - 70);
  for (const sprite of sprites) {
    const image = spec.emojiImages?.[sprite.file];
    if (!image) continue;
    ctx.save();
    ctx.globalAlpha = sprite.alpha;
    ctx.drawImage(image, sprite.x - sprite.size / 2, sprite.y - sprite.size / 2, sprite.size, sprite.size);
    ctx.restore();
  }
}

function drawCta(ctx, spec) {
  const window = ctaWindow(spec.duration, spec.words, spec.cta);
  if (spec.time < window.start || spec.time > window.end) return;
  const label = spec.cta.trim().slice(0, 28) || "Shop now";
  const local = spec.time - window.start;
  const bw = Math.max(200, Math.min(spec.width - 80, label.length * 22 + 88));
  const bh = 72;
  const cx = spec.width / 2;
  const cy = spec.height * 0.78;
  ctx.save();
  roundRect(ctx, cx - bw / 2, cy - bh / 2, bw, bh, 16);
  ctx.fillStyle = spec.look.highlight;
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 6;
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.lineWidth = 2;
  ctx.strokeStyle = spec.look.outline;
  ctx.stroke();
  ctx.font = fontStack(34, spec.look.displayFamily || spec.look.bodyFamily);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fff";
  ctx.fillText(label, cx, cy);

  const fly = Math.max(0.25, (window.end - window.start) * 0.45);
  const p = clamp01(local / fly);
  const eased = 1 - Math.pow(1 - p, 3);
  const x1 = cx - 220;
  const y1 = cy - 150;
  const x2 = cx + bw / 2 - 18;
  const y2 = cy + 8;
  drawPointer(ctx, x1 + (x2 - x1) * eased, y1 + (y2 - y1) * eased);
  if (local > fly) {
    const rip = (local - fly) / 0.55;
    ripple(ctx, x2, y2, rip, 18, 70);
    ripple(ctx, x2, y2, rip - 0.15, 14, 86);
  }
  ctx.restore();
}

function drawPointer(ctx, x, y) {
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 34);
  ctx.lineTo(8, 26);
  ctx.lineTo(14, 42);
  ctx.lineTo(18, 40);
  ctx.lineTo(11, 24);
  ctx.lineTo(24, 24);
  ctx.closePath();
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#111";
  ctx.lineWidth = 1.5;
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 6;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function ripple(ctx, x, y, progress, start, end) {
  if (progress <= 0 || progress >= 1) return;
  ctx.beginPath();
  ctx.arc(x, y, start + (end - start) * progress, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(255,255,255,${(1 - progress) * 0.85})`;
  ctx.lineWidth = 3;
  ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}
