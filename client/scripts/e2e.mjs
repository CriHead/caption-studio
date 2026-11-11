/**
 * End-to-end check in headless Chrome:
 * a speech clip transcribes and renders an MP4 with visible captions,
 * and a photo works in a phone-sized viewport.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { preview } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = "/tmp/caption-studio-e2e";
const artifacts = "/opt/cursor/artifacts";
mkdirSync(work, { recursive: true });
mkdirSync(artifacts, { recursive: true });

const chrome = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"]
  .find((candidate) => spawnSync("test", ["-x", candidate]).status === 0);
if (!chrome) throw new Error("Chrome is not installed.");

function run(cmd) {
  const result = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${cmd.join(" ")} failed`);
}

console.log("Preparing a 15-second speech clip and a photo…");
run(["curl", "-fsSL", "-o", path.join(work, "jfk.wav"), "https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav"]);
run([
  "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "color=c=0x1a120e:s=1280x720:r=30:d=15",
  "-i", path.join(work, "jfk.wav"),
  "-filter_complex", "[1:a]apad=whole_dur=15[a]",
  "-map", "0:v", "-map", "[a]",
  "-t", "15",
  "-c:v", "libx264", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "96k",
  path.join(work, "speech.mp4"),
]);
run([
  "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "color=c=0x3a2a22:s=1080x1080",
  "-frames:v", "1",
  path.join(work, "photo.png"),
]);

const server = await preview({
  configFile: path.join(root, "vite.config.js"),
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
});
const origin = "http://127.0.0.1:4173/";
const logs = [];
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  protocolTimeout: 600000,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
  ],
});

function watch(page) {
  page.on("console", (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (error) => logs.push(`[pageerror] ${error.message}`));
}

async function brightCount(file, at, width, height) {
  const raw = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-ss", String(at), "-i", file,
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ], { maxBuffer: width * height * 3 + 1024 });
  if (raw.status !== 0) return 0;
  const data = raw.stdout;
  let bright = 0;
  for (let i = 0; i + 2 < data.length; i += 3) {
    if (data[i] > 190 && data[i + 1] > 175 && data[i + 2] > 160) bright += 1;
  }
  return bright;
}

try {
  const page = await browser.newPage();
  watch(page);
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(origin, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => window.__studio?.ready === true);

  const t0 = Date.now();
  const fileInput = await page.$("#file");
  await fileInput.uploadFile(path.join(work, "speech.mp4"));
  await page.waitForFunction(() => {
    const studio = window.__studio;
    return Boolean(studio?.error) || (studio?.words?.length || 0) >= 4;
  }, { timeout: 8 * 60 * 1000 });
  const afterSpeech = await page.evaluate(() => ({
    error: window.__studio.error,
    transcript: window.__studio.transcript,
    words: window.__studio.words?.length || 0,
    device: window.__studio.device,
    model: window.__studio.model,
    transcribeMs: window.__studio.transcribeMs,
    phase: window.__studio.phase,
    status: document.getElementById("status")?.textContent || "",
  }));
  console.log("Transcript:", JSON.stringify(afterSpeech, null, 2));
  if (afterSpeech.error) throw new Error(afterSpeech.error);
  if (!/ask|country|america|fellow|you/i.test(afterSpeech.transcript || "")) {
    throw new Error(`Transcript did not look like the speech clip: ${afterSpeech.transcript}`);
  }

  await page.evaluate(() => {
    const scrub = document.getElementById("scrub");
    scrub.value = "280";
    scrub.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  await page.evaluate(() => document.getElementById("stageFrame").scrollIntoView({ block: "center" }));
  await page.screenshot({ path: path.join(artifacts, "caption-studio-preview.png") });

  const renderStart = Date.now();
  await page.click('[data-step="export"]');
  await page.click("#go");
  await page.waitForFunction(() => window.__studio?.lastBlob || window.__studio?.error, { timeout: 4 * 60 * 1000 });
  const rendered = await page.evaluate(async () => {
    if (window.__studio.error && !window.__studio.lastBlob) return { error: window.__studio.error };
    const buffer = await window.__studio.lastBlob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const size = 0x4000;
    for (let i = 0; i < bytes.length; i += size) {
      binary += String.fromCharCode(...bytes.subarray(i, i + size));
    }
    return {
      error: null,
      base64: btoa(binary),
      renderMs: window.__studio.renderMs,
      bytes: bytes.length,
    };
  });
  if (rendered.error) throw new Error(rendered.error);
  const mp4Path = path.join(artifacts, "caption-studio-sample.mp4");
  writeFileSync(mp4Path, Buffer.from(rendered.base64, "base64"));
  const renderWall = Date.now() - renderStart;
  console.log(`Render ${rendered.bytes} bytes in ${Math.round(rendered.renderMs)} ms (wall ${renderWall} ms)`);

  const probe = spawnSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,codec_name",
    "-of", "json", mp4Path,
  ], { encoding: "utf8" });
  console.log(probe.stdout);
  const info = JSON.parse(probe.stdout || "{}");
  const video = (info.streams || []).find((stream) => stream.codec_type === "video");
  const audio = (info.streams || []).find((stream) => stream.codec_type === "audio");
  if (!video || video.codec_name !== "h264") throw new Error("Output is not an H.264 video.");
  if (!audio) throw new Error("Output MP4 has no audio track.");
  if (Number(video.width) !== 1280 || Number(video.height) !== 720) throw new Error(`Unexpected size ${video.width}x${video.height}`);
  const duration = Number(info.format?.duration || 0);
  if (duration < 12 || duration > 17) throw new Error(`Unexpected duration ${duration}`);
  const volume = spawnSync("ffmpeg", [
    "-hide_banner", "-i", mp4Path, "-af", "volumedetect", "-f", "null", "-",
  ], { encoding: "utf8" });
  const mean = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(volume.stderr || "");
  const meanDb = mean ? Number(mean[1]) : -99;
  console.log(`Audio ${audio.codec_name}, mean volume ${meanDb} dB`);
  if (meanDb < -45) throw new Error(`Output audio is silent (${meanDb} dB).`);

  let best = 0;
  let bestAt = 0;
  for (const at of [1, 3, 5, 7, 9]) {
    const count = await brightCount(mp4Path, at, 1280, 720);
    console.log(`Bright pixels at ${at}s: ${count}`);
    if (count > best) {
      best = count;
      bestAt = at;
    }
  }
  if (best < 400) throw new Error(`Captions were not visible in the MP4 (bright pixels ${best}).`);
  run([
    "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
    "-ss", String(bestAt), "-i", mp4Path,
    "-frames:v", "1",
    path.join(artifacts, "caption-studio-frame.png"),
  ]);

  const desktop = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    transcribeMs: window.__studio.transcribeMs,
    renderMs: window.__studio.renderMs,
    duration: window.__studio.duration,
  }));
  if (desktop.overflow > 2) throw new Error(`Desktop page overflowed by ${desktop.overflow}px`);

  const photoPage = await browser.newPage();
  watch(photoPage);
  await photoPage.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  await photoPage.goto(origin, { waitUntil: "networkidle0" });
  const photoInput = await photoPage.$("#file");
  await photoInput.uploadFile(path.join(work, "photo.png"));
  await photoPage.waitForFunction(() => window.__studio?.fileName, { timeout: 20000 });
  await photoPage.click('[data-step="captions"]');
  await photoPage.type("#text", "Hello studio");
  await photoPage.waitForFunction(() => {
    const canvas = document.getElementById("stage");
    if (!canvas) return false;
    const ctx = canvas.getContext("2d");
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let bright = 0;
    for (let i = 0; i < data.length; i += 16) {
      if (data[i] > 190 && data[i + 1] > 175) bright += 1;
    }
    return bright > 30;
  }, { timeout: 20000 });
  await photoPage.evaluate(() => document.getElementById("stageFrame").scrollIntoView({ block: "center" }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  await photoPage.screenshot({ path: path.join(artifacts, "caption-studio-mobile-photo.png") });
  const mobile = await photoPage.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    width: document.getElementById("stage").width,
    height: document.getElementById("stage").height,
    status: document.getElementById("status").textContent,
  }));
  console.log("Mobile photo", mobile);
  if (mobile.overflow > 2) throw new Error(`Mobile page overflowed by ${mobile.overflow}px`);

  const summary = {
    clipSeconds: desktop.duration,
    transcribeMs: desktop.transcribeMs,
    renderMs: desktop.renderMs,
    wallMs: Date.now() - t0,
    device: afterSpeech.device,
    model: afterSpeech.model,
    transcript: afterSpeech.transcript,
    brightPixels: best,
    outputBytes: rendered.bytes,
  };
  writeFileSync(path.join(artifacts, "caption-studio-timing.json"), JSON.stringify(summary, null, 2));
  console.log("PASS", JSON.stringify(summary, null, 2));
} catch (error) {
  console.error("FAIL", error);
  console.error(logs.slice(-50).join("\n"));
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
