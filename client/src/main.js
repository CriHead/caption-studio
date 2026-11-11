import catalog from "./catalog.json";
import { groupWords, wordsFromText, chunksToWords } from "./captions.js";
import { drawFrame, drawOverlay, paletteById, resolveLook } from "./draw.js";
import { burstFiles, emojiFileForWord } from "./emoji.js";
import { ensureFonts, familyName, scriptFontFile, scriptForText } from "./fonts.js";
import { eachPcmWindow, fileKind, loadImage, resumeAudioContext } from "./media.js";
import { resetPlacement } from "./place.js";
import { renderMp4 } from "./render.js";
import { detectKeepOut, unloadVision } from "./vision.js";
import { clearSession, loadSession, saveCaptions, saveMedia, saveSettings, saveVoice } from "./session.js";
import { modelChoice, releaseTranscriber, takeWords, transcribeAudio } from "./transcribe.js";

const MAX_BYTES = 300 * 1024 * 1024;
const MAX_SECONDS = 5 * 60;
const OUTPUTS = {
  "720": { landscape: [1280, 720], vertical: [720, 1280], bitrate: 4_500_000, label: "720p" },
  "1080": { landscape: [1920, 1080], vertical: [1080, 1920], bitrate: 8_000_000, label: "1080p" },
};
const STILL_SECONDS = 6;
const SCRIPT_LANGS = new Set(["ar", "he", "hi", "ru", "el", "zh", "ja", "ko"]);

const form = document.getElementById("form");
const fileInput = document.getElementById("file");
const audioInput = document.getElementById("audio");
const drop = document.getElementById("drop");
const fileName = document.getElementById("fileName");
const textEl = document.getElementById("text");
const heardEl = document.getElementById("heard");
const statusEl = document.getElementById("status");
const bar = document.getElementById("bar");
const barFill = bar.querySelector("i");
const result = document.getElementById("result");
const player = document.getElementById("player");
const save = document.getElementById("save");
const go = document.getElementById("go");
const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d", { alpha: true });
const stageFrame = document.getElementById("stageFrame");
const BUSY_KEY = "caption-studio-busy";
const HEAVY_WORK = new Set(["transcribe", "render"]);
const playBtn = document.getElementById("play");
const scrub = document.getElementById("scrub");
const timeLabel = document.getElementById("timeLabel");
const hexEl = document.getElementById("hex");
const colorLabel = document.getElementById("colorLabel");
const langEl = document.getElementById("lang");
const accuracyEl = document.getElementById("accuracy");
const ctaEl = document.getElementById("cta");
const emojiEl = document.getElementById("emoji");

const studio = {
  ready: false,
  restored: false,
  phase: "idle",
  words: [],
  transcript: "",
  device: "",
  model: "",
  transcribeMs: 0,
  transcribeStarts: 0,
  renderMs: 0,
  lastBlob: null,
  error: null,
  fileName: "",
  styleId: catalog.defaultStyle,
  whenSaved: Promise.resolve(),
};
window.__studio = studio;

const state = {
  styleId: catalog.defaultStyle,
  paletteId: catalog.defaultPalette,
  animation: "",
  placement: "auto",
  vertical: false,
  quality: "720",
  motion: "",
  letterbox: false,
  placeMode: "move",
  keepOut: [],
  previewStyleId: "",
  kind: null,
  file: null,
  image: null,
  videoUrl: "",
  duration: STILL_SECONDS,
  sourceWidth: 1280,
  sourceHeight: 720,
  voiceFile: null,
  pcm: null,
  heardWords: [],
  transcript: "",
  job: 0,
  playing: false,
  userMuted: false,
  voiceUrl: "",
  scrubTime: 0.2,
  resultUrl: "",
};

let lastPaintKey = "";
let restorePromise = Promise.resolve();

const previewVideo = document.getElementById("previewVideo");
const previewVoice = document.getElementById("previewVoice");
previewVideo.playsInline = true;
previewVideo.autoplay = false;
previewVideo.preload = "metadata";
previewVideo.muted = false;
previewVideo.volume = 1;
previewVoice.preload = "metadata";
previewVoice.volume = 1;

const emojiImages = {};

buildChoices();
wire();
boot();

function isIos() {
  const ua = navigator.userAgent || "";
  return /iP(hone|ad|od)/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function lightDevice() {
  const low = typeof navigator.deviceMemory === "number" && navigator.deviceMemory <= 4;
  return isIos() || low;
}

function markBusy(reason) {
  if (!HEAVY_WORK.has(reason)) return;
  try { localStorage.setItem(BUSY_KEY, reason); } catch { /* private mode */ }
}

function clearBusy(reason) {
  try {
    if (reason && localStorage.getItem(BUSY_KEY) !== reason) return;
    localStorage.removeItem(BUSY_KEY);
  } catch { /* ignore */ }
}

function clearBusyOnLeave() {
  try {
    if (!HEAVY_WORK.has(localStorage.getItem(BUSY_KEY))) clearBusy();
  } catch { /* ignore */ }
}

function friendly() {
  const text = "Something went wrong on this device. Your clip is still here if it was saved. You can try again, or start over.";
  setStatus(text, true);
  studio.error = text;
}

function boot() {
  window.addEventListener("error", () => friendly());
  window.addEventListener("unhandledrejection", (event) => {
    event.preventDefault();
    friendly();
  });
  const releaseIfHidden = () => {
    if (document.visibilityState === "hidden") clearBusyOnLeave();
  };
  window.addEventListener("pagehide", clearBusyOnLeave);
  document.addEventListener("visibilitychange", releaseIfHidden);
  if ([...langEl.options].some((option) => option.value === "en")) langEl.value = "en";
  let marker = "";
  try { marker = localStorage.getItem(BUSY_KEY) || ""; } catch { /* private mode */ }
  if (HEAVY_WORK.has(marker)) {
    showRecovery();
    studio.blocked = true;
  } else {
    clearBusy();
  }
  restorePromise = restoreSession();
}

function showRecovery() {
  document.getElementById("recovery").hidden = false;
  setStatus("Transcription or export was interrupted. Your clip is still on this device.");
}

function hideRecovery() {
  document.getElementById("recovery").hidden = true;
}

async function resumeSaved(lighter) {
  hideRecovery();
  clearBusy();
  studio.blocked = false;
  if (lighter) {
    state.quality = "720";
    accuracyEl.value = "fast";
    document.querySelectorAll("[data-quality]").forEach((node) => {
      node.classList.toggle("on", node.dataset.quality === "720");
    });
    rememberSettings();
  }
  await restorePromise;
  if (!state.file) {
    restorePromise = restoreSession();
    await restorePromise;
  }
  if (state.kind === "video" && state.file && !previewVideo.currentSrc) attachPreviewUrl(state.file);
  if (state.voiceFile && !previewVoice.currentSrc) attachVoiceUrl(state.voiceFile);
  applyPreviewLevels();
  if (state.file) await restartPreview();
}

function buildChoices() {
  const styles = document.getElementById("styles");
  for (const item of catalog.styleList) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "style" + (item.id === state.styleId ? " selected" : "");
    button.dataset.style = item.id;
    button.setAttribute("aria-pressed", item.id === state.styleId ? "true" : "false");
    button.innerHTML = `<img src="./previews/${item.id}.png" alt="" loading="lazy" decoding="async"><canvas class="style-live" width="320" height="180" hidden></canvas><div class="meta"><b></b><small></small></div>`;
    button.querySelector("b").textContent = item.label;
    button.querySelector("small").textContent = item.blurb;
    button.querySelector("img").addEventListener("error", () => {
      button.querySelector("img").style.background = "#e8ddd3";
    });
    styles.appendChild(button);
  }

  const swatches = document.getElementById("swatches");
  for (const [id, pal] of Object.entries(catalog.palettes)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "swatch" + (id === state.paletteId ? " selected" : "");
    button.dataset.color = id;
    button.title = pal.label;
    button.setAttribute("aria-label", pal.label);
    button.style.background = pal.swatch;
    swatches.appendChild(button);
  }

  const animRoot = document.getElementById("animations");
  animRoot.appendChild(sectionLabel("Style default"));
  animRoot.appendChild(pillRow([{ id: "", label: "Auto" }], "animation", ""));
  const order = ["Smooth", "Playful", "Cinematic", "Cool", "Letters", "Fun / Emoji", "More"];
  for (const category of order) {
    const items = catalog.animations.filter((item) => item.category === category);
    if (!items.length) continue;
    animRoot.appendChild(sectionLabel(category));
    animRoot.appendChild(pillRow(items.map((item) => ({ id: item.id, label: titleCase(item.label) })), "animation", null));
  }

  const placements = document.getElementById("placements");
  for (const item of catalog.placements) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pill" + (item.id === "auto" ? " selected" : "");
    button.dataset.placement = item.id;
    button.textContent = item.label;
    button.setAttribute("aria-pressed", item.id === "auto" ? "true" : "false");
    placements.appendChild(button);
  }

  for (const item of catalog.languages) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.label;
    langEl.appendChild(option);
  }
}

function sectionLabel(text) {
  const el = document.createElement("div");
  el.className = "anim-cat";
  el.textContent = text;
  return el;
}

function pillRow(items, kind, selected) {
  const row = document.createElement("div");
  row.className = "pills";
  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pill" + (item.id === selected ? " selected" : "");
    button.dataset[kind] = item.id;
    button.textContent = item.label;
    button.setAttribute("aria-pressed", item.id === selected ? "true" : "false");
    row.appendChild(button);
  }
  return row;
}

function titleCase(value) {
  return String(value).replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function wire() {
  drop.addEventListener("dragover", (event) => {
    event.preventDefault();
    drop.classList.add("drag");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("drag");
    const file = event.dataTransfer?.files?.[0];
    if (file) {
      fileInput.files = event.dataTransfer.files;
      onFile(file);
    }
  });
  document.getElementById("choose").addEventListener("click", () => fileInput.click());
  document.getElementById("reset").addEventListener("click", () => {
    if (window.confirm("Clear this clip and start over?")) studio.whenSaved = startOver();
  });
  fileInput.addEventListener("change", () => {
    const next = fileInput.files[0];
    if (next) onFile(next);
    fileInput.value = "";
  });
  audioInput.addEventListener("change", () => onAudio(audioInput.files[0] || null));
  textEl.addEventListener("input", () => {
    heardEl.textContent = textEl.value.trim() ? "Using the caption you typed." : heardLine();
    if (textEl.value.trim() && state.file) setStatus("Preview ready. It stays on this device.");
    rememberSettings();
    restartPreview();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.matches("input")) event.preventDefault();
  });
  document.getElementById("styles").addEventListener("click", (event) => {
    const button = event.target.closest("[data-style]");
    if (!button) return;
    state.previewStyleId = button.dataset.style;
    markStyleCards();
    restartPreview();
    startCardPreview(state.previewStyleId);
  });
  document.getElementById("applyStyle").addEventListener("click", () => applyStyle());
  document.getElementById("cancelStyle").addEventListener("click", () => cancelStyle());
  document.getElementById("placeMode").addEventListener("click", (event) => {
    const button = event.target.closest("[data-place-mode]");
    if (!button) return;
    state.placeMode = button.dataset.placeMode === "bottom" ? "bottom" : "move";
    document.querySelectorAll("[data-place-mode]").forEach((node) => {
      node.classList.toggle("on", node === button);
    });
    rememberSettings();
    restartPreview();
  });
  document.getElementById("swatches").addEventListener("click", (event) => {
    const button = event.target.closest("[data-color]");
    if (!button) return;
    selectGroup("[data-color]", button);
    state.paletteId = button.dataset.color;
    hexEl.value = "";
    colorLabel.textContent = button.getAttribute("aria-label");
    rememberSettings();
    restartPreview();
  });
  hexEl.addEventListener("input", () => {
    const value = hexEl.value.trim();
    if (!value) return;
    state.paletteId = value;
    document.querySelectorAll("[data-color]").forEach((node) => node.classList.remove("selected"));
    colorLabel.textContent = value;
    rememberSettings();
    restartPreview();
  });
  document.getElementById("animations").addEventListener("click", (event) => {
    const button = event.target.closest("[data-animation]");
    if (!button) return;
    selectGroup("[data-animation]", button, "animation");
    state.animation = button.dataset.animation || "";
    rememberSettings();
    restartPreview();
  });
  document.getElementById("placements").addEventListener("click", (event) => {
    const button = event.target.closest("[data-placement]");
    if (!button) return;
    selectGroup("#placements .pill", button, "placement");
    state.placement = button.dataset.placement || "auto";
    rememberSettings();
    restartPreview();
  });
  langEl.addEventListener("change", () => {
    rememberSettings();
    restartPreview();
  });
  accuracyEl.addEventListener("change", () => {
    rememberSettings();
  });
  ctaEl.addEventListener("input", () => {
    rememberSettings();
    restartPreview();
  });
  emojiEl.addEventListener("change", () => {
    rememberSettings();
    restartPreview();
  });
  document.getElementById("land").addEventListener("click", () => setOrient(false));
  document.getElementById("vert").addEventListener("click", () => setOrient(true));
  playBtn.addEventListener("click", togglePlay);
  document.getElementById("mute").addEventListener("click", toggleMute);
  scrub.addEventListener("input", () => {
    state.playing = false;
    setPlaying(false);
    previewVideo.pause();
    previewVoice.pause();
    state.scrubTime = (Number(scrub.value) / 1000) * state.duration;
    if (state.kind === "video") {
      try { previewVideo.currentTime = state.scrubTime; } catch { /* not ready yet */ }
    }
    if (state.voiceFile) {
      try { previewVoice.currentTime = state.scrubTime; } catch { /* not ready yet */ }
    }
    syncScrub();
    paint();
  });
  previewVideo.addEventListener("loadedmetadata", () => {
    resizeCanvas();
    if (state.kind !== "video" || state.playing) return;
    if (Math.abs((previewVideo.currentTime || 0) - state.scrubTime) > 0.08) {
      try { previewVideo.currentTime = state.scrubTime; } catch { /* seek can wait until data arrives */ }
    }
  });
  previewVideo.addEventListener("ended", () => {
    stopPlay();
  });
  previewVideo.addEventListener("loadeddata", () => {
    if (state.kind === "video" && !state.playing) paint();
  });
  previewVideo.addEventListener("timeupdate", () => {
    if (!state.playing || state.kind !== "video") return;
    state.scrubTime = previewVideo.currentTime || 0;
    syncScrub();
  });
  const themeBtn = document.getElementById("theme");
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  const paintThemeButton = () => {
    const light = document.documentElement.dataset.theme === "light";
    themeBtn.textContent = light ? "Dark" : "Light";
    themeBtn.setAttribute("aria-pressed", light ? "true" : "false");
    themeBtn.setAttribute("aria-label", light ? "Switch to dark theme" : "Switch to light theme");
    if (themeMeta) themeMeta.content = light ? "#EAF3FF" : "#0B1020";
  };
  paintThemeButton();
  themeBtn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("caption-studio-theme", next);
    paintThemeButton();
  });
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", (event) => {
    if (localStorage.getItem("caption-studio-theme")) return;
    document.documentElement.dataset.theme = event.matches ? "light" : "dark";
    paintThemeButton();
  });
  go.addEventListener("click", () => makeVideo());
  document.getElementById("share").addEventListener("click", () => shareResult());
  if (isIos()) go.textContent = "Save to Camera Roll";
  document.body.addEventListener("click", (event) => {
    const step = event.target.closest("[data-step]");
    if (step?.dataset.step) goTo(step.dataset.step);
    const next = event.target.closest("[data-next]");
    if (next?.dataset.next) goTo(next.dataset.next);
  });
  document.getElementById("quality").addEventListener("click", (event) => {
    const button = event.target.closest("[data-quality]");
    if (!button) return;
    state.quality = button.dataset.quality === "1080" ? "1080" : "720";
    document.querySelectorAll("[data-quality]").forEach((node) => node.classList.toggle("on", node === button));
    resizeCanvas();
    rememberSettings();
    restartPreview();
  });
  document.getElementById("motion").addEventListener("change", () => {
    state.motion = document.getElementById("motion").value;
    rememberSettings();
    restartPreview();
  });
  document.getElementById("letterbox").addEventListener("change", () => {
    state.letterbox = document.getElementById("letterbox").checked;
    rememberSettings();
    restartPreview();
  });
  document.getElementById("resume").addEventListener("click", () => resumeSaved(false));
  document.getElementById("lighter").addEventListener("click", () => resumeSaved(true));
  document.getElementById("forget").addEventListener("click", () => startOver());
  document.getElementById("readSpeech").addEventListener("click", () => scheduleSpeech(true));
}

function selectGroup(selector, button, kind) {
  document.querySelectorAll(selector).forEach((node) => {
    node.classList.remove("selected");
    if (kind) node.setAttribute("aria-pressed", "false");
  });
  button.classList.add("selected");
  if (kind) button.setAttribute("aria-pressed", "true");
}

function setOrient(vertical, options = {}) {
  state.vertical = vertical;
  document.getElementById("land").classList.toggle("on", !vertical);
  document.getElementById("vert").classList.toggle("on", vertical);
  resizeCanvas();
  if (!options.silent) {
    rememberSettings();
    restartPreview();
  }
}

function outputSpec() {
  const choice = OUTPUTS[state.quality] || OUTPUTS["720"];
  const [width, height] = state.vertical ? choice.vertical : choice.landscape;
  return { width, height, bitrate: choice.bitrate, label: choice.label };
}

function resizeCanvas() {
  const out = outputSpec();
  if (state.file) {
    stageFrame.classList.add("has-media");
    stageFrame.style.setProperty("--frame-w", String(out.width));
    stageFrame.style.setProperty("--frame-h", String(out.height));
  } else {
    stageFrame.classList.remove("has-media");
  }
  const rect = stageFrame.getBoundingClientRect();
  const cssW = Math.max(2, Math.round(rect.width || 320));
  const cssH = Math.max(2, Math.round(rect.height || cssW * out.height / out.width));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(2, Math.round(cssW * dpr));
  const height = Math.max(2, Math.round(cssH * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    lastPaintKey = "";
  }
}

function goTo(step) {
  if (step !== "upload" && !state.file) {
    setStatus("Add a photo or video first.", true);
    return;
  }
  document.querySelectorAll("[data-step]").forEach((node) => node.classList.toggle("on", node.dataset.step === step));
  document.querySelectorAll("[data-step-panel]").forEach((node) => {
    node.hidden = node.dataset.stepPanel !== step;
  });
  if (step === "captions") renderLines();
  if (step === "export") updateExportSummary();
  state.step = step;
}

function setStatus(message, isError = false) {
  statusEl.textContent = message || "";
  statusEl.className = "status" + (isError ? " err" : "");
  studio.phase = isError ? "error" : studio.phase;
  if (isError) studio.error = message;
}

function setProgress(ratio) {
  if (ratio == null) {
    bar.style.display = "none";
    return;
  }
  bar.style.display = "block";
  barFill.style.width = `${Math.max(0, Math.min(100, ratio * 100))}%`;
}

function openEdit(show) {
  const fold = document.getElementById("editWords");
  const note = document.getElementById("noSpeech");
  if (fold && show) fold.open = true;
  if (note) note.hidden = !show;
}

function clock(seconds) {
  const safe = Math.max(0, seconds || 0);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function heardLine() {
  if (!state.transcript) return "A few short words work best.";
  return `Heard: ${state.transcript}`;
}

function currentSettings() {
  return {
    text: textEl.value,
    styleId: state.styleId,
    paletteId: state.paletteId,
    hex: hexEl.value,
    animation: state.animation,
    placement: state.placement,
    placeMode: state.placeMode,
    vertical: state.vertical,
    quality: state.quality,
    motion: state.motion,
    letterbox: state.letterbox,
    lang: langEl.value,
    accuracy: accuracyEl.value === "fast" ? "fast" : "best",
    cta: ctaEl.value,
    emoji: emojiEl.checked,
    scrubTime: state.scrubTime,
  };
}

let saveEpoch = 0;
let saveChain = Promise.resolve();

function guarded(work) {
  const epoch = saveEpoch;
  const job = saveChain.then(async () => {
    if (epoch !== saveEpoch) return;
    await work();
    if (epoch !== saveEpoch) await clearSession().catch(() => {});
  }).catch(() => {});
  saveChain = job;
  studio.whenSaved = job;
  return job;
}

function rememberSettings() {
  const snapshot = currentSettings();
  studio.styleId = snapshot.styleId;
  return guarded(() => saveSettings(snapshot));
}

function rememberMedia() {
  if (!state.file) return Promise.resolve();
  const file = state.file;
  const record = {
    blob: file,
    name: file.name,
    type: file.type || "",
    size: file.size,
    lastModified: file.lastModified || Date.now(),
    kind: state.kind,
    duration: state.duration,
    sourceWidth: state.sourceWidth,
    sourceHeight: state.sourceHeight,
  };
  return guarded(async () => {
    try {
      await saveMedia(record);
    } catch {
      setStatus("This clip is too large to keep after a reload, but you can still use it now.");
    }
  });
}

function rememberVoice() {
  const voice = state.voiceFile;
  const record = voice ? { blob: voice, name: voice.name, type: voice.type || "" } : null;
  return guarded(() => saveVoice(record));
}

function rememberCaptions() {
  const record = {
    transcript: state.transcript || "",
    heardWords: state.heardWords || [],
  };
  return guarded(() => saveCaptions(record));
}

function releaseImage() {
  if (state.image && typeof state.image.close === "function") state.image.close();
  state.image = null;
}

async function restoreSession() {
  try {
    setStatus("Opening your saved clip…");
    const saved = await loadSession();
    const media = saved?.media;
    if (!media?.blob) {
      setStatus("Choose a photo or a short video to begin.");
      return;
    }
    const file = new File([media.blob], media.name || "clip", {
      type: media.type || media.blob.type || "",
      lastModified: media.lastModified || Date.now(),
    });
    state.file = file;
    state.kind = media.kind || fileKind(file);
    state.duration = media.duration || STILL_SECONDS;
    state.sourceWidth = media.sourceWidth || 1280;
    state.sourceHeight = media.sourceHeight || 720;
    state.transcript = saved.captions?.transcript || "";
    state.heardWords = Array.isArray(saved.captions?.heardWords) ? saved.captions.heardWords : [];
    if (saved.voice?.blob) {
      state.voiceFile = new File([saved.voice.blob], saved.voice.name || "voice", {
        type: saved.voice.type || saved.voice.blob.type || "",
      });
      attachVoiceUrl(state.voiceFile);
    } else {
      state.voiceFile = null;
      attachVoiceUrl(null);
    }
    applySettings(saved.settings || {});
    showFileName();
    heardEl.textContent = textEl.value.trim() ? "Using the caption you typed." : heardLine();
    if (state.kind === "image") {
      state.image = await loadImage(file);
      state.sourceWidth = state.image.width || state.sourceWidth;
      state.sourceHeight = state.image.height || state.sourceHeight;
    } else if (state.kind === "video") {
      attachPreviewUrl(file);
    }
    studio.duration = state.duration;
    studio.transcript = state.transcript;
    studio.words = activeWords();
    studio.restored = true;
    resizeCanvas();
    applyPreviewLevels();
    await restartPreview();
    updateReadButton();
    setStatus(state.heardWords.length || textEl.value.trim()
      ? "Your clip is back. Press play when you want to watch it."
      : "Your clip is back. Press Read the speech when you want captions.");
  } catch (error) {
    console.warn("Could not restore the saved clip.", error);
    setStatus("Choose a photo or a short video to begin.");
  } finally {
    studio.ready = true;
  }
}

function applySettings(settings) {
  state.styleId = settings.styleId || catalog.defaultStyle;
  state.paletteId = settings.paletteId || catalog.defaultPalette;
  state.animation = settings.animation || "";
  state.placement = settings.placement || "auto";
  state.placeMode = settings.placeMode === "bottom" ? "bottom" : "move";
  document.querySelectorAll("[data-place-mode]").forEach((node) => {
    node.classList.toggle("on", node.dataset.placeMode === state.placeMode);
  });
  state.vertical = Boolean(settings.vertical);
  state.quality = settings.quality === "1080" ? "1080" : "720";
  state.motion = settings.motion || "";
  state.letterbox = Boolean(settings.letterbox);
  state.scrubTime = Number.isFinite(settings.scrubTime) ? settings.scrubTime : state.scrubTime;
  textEl.value = settings.text || "";
  hexEl.value = settings.hex || "";
  ctaEl.value = settings.cta || "";
  emojiEl.checked = Boolean(settings.emoji);
  if (settings.lang) langEl.value = settings.lang;
  if (settings.accuracy === "fast" || settings.accuracy === "best") accuracyEl.value = settings.accuracy;
  else if (settings.model === "tiny") accuracyEl.value = "fast";
  const motion = document.getElementById("motion");
  if (motion) motion.value = state.motion;
  const letter = document.getElementById("letterbox");
  if (letter) letter.checked = state.letterbox;
  document.querySelectorAll("[data-quality]").forEach((node) => {
    node.classList.toggle("on", node.dataset.quality === state.quality);
  });
  studio.styleId = state.styleId;
  reflectControls();
  setOrient(state.vertical, { silent: true });
}

function reflectControls() {
  document.querySelectorAll("[data-style]").forEach((node) => {
    const on = node.dataset.style === state.styleId;
    node.classList.toggle("selected", on);
    node.setAttribute("aria-pressed", on ? "true" : "false");
  });
  document.querySelectorAll("[data-color]").forEach((node) => {
    node.classList.toggle("selected", node.dataset.color === state.paletteId);
  });
  const palette = catalog.palettes[state.paletteId];
  colorLabel.textContent = palette?.label || state.paletteId || "Pearl";
  document.querySelectorAll("[data-animation]").forEach((node) => {
    const on = (node.dataset.animation || "") === (state.animation || "");
    node.classList.toggle("selected", on);
    node.setAttribute("aria-pressed", on ? "true" : "false");
  });
  document.querySelectorAll("#placements .pill").forEach((node) => {
    const on = node.dataset.placement === state.placement;
    node.classList.toggle("selected", on);
    node.setAttribute("aria-pressed", on ? "true" : "false");
  });
  document.getElementById("land").classList.toggle("on", !state.vertical);
  document.getElementById("vert").classList.toggle("on", state.vertical);
}

async function startOver() {
  clearBusy();
  hideRecovery();
  saveEpoch += 1;
  speechJob += 1;
  state.job += 1;
  stopPlay();
  releaseImage();
  attachPreviewUrl(null);
  attachVoiceUrl(null);
  hideResult();
  state.file = null;
  state.voiceFile = null;
  state.kind = null;
  state.pcm = null;
  state.heardWords = [];
  state.transcript = "";
  state.keepOut = [];
  state.previewStyleId = "";
  resetPlacement();
  stopCardPreview();
  state.duration = STILL_SECONDS;
  state.scrubTime = 0.2;
  textEl.value = "";
  hexEl.value = "";
  ctaEl.value = "";
  emojiEl.checked = false;
  heardEl.textContent = "A few short words work best.";
  showFileName();
  applySettings({
    styleId: catalog.defaultStyle,
    paletteId: catalog.defaultPalette,
    animation: "",
    placement: "auto",
    vertical: false,
    quality: "720",
    motion: "",
    letterbox: false,
    lang: "auto",
    model: "tiny",
  });
  goTo("upload");
  studio.words = [];
  studio.transcript = "";
  studio.restored = false;
  studio.phase = "idle";
  try { await clearSession(); } catch { /* the page is already clear */ }
  setStatus("Choose a photo or a short video to begin.");
  resizeCanvas();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function sameFile(a, b) {
  return Boolean(a && b && a.name === b.name && a.size === b.size && a.lastModified === b.lastModified);
}

function showFileName() {
  fileName.textContent = state.file ? state.file.name : "";
  document.getElementById("reset").hidden = !state.file;
  document.getElementById("stageEmpty").hidden = Boolean(state.file);
  document.getElementById("toCaptions").disabled = !state.file;
  stageFrame.classList.toggle("is-video", state.kind === "video");
  stageFrame.classList.toggle("is-photo", state.kind === "image");
  studio.fileName = state.file ? state.file.name : "";
  updateReadButton();
}

function updateReadButton() {
  const button = document.getElementById("readSpeech");
  if (!button) return;
  button.hidden = !(state.kind === "video" && state.file && !state.heardWords.length && !textEl.value.trim());
}

function previewMeta() {
  return {
    duration: previewVideo.duration,
    width: previewVideo.videoWidth,
    height: previewVideo.videoHeight,
  };
}

function waitForPreviewMeta() {
  if (previewVideo.readyState >= 1 && Number.isFinite(previewVideo.duration)) {
    return Promise.resolve(previewMeta());
  }
  return new Promise((resolve, reject) => {
    const ok = () => {
      cleanup();
      resolve(previewMeta());
    };
    const bad = () => {
      cleanup();
      reject(new Error("Could not read that video."));
    };
    const cleanup = () => {
      previewVideo.removeEventListener("loadedmetadata", ok);
      previewVideo.removeEventListener("error", bad);
    };
    previewVideo.addEventListener("loadedmetadata", ok);
    previewVideo.addEventListener("error", bad);
  });
}

function attachPreviewUrl(file) {
  if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
  state.videoUrl = "";
  previewVideo.pause();
  if (!file || state.kind !== "video") {
    previewVideo.removeAttribute("src");
    previewVideo.load();
    return;
  }
  state.videoUrl = URL.createObjectURL(file);
  previewVideo.preload = "metadata";
  previewVideo.src = state.videoUrl;
  applyPreviewLevels();
}

function attachVoiceUrl(file) {
  if (state.voiceUrl) URL.revokeObjectURL(state.voiceUrl);
  state.voiceUrl = "";
  previewVoice.pause();
  if (!file) {
    previewVoice.removeAttribute("src");
    previewVoice.load();
    applyPreviewLevels();
    return;
  }
  state.voiceUrl = URL.createObjectURL(file);
  previewVoice.preload = "metadata";
  previewVoice.src = state.voiceUrl;
  applyPreviewLevels();
}

function applyPreviewLevels() {
  const voiceOn = Boolean(state.voiceFile);
  previewVideo.muted = state.userMuted || voiceOn;
  previewVideo.volume = 1;
  previewVoice.muted = state.userMuted || !voiceOn;
  previewVoice.volume = 1;
  const button = document.getElementById("mute");
  if (!button) return;
  button.textContent = state.userMuted ? "Sound" : "Mute";
  button.setAttribute("aria-pressed", state.userMuted ? "true" : "false");
  button.setAttribute("aria-label", state.userMuted ? "Unmute preview" : "Mute preview");
  studio.userMuted = state.userMuted;
}

function toggleMute() {
  state.userMuted = !state.userMuted;
  resumeAudioContext();
  applyPreviewLevels();
}

async function onFile(file) {
  if (sameFile(state.file, file)) return;
  speechJob += 1;
  if (file.size > MAX_BYTES) {
    setStatus("Please keep files to 300 MB or less.", true);
    return;
  }
  stopPlay();
  releaseImage();
  state.file = file;
  state.kind = fileKind(file);
  state.keepOut = [];
  resetPlacement();
  state.heardWords = [];
  state.transcript = "";
  state.pcm = null;
  showFileName();
  heardEl.textContent = "A few short words work best.";
  hideResult();
  const job = ++state.job;
  try {
    if (state.kind === "image") {
      setStatus("Reading your photo…");
      state.image = await loadImage(file);
      state.sourceWidth = state.image.width;
      state.sourceHeight = state.image.height;
      state.duration = STILL_SECONDS;
      setOrient(state.image.height > state.image.width, { silent: true });
    } else if (state.kind === "video") {
      setStatus("Reading your video…");
      attachPreviewUrl(file);
      const meta = await waitForPreviewMeta();
      if (!Number.isFinite(meta.duration) || meta.duration <= 0.05) {
        throw new Error("Could not read the length of that video.");
      }
      if (meta.duration > MAX_SECONDS + 0.25) {
        throw new Error(`Please keep videos to 5 minutes or less (this one is ${Math.round(meta.duration / 60)} min).`);
      }
      state.duration = meta.duration;
      state.sourceWidth = meta.width || state.sourceWidth;
      state.sourceHeight = meta.height || state.sourceHeight;
      setOrient(state.sourceHeight > state.sourceWidth, { silent: true });
      if (job !== state.job) return;
    } else {
      throw new Error("Please upload a video (mp4, mov, webm) or an image (png, jpg, webp).");
    }
    if (job !== state.job) return;
    studio.duration = state.duration;
    state.scrubTime = Math.min(0.35, state.duration * 0.15);
    await rememberMedia();
    rememberSettings();
    await restartPreview();
    if (state.kind === "image" && !state.voiceFile) openEdit(true);
    scheduleSpeech();
  } catch (error) {
    if (job !== state.job) return;
    setStatus(error.message || "Could not open that file.", true);
  }
}

async function onAudio(file) {
  if (!file) {
    state.voiceFile = null;
    attachVoiceUrl(null);
    if (state.kind === "image") state.duration = STILL_SECONDS;
    rememberVoice();
    restartPreview();
    return;
  }
  if (sameFile(state.voiceFile, file)) return;
  if (file.size > MAX_BYTES) {
    setStatus("Please keep files to 300 MB or less.", true);
    return;
  }
  speechJob += 1;
  const job = ++state.job;
  try {
    setStatus("Reading the voice track…");
    if (job !== state.job) return;
    state.voiceFile = file;
    attachVoiceUrl(file);
    state.pcm = null;
    state.heardWords = [];
    state.transcript = "";
    await rememberVoice();
    await restartPreview();
    scheduleSpeech();
  } catch (error) {
    if (job !== state.job) return;
    setStatus(error.message || "Could not read that audio.", true);
  }
}

let speechJob = 0;

async function scheduleSpeech(force) {
  const job = ++speechJob;
  const typed = textEl.value.trim();
  const source = state.voiceFile || (state.kind === "video" ? state.file : null);
  if (!force && (typed || state.heardWords.length || !source)) {
    if (!typed && !state.heardWords.length && state.kind === "image" && !state.voiceFile) {
      setStatus("For a photo, type a short caption, or add a voice track.");
    } else if (state.file) {
      setStatus("Preview ready. It stays on this device.");
    }
    studio.words = activeWords();
    studio.transcript = state.transcript;
    updateReadButton();
    return;
  }
  if (!source) {
    setStatus("Add a video or a voice track to read the speech.", true);
    return;
  }
  setStatus("Reading the audio on this device…");
  setProgress(0.08);
  const started = performance.now();
  studio.transcribeStarts += 1;
  markBusy("transcribe");
  const light = lightDevice();
  const prefer = light ? "wasm" : undefined;
  let webgpu = false;
  if (!light) {
    const { gpuAvailable } = await import("./transcribe-core.js");
    webgpu = await gpuAvailable();
  }
  const accuracy = accuracyEl.value === "fast" ? "fast" : "best";
  const model = modelChoice({
    language: langEl.value,
    accuracy,
    webgpu,
    light,
  });
  const beams = accuracy === "best" && !light ? 2 : 1;
  studio.model = model;
  const merged = [];
  const texts = [];
  let device = "";
  let modelName = "";
  let chunkCount = 0;
  eachPcmWindow(source, 30, async ({ pcm, start }) => {
    if (job !== speechJob) return;
    chunkCount += 1;
    const result = await transcribeAudio(pcm, {
      model,
      language: langEl.value === "auto" ? null : langEl.value,
      prefer,
      beams,
      keepWorker: true,
      onProgress: (progress) => {
        if (job !== speechJob) return;
        if (progress.message) setStatus(progress.message);
        if (progress.ratio != null) setProgress(0.08 + progress.ratio * 0.7);
      },
    });
    device = result.device || device;
    modelName = result.model || modelName;
    if (result.text) texts.push(result.text.trim());
    takeWords(merged, result.chunks, start);
  }, 5).then((found) => {
    releaseTranscriber();
    clearBusy("transcribe");
    if (job !== speechJob) return;
    if (!found && !merged.length) {
      setStatus("No speech track was found. Type a caption under Edit words.", true);
      openEdit(true);
      updateReadButton();
      setProgress(null);
      return;
    }
    const result = { text: texts.join(" "), chunks: merged, device, model: modelName, chunkCount };
    state.transcript = result.text;
    state.heardWords = chunksToWords(result, state.duration);
    studio.transcript = result.text;
    studio.words = state.heardWords;
    studio.device = result.device || "";
    studio.model = result.model || "";
    studio.chunkCount = result.chunkCount || 1;
    studio.transcribeMs = performance.now() - started;
    heardEl.textContent = textEl.value.trim()
      ? "Using the caption you typed."
      : (state.heardWords.length ? "Captions follow the words as they are spoken." : "No speech detected. Type a caption under Edit words.");
    openEdit(!state.heardWords.length && !textEl.value.trim());
    setProgress(null);
    setStatus(state.heardWords.length
      ? `Transcript ready${result.device ? ` (${result.device})` : ""}. Captions follow the speech.`
      : "No speech detected. Type a caption under Edit words.");
    rememberCaptions();
    renderLines();
    return restartPreview();
  }).catch((error) => {
    releaseTranscriber();
    if (job !== speechJob) return;
    clearBusy("transcribe");
    studio.error = error.message;
    setStatus(error.message || "Could not transcribe that audio. You can type the caption instead.", true);
  });
}

function renderLines() {
  const root = document.getElementById("lines");
  if (!root) return;
  root.replaceChildren();
  if (!state.heardWords.length) {
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = "The transcript shows up here. You can correct any line.";
    root.append(note);
    return;
  }
  const groups = groupWords(state.heardWords, 5);
  groups.forEach((group) => {
    const row = document.createElement("label");
    row.className = "line";
    const time = document.createElement("span");
    time.textContent = clock(group.start);
    const input = document.createElement("input");
    input.type = "text";
    input.value = group.words.map((word) => word.text).join(" ");
    input.addEventListener("change", () => commitLines());
    row.append(time, input);
    root.append(row);
  });
}

function commitLines() {
  const inputs = [...document.querySelectorAll("#lines input")];
  const groups = groupWords(state.heardWords, 5);
  const next = [];
  inputs.forEach((input, index) => {
    const group = groups[index];
    if (!group) return;
    const tokens = input.value.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return;
    const span = Math.max(0.2, group.end - group.start);
    const slot = span / tokens.length;
    tokens.forEach((token, i) => {
      const start = group.start + i * slot;
      next.push({ text: token, start, end: start + slot });
    });
  });
  if (!next.length) return;
  state.heardWords = next;
  state.transcript = next.map((word) => word.text).join(" ");
  studio.words = activeWords();
  studio.transcript = state.transcript;
  heardEl.textContent = textEl.value.trim() ? "Using the caption you typed." : heardLine();
  rememberCaptions();
  paint();
}

function updateExportSummary() {
  const node = document.getElementById("exportSummary");
  if (!node) return;
  if (!state.file) {
    node.textContent = "Add a clip to export.";
    return;
  }
  const spec = outputSpec();
  const minutes = Math.floor(state.duration / 60);
  const seconds = Math.round(state.duration % 60);
  const length = minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
  const orient = state.vertical ? "vertical" : "landscape";
  node.textContent = `${state.file.name} · ${length} · ${spec.label} ${orient}. Longer clips and 1080p take more time on a phone.`;
}

function activeWords() {
  const typed = textEl.value.trim();
  if (typed) return wordsFromText(typed, state.duration || STILL_SECONDS);
  return state.heardWords;
}

function activeScript(words) {
  if (SCRIPT_LANGS.has(langEl.value)) return langEl.value;
  return scriptForText(words.map((word) => word.text).join(" "));
}

function shownStyleId() {
  return state.previewStyleId || state.styleId;
}

function currentLook(script) {
  const raw = catalog.styles[shownStyleId()] || catalog.styles[catalog.defaultStyle];
  const palette = paletteById(catalog, state.paletteId);
  const look = resolveLook(raw, palette, state.vertical);
  const scriptFile = scriptFontFile(script);
  if (scriptFile) {
    const family = familyName(scriptFile);
    look.bodyFamily = family;
    look.displayFamily = family;
    look.bodyFile = scriptFile;
    look.displayFile = scriptFile;
  }
  if (state.motion) look.motion = state.motion;
  return { look, animation: state.animation || look.animation };
}

async function restartPreview() {
  if (!state.file) return;
  resizeCanvas();
  const words = activeWords();
  const script = activeScript(words);
  const { look } = currentLook(script);
  const files = [
    look.bodyFile,
    look.displayFile,
    "noto-sans/NotoSans-Regular.ttf",
    "noto-sans/NotoSans-Bold.ttf",
  ];
  await ensureFonts(files);
  if (emojiEl.checked) await ensureEmoji(words);
  paint();
  syncScrub();
  studio.words = words;
  studio.styleId = state.styleId;
  studio.transcript = state.transcript;
  studio.fileName = state.file ? state.file.name : "";
}

function sceneAt(time) {
  const words = activeWords();
  const script = activeScript(words);
  const { look, animation } = currentLook(script);
  const source = state.kind === "video" ? previewVideo : state.image;
  return {
    width: canvas.width,
    height: canvas.height,
    time,
    duration: state.duration,
    still: state.kind === "image",
    source: state.kind === "video" && previewVideo.readyState < 2 ? null : source,
    sourceWidth: state.sourceWidth,
    sourceHeight: state.sourceHeight,
    words,
    groups: groupWords(words, look.wordsPerLine),
    look,
    placement: state.placement,
    placeMode: state.placeMode,
    keepOut: state.keepOut,
    animation,
    cta: ctaEl.value.trim(),
    emojiOn: emojiEl.checked,
    emojiImages,
    letterbox: look.letterbox || state.letterbox,
    script,
  };
}

function currentPreviewTime() {
  if (state.kind === "video" && state.playing) return previewVideo.currentTime || state.scrubTime;
  return state.scrubTime;
}

function paint() {
  resizeCanvas();
  const time = currentPreviewTime();
  const key = [
    state.kind,
    state.styleId,
    state.animation,
    state.placement,
    state.paletteId,
    state.motion,
    state.letterbox,
    emojiEl.checked,
    ctaEl.value,
    textEl.value,
    canvas.width,
    canvas.height,
    Math.round(time * 20),
  ].join("|");
  if (key === lastPaintKey) return;
  lastPaintKey = key;
  const out = outputSpec();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(canvas.width / out.width, 0, 0, canvas.height / out.height, 0, 0);
  const scene = sceneAt(time);
  scene.width = out.width;
  scene.height = out.height;
  if (state.kind === "video") {
    scene.source = null;
    scene.still = false;
    drawOverlay(ctx, scene);
    return;
  }
  scene.source = state.image;
  scene.still = true;
  drawFrame(ctx, scene);
}

function syncScrub() {
  const ratio = state.duration ? state.scrubTime / state.duration : 0;
  scrub.value = String(Math.round(Math.max(0, Math.min(1, ratio)) * 1000));
  timeLabel.textContent = clock(state.scrubTime);
}

async function ensureEmoji(words) {
  const names = new Set(burstFiles());
  for (const word of words) {
    const file = emojiFileForWord(word.text);
    if (file) names.add(file);
  }
  await Promise.all([...names].map(async (name) => {
    if (emojiImages[name]) return;
    emojiImages[name] = await loadImageFile(`./emoji/${name}`);
  }));
}

function loadImageFile(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load an emoji."));
    image.src = url;
  });
}

let playOrigin = 0;
let playFrom = 0;

function togglePlay() {
  if (!state.file) return;
  resumeAudioContext();
  applyPreviewLevels();
  if (state.playing) {
    stopPlay();
    return;
  }
  setPlaying(true);
  if (state.voiceFile) {
    try { previewVoice.currentTime = state.scrubTime; } catch { /* the voice element may not be ready yet */ }
    previewVoice.play().catch(() => {});
  }
  if (state.kind === "video") {
    try { previewVideo.currentTime = state.scrubTime; } catch { /* the element may not be ready yet */ }
    previewVideo.play().then(() => {
      requestAnimationFrame(tickVideo);
    }).catch(() => stopPlay());
  } else {
    playOrigin = performance.now();
    playFrom = state.scrubTime;
    requestAnimationFrame(tickStill);
  }
}

function setPlaying(on) {
  state.playing = on;
  playBtn.classList.toggle("is-playing", on);
  playBtn.setAttribute("aria-label", on ? "Pause preview" : "Play preview");
}

function stopPlay() {
  setPlaying(false);
  previewVideo.pause();
  previewVoice.pause();
}

function syncVoiceClock(time) {
  if (!state.voiceFile || !state.playing) return;
  if (previewVoice.paused && !state.userMuted) previewVoice.play().catch(() => {});
  if (Number.isFinite(previewVoice.duration) && time >= previewVoice.duration) return;
  if (Math.abs((previewVoice.currentTime || 0) - time) > 0.35) {
    try { previewVoice.currentTime = time; } catch { /* seek can wait */ }
  }
}

function tickVideo() {
  if (!state.playing) return;
    state.scrubTime = previewVideo.currentTime || 0;
  syncVoiceClock(state.scrubTime);
  maybeSample();
  paint();
  syncScrub();
  requestAnimationFrame(tickVideo);
}

function tickStill(now) {
  if (!state.playing) return;
  let time = playFrom + (now - playOrigin) / 1000;
  if (time >= state.duration) {
    time = 0;
    playFrom = 0;
    playOrigin = now;
  }
  state.scrubTime = time;
  syncVoiceClock(time);
  maybeSample();
  paint();
  syncScrub();
  requestAnimationFrame(tickStill);
}

function markStyleCards() {
  const actions = document.getElementById("styleActions");
  const previewing = state.previewStyleId && state.previewStyleId !== state.styleId;
  if (actions) actions.hidden = !previewing;
  document.querySelectorAll("[data-style]").forEach((node) => {
    const applied = node.dataset.style === state.styleId;
    const preview = node.dataset.style === state.previewStyleId;
    node.classList.toggle("selected", applied);
    node.classList.toggle("previewing", preview);
    node.setAttribute("aria-pressed", applied ? "true" : "false");
    const live = node.querySelector(".style-live");
    if (live && !preview) live.hidden = true;
  });
}

function applyStyle() {
  if (!state.previewStyleId) return;
  state.styleId = state.previewStyleId;
  state.previewStyleId = "";
  studio.styleId = state.styleId;
  stopCardPreview();
  markStyleCards();
  rememberSettings();
  restartPreview();
}

function cancelStyle() {
  state.previewStyleId = "";
  stopCardPreview();
  markStyleCards();
  restartPreview();
}

let cardFrame = 0;

function stopCardPreview() {
  if (cardFrame) cancelAnimationFrame(cardFrame);
  cardFrame = 0;
}

function startCardPreview(id) {
  stopCardPreview();
  const button = document.querySelector(`[data-style="${id}"]`);
  const live = button?.querySelector(".style-live");
  if (!live) return;
  live.hidden = false;
  const ctx = live.getContext("2d", { alpha: true });
  const started = performance.now();
  const raw = catalog.styles[id] || catalog.styles[catalog.defaultStyle];
  const look = resolveLook(raw, paletteById(catalog, state.paletteId), false);
  const tick = (now) => {
    if (state.previewStyleId !== id) return;
    const time = ((now - started) / 1000) % 1.8;
    const words = [{ text: "Hello", start: 0, end: 1.8 }];
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, live.width, live.height);
    ctx.setTransform(live.width / 1280, 0, 0, live.height / 720, 0, 0);
    drawOverlay(ctx, {
      width: 1280,
      height: 720,
      time,
      duration: 1.8,
      words,
      groups: groupWords(words, look.wordsPerLine || 2),
      look,
      placement: "center",
      placeMode: "bottom",
      animation: look.animation,
      emojiOn: false,
      letterbox: false,
      script: "en",
    });
    cardFrame = requestAnimationFrame(tick);
  };
  cardFrame = requestAnimationFrame(tick);
}

let sampling = false;
let lastSampleAt = 0;

function rememberSample(time, boxes) {
  const next = state.keepOut.filter((sample) => Math.abs(sample.time - time) > 0.2);
  next.push({ time, boxes });
  next.sort((a, b) => a.time - b.time);
  if (next.length > 80) next.splice(0, next.length - 80);
  state.keepOut = next;
  studio.keepOut = next;
}

function maybeSample(force) {
  if (state.placeMode !== "move" || sampling || !state.file) return;
  const now = performance.now();
  if (!force && now - lastSampleAt < 320) return;
  const source = state.kind === "video" ? previewVideo : state.image;
  if (!source) return;
  if (state.kind === "video" && previewVideo.readyState < 2) return;
  lastSampleAt = now;
  sampling = true;
  const time = state.kind === "video" ? (previewVideo.currentTime || 0) : state.scrubTime;
  detectKeepOut(source).then((boxes) => {
    rememberSample(time, boxes);
  }).catch(() => {}).finally(() => {
    sampling = false;
  });
}

async function sampleClip() {
  if (state.placeMode !== "move" || !state.file) return;
  const source = state.kind === "video" ? previewVideo : state.image;
  if (!source) return;
  if (state.kind !== "video") {
    rememberSample(0, await detectKeepOut(source));
    return;
  }
  const steps = Math.min(24, Math.max(4, Math.ceil(state.duration)));
  const gap = state.duration / steps;
  const back = previewVideo.currentTime || 0;
  for (let index = 0; index < steps; index += 1) {
    const time = Math.min(state.duration - 0.05, index * gap);
    try { previewVideo.currentTime = time; } catch { break; }
    await new Promise((resolve) => {
      const done = () => {
        previewVideo.removeEventListener("seeked", done);
        resolve();
      };
      previewVideo.addEventListener("seeked", done);
      setTimeout(done, 700);
    });
    rememberSample(time, await detectKeepOut(previewVideo));
  }
  try { previewVideo.currentTime = back; } catch { /* leave the playhead */ }
}

function hideResult() {
  result.style.display = "none";
  if (state.resultUrl) {
    URL.revokeObjectURL(state.resultUrl);
    state.resultUrl = "";
  }
  player.removeAttribute("src");
  player.load();
}

async function shareResult() {
  const file = studio.lastFile;
  if (!file || typeof navigator.share !== "function") {
    setStatus("This browser will download the file instead.", true);
    return;
  }
  try {
    await navigator.share({ files: [file], title: "Captioned video" });
    setStatus("Choose Save Video to put it in your camera roll.");
  } catch (error) {
    if (error?.name === "AbortError") return;
    setStatus("Could not open the share sheet. Use Download MP4.", true);
  }
}

async function makeVideo() {
  if (!state.file) {
    setStatus("Please upload a video or an image first.", true);
    return;
  }
  if (state.file.size > MAX_BYTES) {
    setStatus("Please keep files to 300 MB or less.", true);
    return;
  }
  const words = activeWords();
  if (!words.length) {
    setStatus(state.kind === "image"
      ? "For a photo, add a short caption or a voice track."
      : "Type a caption, or wait for the speech transcript.", true);
    return;
  }
  releaseTranscriber();
  if (state.previewStyleId) applyStyle();
  stopPlay();
  await sampleClip();
  await unloadVision();
  resetPlacement();
  markBusy("render");
  go.disabled = true;
  studio.phase = "rendering";
  studio.error = null;
  hideResult();
  const spec = outputSpec();
  setStatus(`Rendering a ${spec.label} MP4 on this device…`);
  setProgress(0.02);
  const started = performance.now();
  try {
    await restartPreview();
    const script = activeScript(words);
    const { look, animation } = currentLook(script);
    const audioFile = state.voiceFile || (state.kind === "video" ? state.file : null);
    const scene = {
      words,
      groups: groupWords(words, look.wordsPerLine),
      look,
      placement: state.placement,
      placeMode: state.placeMode,
      keepOut: state.keepOut,
      animation,
      cta: ctaEl.value.trim(),
      emojiOn: emojiEl.checked,
      emojiImages,
      letterbox: look.letterbox || state.letterbox,
      script,
    };
    const rendered = await renderMp4({
      width: spec.width,
      height: spec.height,
      bitrate: spec.bitrate,
      duration: state.duration,
      still: state.kind === "image",
      image: state.image,
      imageWidth: state.sourceWidth,
      imageHeight: state.sourceHeight,
      file: state.file,
      audioFile,
      scene,
    }, (ratio) => {
      setProgress(0.05 + ratio * 0.95);
      setStatus(`Rendering a ${spec.label} MP4 on this device… ${Math.round(ratio * 100)}%`);
    });
    const blob = rendered.blob;
    studio.renderMs = performance.now() - started;
    studio.lastBlob = blob;
    studio.audioCodec = rendered.audioCodec;
    studio.words = words;
    studio.phase = "done";
    if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
    state.resultUrl = URL.createObjectURL(blob);
    player.src = state.resultUrl;
    save.href = state.resultUrl;
    const file = new File([blob], "captioned.mp4", { type: "video/mp4" });
    studio.lastFile = file;
    result.style.display = "block";
    const heardAudio = Boolean(audioFile);
    const audioNote = heardAudio && !rendered.audioCodec
      ? " This browser could not add the sound, so the file is silent."
      : "";
    const shareBtn = document.getElementById("share");
    const canShare = typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
    shareBtn.hidden = !canShare;
    let shared = false;
    if (canShare) {
      try {
        await navigator.share({ files: [file], title: "Captioned video" });
        shared = true;
      } catch (error) {
        if (error?.name !== "AbortError") shared = false;
      }
    }
    setStatus(shared
      ? `Choose Save Video to put it in your camera roll.${audioNote}`
      : (canShare
        ? `Tap Save to Camera Roll, then choose Save Video.${audioNote}`
        : `Ready to download. The file never left this device.${audioNote}`));
    setProgress(1);
    result.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    studio.error = error?.message || String(error);
    setStatus(studio.error, true);
  } finally {
    clearBusy("render");
    go.disabled = false;
  }
}
