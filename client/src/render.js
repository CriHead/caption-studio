import { drawFrame } from "./draw.js";

const FPS = 30;

/**
 * Burn captions into an H.264 MP4 one frame at a time.
 * The file is written to disk (OPFS) as it is encoded, so a long clip
 * does not keep every frame, or the finished file, in memory.
 */
export async function renderMp4(spec, onProgress) {
  const mediabunny = await import("mediabunny");
  const {
    Output,
    CanvasSource,
    AudioBufferSource,
    Quality,
    canEncodeVideo,
    canEncodeAudio,
    Input,
    ALL_FORMATS,
    BlobSource,
    VideoSampleSink,
  } = mediabunny;

  const { width, height, duration } = spec;
  const bitrate = spec.bitrate || (width >= 1920 || height >= 1920 ? 8_000_000 : 4_500_000);
  const profile = Math.max(width, height) > 1280 ? "avc1.4D4028" : "avc1.4D401F";
  const profileOk = await canEncodeVideo("avc", { width, height, bitrate, fullCodecString: profile, frameRate: FPS }).catch(() => false);
  const videoOk = profileOk || await canEncodeVideo("avc", { width, height, bitrate, frameRate: FPS });
  if (!videoOk) {
    throw new Error("This browser cannot encode an H.264 MP4. Caption Studio needs a current Chrome or Safari.");
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  const frames = Math.max(1, Math.round(duration * FPS));
  const frameDur = duration / frames;
  const sink = await openSink(mediabunny, "reserve");

  const output = new Output({ format: sink.format, target: sink.target });
  const videoSource = new CanvasSource(canvas, {
    codec: "avc",
    quality: new Quality({ bitrate }),
    keyFrameInterval: 2,
    latencyMode: "quality",
    ...(profileOk ? { fullCodecString: profile } : {}),
  });
  const videoPackets = Math.ceil(frames * 1.5) + 8;
  output.addVideoTrack(videoSource, { maximumPacketCount: videoPackets, frameRate: FPS });

  let audioCodec = null;
  let audioSource = null;
  if (spec.audioFile || spec.audioBuffer) {
    for (const candidate of ["aac", "opus"]) {
      const ok = await canEncodeAudio(candidate, { numberOfChannels: 2, sampleRate: 48000 }).catch(() => false);
      if (!ok) continue;
      audioCodec = candidate;
      audioSource = new AudioBufferSource({
        codec: candidate,
        quality: new Quality({ bitrate: 128_000 }),
        transform: { numberOfChannels: 2, sampleRate: 48000 },
      });
      output.addAudioTrack(audioSource, { maximumPacketCount: Math.ceil(duration * 80) + 16 });
      break;
    }
  }

  output.setMetadataTags({ title: "Caption Studio", comment: "Rendered on this device" });
  await output.start();

  const paint = (source, time, sourceWidth, sourceHeight) => {
    drawFrame(ctx, {
      ...spec.scene,
      width,
      height,
      time,
      duration,
      source,
      sourceWidth,
      sourceHeight,
      still: spec.still,
    });
  };

  try {
    if (spec.still) {
      for (let index = 0; index < frames; index++) {
        const time = index * frameDur;
        paint(spec.image, time, spec.imageWidth, spec.imageHeight);
        await videoSource.add(time, frameDur, { keyFrame: index % (FPS * 2) === 0 });
        if (index % 8 === 0) {
          onProgress?.(index / frames);
          await yieldThread();
        }
      }
    } else {
      const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(spec.file) });
      try {
        const track = await input.getPrimaryVideoTrack();
        if (!track) throw new Error("That file does not have a video picture.");
        const samples = new VideoSampleSink(track);
        let held = null;
        let index = 0;
        const stamp = () => index * frameDur;
        try {
          for await (const sample of samples.samples(0, duration + frameDur)) {
            const small = await shrinkSample(sample, width, height);
            while (index < frames && stamp() + 1e-4 < small.timestamp) {
              paint(held, stamp(), held?.displayWidth, held?.displayHeight);
              await videoSource.add(stamp(), frameDur, { keyFrame: index % (FPS * 2) === 0 });
              index += 1;
              if (index % 8 === 0) {
                onProgress?.(index / frames);
                await yieldThread();
              }
            }
            held?.close();
            held = small;
          }
        } catch (error) {
          held?.close();
          held = null;
          if (index > 0) throw error;
          await renderByPlayback(spec.file, paint, videoSource, frames, frameDur, onProgress);
          index = frames;
        }
        while (index < frames) {
          paint(held, stamp(), held?.displayWidth, held?.displayHeight);
          await videoSource.add(stamp(), frameDur, { keyFrame: index % (FPS * 2) === 0 });
          index += 1;
          if (index % 8 === 0) onProgress?.(index / frames);
        }
        held?.close();
        held = null;
      } finally {
        input.dispose();
      }
    }

    if (audioSource && spec.audioBuffer) await audioSource.add(spec.audioBuffer);
    if (audioSource && spec.audioFile && !spec.audioBuffer) {
      await streamAudio(spec.audioFile, audioSource, duration);
    }

    await output.finalize();
  } catch (error) {
    try { await sink.abort(); } catch { /* already closed */ }
    throw error;
  }

  onProgress?.(1);
  const blob = await sink.file();
  if (!blob || blob.size < 1000) throw new Error("The video file came out empty.");
  return { blob, audioCodec };
}

async function shrinkSample(sample, width, height) {
  const wide = sample.displayWidth > width * 1.1 || sample.displayHeight > height * 1.1;
  if (!wide || typeof sample.transform !== "function") return sample;
  try {
    const small = await sample.transform({ width, height, fit: "cover" });
    if (small !== sample) sample.close();
    return small;
  } catch {
    return sample;
  }
}

async function renderByPlayback(file, paint, videoSource, frames, frameDur, onProgress) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  video.preload = "auto";
  video.src = url;
  try {
    await new Promise((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error("This browser could not decode that video."));
    });
    for (let index = 0; index < frames; index++) {
      await seekVideo(video, index * frameDur);
      paint(video, index * frameDur, video.videoWidth, video.videoHeight);
      await videoSource.add(index * frameDur, frameDur, { keyFrame: index % (FPS * 2) === 0 });
      if (index % 8 === 0) {
        onProgress?.(index / frames);
        await yieldThread();
      }
    }
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

function seekVideo(video, time) {
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener("seeked", done);
      resolve();
    };
    if (Math.abs((video.currentTime || 0) - time) < 0.001) {
      resolve();
      return;
    }
    video.addEventListener("seeked", done);
    try { video.currentTime = time; } catch { done(); }
  });
}

async function streamAudio(file, audioSource, duration) {
  const { Input, ALL_FORMATS, BlobSource, AudioBufferSink } = await import("mediabunny");
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return;
    const sink = new AudioBufferSink(track);
    let written = 0;
    for await (const piece of sink.buffers()) {
      if (written >= duration) break;
      await audioSource.add(piece.buffer);
      written += piece.buffer.duration || 0;
    }
  } finally {
    input.dispose();
  }
}

async function openSink(mediabunny, fastStart = "reserve") {
  const { StreamTarget, BufferTarget, Mp4OutputFormat } = mediabunny;
  try {
    if (!navigator.storage?.getDirectory) throw new Error("no OPFS");
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle("caption-studio-out.mp4", { create: true });
    const writable = await handle.createWritable();
    let failed = null;
    const target = new StreamTarget(new WritableStream({
      async write(chunk) {
        await writable.write({ type: "write", position: chunk.position, data: chunk.data });
      },
      async close() {
        await writable.close();
      },
      async abort(reason) {
        failed = reason;
        try { await writable.abort(reason); } catch { try { await writable.close(); } catch { /* ignore */ } }
      },
    }), { chunked: true, chunkSize: 1024 * 1024 });
    return {
      format: new Mp4OutputFormat({ fastStart }),
      target,
      abort: async () => { if (!failed) await writable.abort?.(); },
      file: async () => handle.getFile(),
    };
  } catch (error) {
    console.warn("Could not stream the export to disk.", error);
    const target = new BufferTarget();
    return {
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target,
      abort: async () => {},
      file: async () => {
        if (!target.buffer) throw new Error("The video file came out empty.");
        return new Blob([target.buffer], { type: "video/mp4" });
      },
    };
  }
}

function yieldThread() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
