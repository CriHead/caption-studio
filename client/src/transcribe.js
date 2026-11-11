let sequence = 0;
let preferPromise = null;

async function devicePreference() {
  if (!preferPromise) {
    preferPromise = import("./transcribe-core.js").then(({ gpuAvailable }) => gpuAvailable().then((yes) => (yes ? "webgpu" : "wasm")));
  }
  return preferPromise;
}

export function transcribeAudio(pcm, options) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL("./transcribe.worker.js", import.meta.url), { type: "module" });
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
      worker.terminate();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("Transcription took too long. Try the Tiny model or a shorter clip.")), 8 * 60 * 1000);
    worker.onmessage = (event) => {
      const message = event.data || {};
      if (message.id !== id) return;
      if (message.type === "progress") options.onProgress?.(message);
      if (message.type === "result") finish(resolve, message);
      if (message.type === "error") finish(reject, new Error(message.message || "Transcription failed."));
    };
    worker.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      transcribeOnMain(pcm, options).then(resolve, reject);
    };
    devicePreference().then((prefer) => {
      if (settled) return;
      worker.postMessage({
        type: "transcribe",
        id,
        audio: pcm,
        model: options.model,
        language: options.language,
        prefer,
      });
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
