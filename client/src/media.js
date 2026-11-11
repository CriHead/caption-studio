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
    const bitmap = await createImageBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    if (longest <= 1920) return bitmap;
    const scale = 1920 / longest;
    const small = await createImageBitmap(bitmap, {
      resizeWidth: Math.max(1, Math.round(bitmap.width * scale)),
      resizeHeight: Math.max(1, Math.round(bitmap.height * scale)),
      resizeQuality: "high",
    });
    bitmap.close();
    return small;
  } catch {
    const url = URL.createObjectURL(file);
    try {
      return await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
          const longest = Math.max(image.naturalWidth, image.naturalHeight);
          if (longest <= 1920) {
            resolve(image);
            return;
          }
          const scale = 1920 / longest;
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
          canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve(canvas);
        };
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

/**
 * Walk the audio track in short windows and hand back 16 kHz mono.
 * The whole file is never copied into one ArrayBuffer, and each window
 * is released before the next one starts.
 */
export async function eachPcmWindow(file, seconds, onWindow) {
  const { Input, ALL_FORMATS, BlobSource, AudioBufferSink } = await import("mediabunny");
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return false;
    const sink = new AudioBufferSink(track);
    let batch = [];
    let covered = 0;
    const flush = async () => {
      if (!batch.length) return;
      const window = windowTo16k(batch);
      batch = [];
      covered = 0;
      if (window) await onWindow(window);
    };
    for await (const piece of sink.buffers()) {
      batch.push(piece);
      covered += piece.duration || piece.buffer.duration || 0;
      if (covered >= seconds) await flush();
    }
    await flush();
    return true;
  } finally {
    input.dispose();
  }
}

function windowTo16k(pieces) {
  const sampleRate = pieces[0].buffer.sampleRate;
  const channels = Math.min(2, pieces[0].buffer.numberOfChannels || 1);
  const start = pieces[0].timestamp || 0;
  const last = pieces[pieces.length - 1];
  const end = (last.timestamp || 0) + (last.duration || last.buffer.duration || 0);
  const length = Math.max(1, Math.ceil((end - start) * sampleRate));
  const ctx = contextFor(sampleRate);
  const buffer = ctx.createBuffer(channels, length, sampleRate);
  for (const piece of pieces) {
    const offset = Math.max(0, Math.round(((piece.timestamp || 0) - start) * sampleRate));
    for (let channel = 0; channel < channels; channel++) {
      const src = piece.buffer.getChannelData(Math.min(channel, piece.buffer.numberOfChannels - 1));
      const dst = buffer.getChannelData(channel);
      const count = Math.min(src.length, Math.max(0, dst.length - offset));
      if (count > 0) dst.set(src.subarray(0, count), offset);
    }
  }
  return { pcm: toMono16k(buffer), start };
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
    const mixed = stitch(pieces);
    pieces.length = 0;
    return mixed;
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
  const outLength = sampleRate === 16000 ? length : Math.max(1, Math.round((length * 16000) / sampleRate));
  const out = new Float32Array(outLength);
  const ratio = sampleRate / 16000;
  const data = [];
  for (let channel = 0; channel < channels; channel++) data.push(buffer.getChannelData(channel));
  for (let i = 0; i < outLength; i++) {
    const x = sampleRate === 16000 ? i : i * ratio;
    const i0 = Math.min(length - 1, Math.floor(x));
    const i1 = Math.min(length - 1, i0 + 1);
    const frac = x - i0;
    let left = 0;
    let right = 0;
    for (let channel = 0; channel < channels; channel++) {
      left += data[channel][i0];
      right += data[channel][i1];
    }
    out[i] = (left * (1 - frac) + right * frac) / channels;
  }
  return out;
}
