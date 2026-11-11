import { env, pipeline } from "@huggingface/transformers";

env.useBrowserCache = true;
env.allowLocalModels = false;
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
}

const MODELS = {
  tiny: "Xenova/whisper-tiny",
  base: "Xenova/whisper-base",
  "tiny.en": "Xenova/whisper-tiny.en",
  "base.en": "Xenova/whisper-base.en",
  "small.en": "Xenova/whisper-small.en",
  small: "Xenova/whisper-small",
};

const LANGUAGE_NAMES = {
  en: "english",
  es: "spanish",
  fr: "french",
  de: "german",
  it: "italian",
  pt: "portuguese",
  ar: "arabic",
  he: "hebrew",
  hi: "hindi",
  ru: "russian",
  el: "greek",
  zh: "chinese",
  ja: "japanese",
  ko: "korean",
};

const pipes = new Map();

function report(onProgress, progress) {
  if (!onProgress || !progress) return;
  const status = progress.status || "";
  if (status === "progress") {
    const pct = progress.total
      ? Math.round((100 * progress.loaded) / progress.total)
      : Math.round(progress.progress || 0);
    onProgress({
      message: `Downloading the speech model… ${pct}% (saved on this device after the first time)`,
      ratio: Math.max(0, Math.min(1, pct / 100)) * 0.35,
    });
    return;
  }
  if (status === "initiate" || status === "download") {
    onProgress({ message: "Preparing the speech model…", ratio: 0.02 });
  } else if (status === "ready" || status === "done") {
    onProgress({ message: "Speech model ready. Transcribing on this device…", ratio: 0.4 });
  }
}

async function getPipe(modelId, prefer, onProgress) {
  const key = `${modelId}:${prefer}`;
  if (pipes.has(key)) return pipes.get(key);
  const devices = prefer === "webgpu" ? ["webgpu", "wasm"] : ["wasm"];
  let lastError = null;
  for (const device of devices) {
    for (const dtype of ["q8", null]) {
      try {
        const pipe = await pipeline("automatic-speech-recognition", modelId, {
          device,
          ...(dtype ? { dtype } : {}),
          progress_callback: (progress) => report(onProgress, progress),
        });
        const ready = { pipe, device };
        pipes.set(key, ready);
        return ready;
      } catch (error) {
        lastError = error;
        console.warn("Caption Studio model load failed", device, dtype, error);
      }
    }
  }
  throw lastError || new Error("Could not load the speech model.");
}

export function resolveModelId(choice) {
  if (!choice) return MODELS["base.en"];
  if (String(choice).includes("/")) return choice;
  return MODELS[choice] || MODELS["base.en"];
}

export async function runTranscription({ audio, model, language, prefer, beams, onProgress }) {
  const modelId = resolveModelId(model);
  const englishOnly = modelId.endsWith(".en");
  onProgress?.({ message: "Loading the speech model on this device…", ratio: 0.04 });
  const { pipe, device } = await getPipe(modelId, prefer, onProgress);
  onProgress?.({ message: "Transcribing speech on this device…", ratio: 0.42 });
  const options = {
    return_timestamps: "word",
    chunk_length_s: 30,
    stride_length_s: 5,
    temperature: 0,
    condition_on_prev_tokens: true,
    no_repeat_ngram_size: 3,
    compression_ratio_threshold: 2.4,
    logprob_threshold: -1.0,
    no_speech_threshold: 0.6,
    num_beams: Math.max(1, Number(beams) || 1),
  };
  if (!englishOnly) {
    options.task = "transcribe";
    const name = LANGUAGE_NAMES[language];
    if (name) options.language = name;
  }
  let output;
  try {
    output = await pipe(audio, options);
  } catch (error) {
    console.warn("Retrying transcription with simpler settings.", error);
    const simpler = { ...options, num_beams: 1, return_timestamps: "word" };
    try {
      output = await pipe(audio, simpler);
    } catch (again) {
      console.warn("Word timestamps unavailable, using segment timings.", again);
      output = await pipe(audio, { ...simpler, return_timestamps: true });
    }
  }
  onProgress?.({ message: "Transcript ready.", ratio: 1 });
  return {
    text: String(output?.text || "").trim(),
    chunks: output?.chunks || [],
    device,
    model: modelId,
  };
}

export async function gpuAvailable() {
  if (!navigator.gpu?.requestAdapter) return false;
  try {
    const adapter = await Promise.race([
      navigator.gpu.requestAdapter(),
      new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    return Boolean(adapter);
  } catch {
    return false;
  }
}
