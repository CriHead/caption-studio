/** Family names match the @font-face names registered at runtime. */

export function familyName(relPath) {
  const base = String(relPath).split("/").pop().replace(/\.[^.]+$/, "");
  return "cs-" + base.replace(/[^A-Za-z0-9]+/g, "-");
}

const SCRIPT_FONT = {
  ar: "noto-naskh/NotoNaskhArabic-Regular.ttf",
  he: "noto-hebrew/NotoSansHebrew-Regular.ttf",
  hi: "noto-devanagari/NotoSansDevanagari-Regular.ttf",
  ru: "noto-sans/NotoSans-Bold.ttf",
  el: "noto-sans/NotoSans-Bold.ttf",
};

const loaded = new Map();

export function scriptForText(text) {
  const value = text || "";
  if (/[\u0600-\u06FF]/.test(value)) return "ar";
  if (/[\u0590-\u05FF]/.test(value)) return "he";
  if (/[\u0900-\u097F]/.test(value)) return "hi";
  if (/[\u0400-\u04FF]/.test(value)) return "ru";
  if (/[\u0370-\u03FF]/.test(value)) return "el";
  if (/[\u3040-\u30FF]/.test(value)) return "ja";
  if (/[\uAC00-\uD7AF]/.test(value)) return "ko";
  if (/[\u4E00-\u9FFF]/.test(value)) return "zh";
  return null;
}

export function scriptFontFile(script) {
  return SCRIPT_FONT[script] || null;
}

export function fontStack(size, family) {
  const px = Math.max(12, Math.round(size));
  return `${px}px "${family}", "cs-NotoSans-Bold", "cs-NotoSans-Regular", "Noto Sans SC", "Noto Sans JP", "Noto Sans KR", "PingFang SC", "Hiragino Sans", "Yu Gothic", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;
}

export async function ensureFonts(relPaths) {
  const pending = [];
  for (const rel of relPaths) {
    if (!rel) continue;
    const family = familyName(rel);
    if (!loaded.has(family)) {
      const face = new FontFace(family, `url("./fonts/${rel}")`, {
        weight: "100 900",
        display: "swap",
      });
      const job = face.load().then((ready) => {
        document.fonts.add(ready);
        return ready;
      });
      loaded.set(family, job);
    }
    pending.push(loaded.get(family));
  }
  await Promise.all(pending);
}
