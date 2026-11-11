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
  const videoOk = await canEncodeVideo("avc", { width, height, bitrate });
  if (!videoOk) {
    throw new Error("This browser cannot encode an H.264 MP4. Caption Studio needs a current Chrome or Safari.");
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  const frames = Math.max(1, Math.round(duration * FPS));
  const frameDur = duration / frames;
  const sink = await openSink(mediabunny);

  const output = new Output({ format: sink.format, target: sink.target });
  const videoSource = new CanvasSource(canvas, {
    codec: "avc",
    quality: new Quality({ bitrate }),
    keyFrameInterval: 2,
  });
  output.addVideoTrack(videoSource);

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
      output.addAudioTrack(audioSource);
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
        for await (const sample of samples.samples(0, duration + frameDur)) {
          while (index < frames && stamp() + 1e-4 < sample.timestamp) {
            paint(held, stamp(), held?.displayWidth, held?.displayHeight);
            await videoSource.add(stamp(), frameDur, { keyFrame: index % (FPS * 2) === 0 });
            index += 1;
            if (index % 8 === 0) {
              onProgress?.(index / frames);
              await yieldThread();
            }
          }
          held?.close();
          held = sample;
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

async function openSink(mediabunny) {
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
      format: new Mp4OutputFormat({ fastStart: "fragmented" }),
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
