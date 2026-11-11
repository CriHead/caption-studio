let sequence = 0;
let preferPromise = null;
let worker = null;

const SAMPLE_RATE = 16000;
const CHUNK_SECONDS = 30;
const OVERLAP_SECONDS = 5;

export function modelChoice({ language, accuracy, webgpu, light }) {
  const english = language === "en";
  const fast = accuracy === "fast";
  if (fast) return english ? "tiny.en" : "tiny";
  if (webgpu && !light) return english ? "small.en" : "small";
  return english ? "base.en" : "base";
}

export function takeWords(merged, chunks, offset = 0) {
  for (const chunk of chunks || []) {
    const text = String(chunk.text || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const start = (Number(chunk.timestamp?.[0]) || 0) + offset;
    const end = Math.max(start + 0.04, (Number(chunk.timestamp?.[1]) || start) + offset);
    const prev = merged[merged.length - 1];
    const mid = (start + end) / 2;
    if (prev && mid <= prev.end - 0.03) continue;
    const norm = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    const prevNorm = prev ? String(prev.text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "") : "";
    if (prev && norm && norm === prevNorm && Math.abs(start - prev.start) < 0.5) continue;
    const recent = merged.slice(-4).map((word) => String(word.text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""));
    if (norm && recent.length >= 3 && recent.every((word) => word === norm)) continue;
    merged.push({ text, start, end, timestamp: [start, end] });
  }
  return merged;
}

async function devicePreference() {
  if (!preferPromise) {
    preferPromise = import("./transcribe-core.js").then(({ gpuAvailable }) => gpuAvailable().then((yes) => (yes ? "webgpu" : "wasm")));
  }
  return preferPromise;
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./transcribe.worker.js", import.meta.url), { type: "module" });
  worker.addEventListener("error", () => releaseWorker());
  return worker;
}

function releaseWorker() {
  if (!worker) return;
  worker.terminate();
  worker = null;
}

export function releaseTranscriber() {
  releaseWorker();
}

/**
 * Transcribe in 30-second pieces so a long clip does not run as one giant pass.
 * The speech model stays loaded for the whole clip, then the worker is closed.
 */
export async function transcribeAudio(pcm, options) {
  const duration = pcm.length / SAMPLE_RATE;
  const onePass = duration <= CHUNK_SECONDS + OVERLAP_SECONDS + 1;
  const chunkCount = onePass ? 1 : Math.max(1, Math.ceil(duration / CHUNK_SECONDS));
  const merged = [];
  const texts = [];
  let device = "";
  let model = "";

  try {
    for (let index = 0; index < chunkCount; index++) {
      const from = onePass || index === 0 ? 0 : index * CHUNK_SECONDS - OVERLAP_SECONDS;
      const to = onePass ? duration : Math.min(duration, (index + 1) * CHUNK_SECONDS);
      const slice = pcm.subarray(Math.floor(from * SAMPLE_RATE), Math.ceil(to * SAMPLE_RATE));
      options.onProgress?.({
        message: chunkCount > 1
          ? `Transcribing on this device… part ${index + 1} of ${chunkCount}`
          : "Transcribing speech on this device…",
        ratio: index / chunkCount,
        chunkCount,
      });
      const result = await transcribeSlice(slice, { ...options, beams: options.beams });
      device = result.device || device;
      model = result.model || model;
      if (result.text) texts.push(result.text.trim());
      takeWords(merged, result.chunks, from);
    }
  } finally {
    if (!options.keepWorker) releaseWorker();
  }

  return {
    text: texts.join(" ").replace(/\s+/g, " ").trim(),
    chunks: merged,
    device,
    model,
    chunkCount,
  };
}

function transcribeSlice(pcm, options) {
  return new Promise((resolve, reject) => {
    let current;
    try {
      current = getWorker();
    } catch (error) {
      transcribeOnMain(pcm, options).then(resolve, reject);
      return;
    }
    const id = ++sequence;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      current.removeEventListener("message", onMessage);
      fn(value);
    };
    const timer = setTimeout(() => {
      releaseWorker();
      finish(reject, new Error("Transcription took too long. Try the Tiny model or a shorter clip."));
    }, 12 * 60 * 1000);
    const onMessage = (event) => {
      const message = event.data || {};
      if (message.id !== id) return;
      if (message.type === "progress") options.onProgress?.(message);
      if (message.type === "result") finish(resolve, message);
      if (message.type === "error") finish(reject, new Error(message.message || "Transcription failed."));
    };
    current.addEventListener("message", onMessage);
    const chosen = options.prefer
      ? Promise.resolve(options.prefer)
      : devicePreference();
    chosen.then((prefer) => {
      if (settled) return;
      const ownsBuffer = pcm instanceof Float32Array
        && pcm.byteOffset === 0
        && pcm.byteLength === pcm.buffer.byteLength;
      const copy = ownsBuffer ? pcm : new Float32Array(pcm);
      const transfer = copy.buffer;
      current.postMessage({
        type: "transcribe",
        id,
        audio: copy,
        model: options.model,
        language: options.language,
        beams: options.beams,
        prefer,
      }, [transfer]);
    });
  });
}

async function transcribeOnMain(pcm, options) {
  const { runTranscription, gpuAvailable } = await import("./transcribe-core.js");
  const prefer = await gpuAvailable() ? "webgpu" : "wasm";
  return runTranscription({
    audio: pcm,
    model: options.model,
    language: options.language,
    prefer: options.prefer || prefer,
    beams: options.beams,
    onProgress: options.onProgress,
  });
}
