/** Read photos, video, and audio entirely in the browser. */

const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif)$/i;
const AUDIO_EXT = /\.(wav|mp3|m4a|aac|ogg|flac|webm)$/i;

export function fileKind(file) {
  const type = file?.type || "";
  const name = file?.name || "";
  if (type.startsWith("image/") || IMAGE_EXT.test(name)) return "image";
  if (type.startsWith("audio/") || AUDIO_EXT.test(name)) return "audio";
  return "video";
}

export function probeVideo(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    const done = (fn) => {
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
      video.load();
      fn();
    };
    video.onloadedmetadata = () => {
      const duration = video.duration;
      const width = video.videoWidth;
      const height = video.videoHeight;
      done(() => resolve({ duration, width, height }));
    };
    video.onerror = () => done(() => reject(new Error("Could not read that video.")));
    video.src = url;
  });
}

export async function loadImage(file) {
  try {
    return await createImageBitmap(file);
  } catch {
    const url = URL.createObjectURL(file);
    try {
      return await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Could not read that image."));
        image.src = url;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

let audioCtx = null;

function contextFor(sampleRate) {
  if (!audioCtx || audioCtx.state === "closed" || (sampleRate && audioCtx.sampleRate !== sampleRate)) {
    if (audioCtx && audioCtx.state !== "closed") audioCtx.close();
    audioCtx = new AudioContext({ sampleRate: sampleRate || 48000 });
  }
  return audioCtx;
}

export async function decodeAudio(file) {
  const { Input, ALL_FORMATS, BlobSource, AudioBufferSink } = await import("mediabunny");
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return null;
    const sink = new AudioBufferSink(track);
    const pieces = [];
    for await (const piece of sink.buffers()) pieces.push(piece);
    if (!pieces.length) return null;
    return stitch(pieces);
  } finally {
    input.dispose();
  }
}

function stitch(pieces) {
  const sampleRate = pieces[0].buffer.sampleRate;
  const channels = Math.min(2, pieces[0].buffer.numberOfChannels || 1);
  const end = pieces.reduce((max, piece) => Math.max(max, piece.timestamp + piece.duration), 0);
  const length = Math.max(1, Math.ceil(end * sampleRate));
  const ctx = contextFor(sampleRate);
  const buffer = ctx.createBuffer(channels, length, sampleRate);
  for (const piece of pieces) {
    const offset = Math.max(0, Math.round(piece.timestamp * sampleRate));
    for (let channel = 0; channel < channels; channel++) {
      const src = piece.buffer.getChannelData(Math.min(channel, piece.buffer.numberOfChannels - 1));
      const dst = buffer.getChannelData(channel);
      const count = Math.min(src.length, dst.length - offset);
      for (let i = 0; i < count; i++) dst[offset + i] += src[i];
    }
  }
  return buffer;
}

export function sliceAudio(buffer, duration) {
  if (!buffer) return null;
  const seconds = Math.max(0.05, duration);
  const length = Math.min(buffer.length, Math.max(1, Math.floor(seconds * buffer.sampleRate)));
  if (length === buffer.length) return buffer;
  const ctx = contextFor(buffer.sampleRate);
  const out = ctx.createBuffer(buffer.numberOfChannels, length, buffer.sampleRate);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    out.getChannelData(channel).set(buffer.getChannelData(channel).subarray(0, length));
  }
  return out;
}

/** Whisper expects 16 kHz mono PCM in about the -1..1 range. */
export function toMono16k(buffer) {
  if (!buffer) return null;
  const sampleRate = buffer.sampleRate;
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const mono = new Float32Array(length);
  for (let channel = 0; channel < channels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) mono[i] += data[i] / channels;
  }
  if (sampleRate === 16000) return mono;
  const outLength = Math.max(1, Math.round((length * 16000) / sampleRate));
  const out = new Float32Array(outLength);
  const ratio = sampleRate / 16000;
  for (let i = 0; i < outLength; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(length - 1, i0 + 1);
    const frac = x - i0;
    out[i] = mono[i0] * (1 - frac) + mono[i1] * frac;
  }
  return out;
}
