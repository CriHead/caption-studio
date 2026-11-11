import { runTranscription } from "./transcribe-core.js";

self.onmessage = async (event) => {
  const message = event.data || {};
  if (message.type !== "transcribe") return;
  try {
    const result = await runTranscription({
      audio: message.audio,
      model: message.model,
      language: message.language,
      prefer: message.prefer,
      onProgress: (progress) => self.postMessage({ type: "progress", id: message.id, ...progress }),
    });
    self.postMessage({ type: "result", id: message.id, ...result });
  } catch (error) {
    self.postMessage({
      type: "error",
      id: message.id,
      message: error?.message || "Transcription failed.",
    });
  }
};
