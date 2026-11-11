let sequence = 0;
let preferPromise = null;
let worker = null;

const SAMPLE_RATE = 16000;
const CHUNK_SECONDS = 30;
const OVERLAP_SECONDS = 3;

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
  const chunkCount = Math.max(1, Math.ceil(duration / CHUNK_SECONDS));
  const merged = [];
  const texts = [];
  let device = "";
  let model = "";
  let lastEnd = 0;

  try {
    for (let index = 0; index < chunkCount; index++) {
      const from = index === 0 ? 0 : index * CHUNK_SECONDS - OVERLAP_SECONDS;
      const to = Math.min(duration, (index + 1) * CHUNK_SECONDS);
      const slice = pcm.subarray(Math.floor(from * SAMPLE_RATE), Math.ceil(to * SAMPLE_RATE));
      options.onProgress?.({
        message: chunkCount > 1
          ? `Transcribing on this device… part ${index + 1} of ${chunkCount}`
          : "Transcribing speech on this device…",
        ratio: index / chunkCount,
        chunkCount,
      });
      const result = await transcribeSlice(slice, options);
      device = result.device || device;
      model = result.model || model;
      if (result.text) texts.push(result.text.trim());
      for (const chunk of result.chunks || []) {
        const start = (Number(chunk.timestamp?.[0]) || 0) + from;
        const end = Math.max(start + 0.05, (Number(chunk.timestamp?.[1]) || Number(chunk.timestamp?.[0]) || 0) + from);
        if (start + 0.08 < lastEnd) continue;
        merged.push({ text: chunk.text, timestamp: [start, end] });
        lastEnd = end;
      }
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
    prefer,
    onProgress: options.onProgress,
  });
}
