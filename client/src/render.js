import { drawFrame } from "./draw.js";

const FPS = 30;

/**
 * Burn captions into a 720p H.264 MP4. Mediabunny drives WebCodecs, so this
 * stays single-threaded and works on GitHub Pages (no COOP/COEP headers).
 */
export async function renderMp4(spec, onProgress) {
  const {
    Output,
    Mp4OutputFormat,
    BufferTarget,
    CanvasSource,
    AudioBufferSource,
    Quality,
    canEncodeVideo,
    canEncodeAudio,
    Input,
    ALL_FORMATS,
    BlobSource,
    VideoSampleSink,
  } = await import("mediabunny");

  const { width, height, duration } = spec;
  const videoOk = await canEncodeVideo("avc", { width, height, bitrate: 5_000_000 });
  if (!videoOk) {
    throw new Error("This browser cannot encode an H.264 MP4. Caption Studio needs a current Chrome or Safari.");
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  const frames = Math.max(1, Math.round(duration * FPS));
  const frameDur = duration / frames;

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: "in-memory" }),
    target: new BufferTarget(),
  });
  const videoSource = new CanvasSource(canvas, {
    codec: "avc",
    quality: new Quality({ bitrate: 5_000_000 }),
    keyFrameInterval: 1,
  });
  output.addVideoTrack(videoSource);

  // AAC is what Safari and most phones play. Linux Chrome often has no AAC
  // encoder, so Opus-in-MP4 is the fallback those browsers can still play.
  let audioSource = null;
  let audioCodec = null;
  if (spec.audioBuffer) {
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
  if (audioSource) await audioSource.add(spec.audioBuffer);

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

  if (spec.still) {
    for (let index = 0; index < frames; index++) {
      const time = index * frameDur;
      paint(spec.image, time, spec.imageWidth, spec.imageHeight);
      await videoSource.add(time, frameDur, { keyFrame: index % FPS === 0 });
      if (index % 2 === 0) {
        onProgress?.(index / frames);
        await yieldThread();
      }
    }
  } else {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(spec.file) });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error("That file does not have a video picture.");
      const sink = new VideoSampleSink(track);
      let held = null;
      let index = 0;
      const stamp = () => index * frameDur;
      for await (const sample of sink.samples(0, duration + frameDur)) {
        while (index < frames && stamp() + 1e-4 < sample.timestamp) {
          paint(held, stamp(), held?.displayWidth, held?.displayHeight);
          await videoSource.add(stamp(), frameDur, { keyFrame: index % FPS === 0 });
          index += 1;
          if (index % 2 === 0) {
            onProgress?.(index / frames);
            await yieldThread();
          }
        }
        held?.close();
        held = sample;
      }
      while (index < frames) {
        paint(held, stamp(), held?.displayWidth, held?.displayHeight);
        await videoSource.add(stamp(), frameDur, { keyFrame: index % FPS === 0 });
        index += 1;
        if (index % 2 === 0) onProgress?.(index / frames);
      }
      held?.close();
    } finally {
      input.dispose();
    }
  }

  await output.finalize();
  onProgress?.(1);
  const buffer = output.target.buffer;
  if (!buffer || buffer.byteLength < 1000) throw new Error("The video file came out empty.");
  return {
    blob: new Blob([buffer], { type: "video/mp4" }),
    audioCodec,
  };
}

function yieldThread() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
