import catalog from "./catalog.json";
import { groupWords, wordsFromText, chunksToWords } from "./captions.js";
import { drawFrame, paletteById, resolveLook } from "./draw.js";
import { burstFiles, emojiFileForWord } from "./emoji.js";
import { ensureFonts, familyName, scriptFontFile, scriptForText } from "./fonts.js";
import { decodeAudio, fileKind, loadImage, probeVideo, sliceAudio, toMono16k } from "./media.js";
import { renderMp4 } from "./render.js";
import { transcribeAudio } from "./transcribe.js";

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_SECONDS = 60;
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
const ctx = canvas.getContext("2d", { alpha: false });
const previewSection = document.getElementById("previewSection");
const playBtn = document.getElementById("play");
const scrub = document.getElementById("scrub");
const timeLabel = document.getElementById("timeLabel");
const hexEl = document.getElementById("hex");
const colorLabel = document.getElementById("colorLabel");
const langEl = document.getElementById("lang");
const modelEl = document.getElementById("model");
const ctaEl = document.getElementById("cta");
const emojiEl = document.getElementById("emoji");

const studio = {
  ready: true,
  phase: "idle",
  words: [],
  transcript: "",
  device: "",
  model: "",
  transcribeMs: 0,
  renderMs: 0,
  lastBlob: null,
  error: null,
};
window.__studio = studio;

const state = {
  styleId: catalog.defaultStyle,
  paletteId: catalog.defaultPalette,
  animation: "",
  placement: "auto",
  vertical: false,
  kind: null,
  file: null,
  image: null,
  videoUrl: "",
  duration: STILL_SECONDS,
  sourceWidth: 1280,
  sourceHeight: 720,
  audioBuffer: null,
  pcm: null,
  heardWords: [],
  transcript: "",
  job: 0,
  playing: false,
  scrubTime: 0.2,
  resultUrl: "",
};

const previewVideo = document.createElement("video");
previewVideo.playsInline = true;
previewVideo.loop = true;
previewVideo.preload = "auto";

const emojiImages = {};

buildChoices();
wire();
setStatus("Choose a photo or a short video to begin.");

function buildChoices() {
  const styles = document.getElementById("styles");
  for (const item of catalog.styleList) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "style" + (item.id === state.styleId ? " selected" : "");
    button.dataset.style = item.id;
    button.setAttribute("aria-pressed", item.id === state.styleId ? "true" : "false");
    button.innerHTML = `<img src="./previews/${item.id}.png" alt=""><div class="meta"><b></b><small></small></div>`;
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
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) onFile(fileInput.files[0]);
  });
  audioInput.addEventListener("change", () => onAudio(audioInput.files[0] || null));
  textEl.addEventListener("input", () => {
  heardEl.textContent = textEl.value.trim() ? "Using the caption you typed." : heardLine();
  if (textEl.value.trim() && state.file) setStatus("Preview ready. It stays on this device.");
  restartPreview();
  });
  document.getElementById("styles").addEventListener("click", (event) => {
    const button = event.target.closest("[data-style]");
    if (!button) return;
    selectGroup("[data-style]", button, "style");
    state.styleId = button.dataset.style;
    restartPreview();
  });
  document.getElementById("swatches").addEventListener("click", (event) => {
    const button = event.target.closest("[data-color]");
    if (!button) return;
    selectGroup("[data-color]", button);
    state.paletteId = button.dataset.color;
    hexEl.value = "";
    colorLabel.textContent = button.getAttribute("aria-label");
    restartPreview();
  });
  hexEl.addEventListener("input", () => {
    const value = hexEl.value.trim();
    if (!value) return;
    state.paletteId = value;
    document.querySelectorAll("[data-color]").forEach((node) => node.classList.remove("selected"));
    colorLabel.textContent = value;
    restartPreview();
  });
  document.getElementById("animations").addEventListener("click", (event) => {
    const button = event.target.closest("[data-animation]");
    if (!button) return;
    selectGroup("[data-animation]", button, "animation");
    state.animation = button.dataset.animation || "";
    restartPreview();
  });
  document.getElementById("placements").addEventListener("click", (event) => {
    const button = event.target.closest("[data-placement]");
    if (!button) return;
    selectGroup("#placements .pill", button, "placement");
    state.placement = button.dataset.placement || "auto";
    restartPreview();
  });
  langEl.addEventListener("change", () => scheduleSpeech());
  modelEl.addEventListener("change", () => scheduleSpeech());
  ctaEl.addEventListener("input", () => restartPreview());
  emojiEl.addEventListener("change", () => restartPreview());
  document.getElementById("land").addEventListener("click", () => setOrient(false));
  document.getElementById("vert").addEventListener("click", () => setOrient(true));
  playBtn.addEventListener("click", togglePlay);
  scrub.addEventListener("input", () => {
    state.playing = false;
    playBtn.textContent = "Play";
    previewVideo.pause();
    state.scrubTime = (Number(scrub.value) / 1000) * state.duration;
    if (state.kind === "video") {
      previewVideo.currentTime = state.scrubTime;
    }
    syncScrub();
    paint();
  });
  previewVideo.addEventListener("loadeddata", () => {
    if (state.kind === "video" && !state.playing) paint();
  });
  previewVideo.addEventListener("timeupdate", () => {
    if (!state.playing || state.kind !== "video") return;
    state.scrubTime = previewVideo.currentTime || 0;
    syncScrub();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    makeVideo();
  });
}

function selectGroup(selector, button, kind) {
  document.querySelectorAll(selector).forEach((node) => {
    node.classList.remove("selected");
    if (kind) node.setAttribute("aria-pressed", "false");
  });
  button.classList.add("selected");
  if (kind) button.setAttribute("aria-pressed", "true");
}

function setOrient(vertical) {
  state.vertical = vertical;
  document.getElementById("land").classList.toggle("on", !vertical);
  document.getElementById("vert").classList.toggle("on", vertical);
  resizeCanvas();
  restartPreview();
}

function resizeCanvas() {
  canvas.width = state.vertical ? 720 : 1280;
  canvas.height = state.vertical ? 1280 : 720;
}

function setStatus(message, isError = false) {
  statusEl.textContent = message || "";
  statusEl.className = "status" + (isError ? " err" : "");
  studio.phase = isError ? "error" : studio.phase;
  if (isError) studio.error = message;
}

function setProgress(ratio) {
  bar.style.display = "block";
  barFill.style.width = `${Math.max(0, Math.min(100, ratio * 100))}%`;
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

async function onFile(file) {
  speechJob += 1;
  if (file.size > MAX_BYTES) {
    setStatus("Please keep files to 50 MB or less.", true);
    return;
  }
  stopPlay();
  state.file = file;
  state.kind = fileKind(file);
  state.heardWords = [];
  state.transcript = "";
  state.pcm = null;
  fileName.textContent = file.name;
  heardEl.textContent = "A few short words work best.";
  hideResult();
  const job = ++state.job;
  try {
    if (state.kind === "image") {
      setStatus("Reading your photo…");
      state.image = await loadImage(file);
      state.sourceWidth = state.image.width;
      state.sourceHeight = state.image.height;
      state.duration = state.audioBuffer ? Math.min(MAX_SECONDS, state.audioBuffer.duration) : STILL_SECONDS;
      if (state.image.height > state.image.width) setOrient(true);
      else setOrient(false);
    } else if (state.kind === "video") {
      setStatus("Reading your video…");
      const meta = await probeVideo(file);
      if (!Number.isFinite(meta.duration) || meta.duration <= 0.05) {
        throw new Error("Could not read the length of that video.");
      }
      if (meta.duration > MAX_SECONDS + 0.25) {
        throw new Error(`Please keep videos to ${MAX_SECONDS} seconds or less (this one is ${Math.round(meta.duration)}s).`);
      }
      state.duration = meta.duration;
      state.sourceWidth = meta.width;
      state.sourceHeight = meta.height;
      if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
      state.videoUrl = URL.createObjectURL(file);
      previewVideo.src = state.videoUrl;
      if (meta.height > meta.width) setOrient(true);
      else setOrient(false);
      setStatus("Reading the audio…");
      const decoded = await decodeAudio(file);
      if (job !== state.job) return;
      state.audioBuffer = decoded ? sliceAudio(decoded, state.duration) : null;
      state.pcm = state.audioBuffer ? toMono16k(state.audioBuffer) : null;
    } else {
      throw new Error("Please upload a video (mp4, mov, webm) or an image (png, jpg, webp).");
    }
    if (job !== state.job) return;
  previewSection.hidden = false;
  studio.duration = state.duration;
  state.scrubTime = Math.min(0.35, state.duration * 0.15);
    await restartPreview();
    scheduleSpeech();
  } catch (error) {
    if (job !== state.job) return;
    setStatus(error.message || "Could not open that file.", true);
  }
}

async function onAudio(file) {
  speechJob += 1;
  if (!file) {
    if (state.kind === "image") {
      state.audioBuffer = null;
      state.pcm = null;
      state.duration = STILL_SECONDS;
    }
    scheduleSpeech();
    return;
  }
  if (file.size > MAX_BYTES) {
    setStatus("Please keep files to 50 MB or less.", true);
    return;
  }
  const job = ++state.job;
  try {
    setStatus("Reading the voice track…");
    const decoded = await decodeAudio(file);
    if (!decoded) throw new Error("Could not read that audio file.");
    if (job !== state.job) return;
    const limit = state.kind === "video" ? state.duration : Math.min(MAX_SECONDS, decoded.duration);
    state.audioBuffer = sliceAudio(decoded, limit);
    state.pcm = toMono16k(state.audioBuffer);
    if (state.kind === "image") state.duration = Math.max(1, state.audioBuffer.duration);
    await restartPreview();
    scheduleSpeech();
  } catch (error) {
    setStatus(error.message || "Could not read that audio.", true);
  }
}

let speechJob = 0;

function scheduleSpeech() {
  const job = ++speechJob;
  const typed = textEl.value.trim();
  if (typed || !state.pcm) {
    if (!typed && state.kind === "image" && !state.pcm) {
      setStatus("For a photo, type a short caption, or add a voice track.");
    } else if (state.file) {
      setStatus("Preview ready. It stays on this device.");
    }
    studio.words = activeWords();
    studio.transcript = state.transcript;
    return;
  }
  setStatus("Transcribing speech on this device…");
  setProgress(0.08);
  const started = performance.now();
  transcribeAudio(state.pcm.slice(0), {
    model: modelEl.value,
    language: langEl.value === "auto" ? null : langEl.value,
    onProgress: (progress) => {
      if (job !== speechJob) return;
      if (progress.message) setStatus(progress.message);
      if (progress.ratio != null) setProgress(0.08 + progress.ratio * 0.5);
    },
  }).then((result) => {
    if (job !== speechJob || textEl.value.trim()) return;
    state.transcript = result.text;
    state.heardWords = chunksToWords(result, state.duration);
    studio.transcript = result.text;
    studio.words = state.heardWords;
    studio.device = result.device || "";
    studio.model = result.model || "";
    studio.transcribeMs = performance.now() - started;
    heardEl.textContent = state.heardWords.length ? heardLine() : "No speech detected. Type a caption above.";
    setProgress(0.6);
    setStatus(state.heardWords.length
      ? `Transcript ready${result.device ? ` (${result.device})` : ""}. Preview is on this device.`
      : "No speech detected. Type a caption above.");
    return restartPreview();
  }).catch((error) => {
    if (job !== speechJob) return;
    studio.error = error.message;
    setStatus(error.message || "Could not transcribe that audio. You can type the caption instead.", true);
  });
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

function currentLook(script) {
  const raw = catalog.styles[state.styleId] || catalog.styles[catalog.defaultStyle];
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
  if (!state.animation) look.motion = look.motion;
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
  previewSection.hidden = false;
  paint();
  syncScrub();
  studio.words = words;
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
    animation,
    cta: ctaEl.value.trim(),
    emojiOn: emojiEl.checked,
    emojiImages,
    letterbox: look.letterbox,
    script,
  };
}

function paint() {
  drawFrame(ctx, sceneAt(state.kind === "video" && state.playing ? previewVideo.currentTime || state.scrubTime : state.scrubTime));
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
  if (state.playing) {
    stopPlay();
    return;
  }
  state.playing = true;
  playBtn.textContent = "Pause";
  if (state.kind === "video") {
    previewVideo.currentTime = state.scrubTime;
    previewVideo.play().catch(() => stopPlay());
    requestAnimationFrame(tickVideo);
  } else {
    playOrigin = performance.now();
    playFrom = state.scrubTime;
    requestAnimationFrame(tickStill);
  }
}

function stopPlay() {
  state.playing = false;
  playBtn.textContent = "Play";
  previewVideo.pause();
}

function tickVideo() {
  if (!state.playing) return;
  state.scrubTime = previewVideo.currentTime || 0;
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
  paint();
  syncScrub();
  requestAnimationFrame(tickStill);
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

async function makeVideo() {
  if (!state.file) {
    setStatus("Please upload a video or an image first.", true);
    return;
  }
  if (state.file.size > MAX_BYTES) {
    setStatus("Please keep files to 50 MB or less.", true);
    return;
  }
  const words = activeWords();
  if (!words.length) {
    setStatus(state.kind === "image"
      ? "For a photo, add a short caption or a voice track."
      : "Type a caption, or wait for the speech transcript.", true);
    return;
  }
  stopPlay();
  go.disabled = true;
  studio.phase = "rendering";
  studio.error = null;
  hideResult();
  setStatus("Rendering a 720p MP4 on this device…");
  setProgress(0.02);
  const started = performance.now();
  try {
    await restartPreview();
    const script = activeScript(words);
    const { look, animation } = currentLook(script);
    const scene = {
      words,
      groups: groupWords(words, look.wordsPerLine),
      look,
      placement: state.placement,
      animation,
      cta: ctaEl.value.trim(),
      emojiOn: emojiEl.checked,
      emojiImages,
      letterbox: look.letterbox,
      script,
    };
    const rendered = await renderMp4({
      width: canvas.width,
      height: canvas.height,
      duration: state.duration,
      still: state.kind === "image",
      image: state.image,
      imageWidth: state.sourceWidth,
      imageHeight: state.sourceHeight,
      file: state.file,
      audioBuffer: state.audioBuffer ? sliceAudio(state.audioBuffer, state.duration) : null,
      scene,
    }, (ratio) => {
      setProgress(0.05 + ratio * 0.95);
      setStatus(`Rendering a 720p MP4 on this device… ${Math.round(ratio * 100)}%`);
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
    result.style.display = "block";
    const heardAudio = Boolean(state.audioBuffer);
    const audioNote = heardAudio && !rendered.audioCodec
      ? " This browser could not add the sound, so the file is silent."
      : "";
    setStatus(`Ready to save. The file never left this device.${audioNote}`);
    setProgress(1);
    result.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    studio.error = error?.message || String(error);
    setStatus(studio.error, true);
  } finally {
    go.disabled = false;
  }
}
