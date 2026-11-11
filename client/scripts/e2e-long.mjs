/**
 * A clip longer than 3 minutes, exported at 1080p.
 * Confirms chunked transcription and a streamed encode.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { preview } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = "/tmp/caption-studio-long";
mkdirSync(work, { recursive: true });
const chrome = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"].find(
  (candidate) => spawnSync("test", ["-x", candidate]).status === 0,
);

function run(cmd) {
  const result = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit" });
  if (result.status !== 0) throw new Error(cmd.join(" ") + " failed");
}

const wav = path.join(work, "jfk.wav");
run(["curl", "-fsSL", "-o", wav, "https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav"]);
run([
  "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "color=c=0x1a120e:s=320x180:r=30:d=185",
  "-stream_loop", "-1", "-i", wav,
  "-t", "185", "-shortest",
  "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "64k",
  path.join(work, "long.mp4"),
]);

const server = await preview({
  configFile: path.join(root, "vite.config.js"),
  preview: { host: "127.0.0.1", port: 4176, strictPort: true },
});
const logs = [];
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  protocolTimeout: 600000,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const page = await browser.newPage();
  page.on("console", (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (error) => logs.push(`[pageerror] ${error.message}`));
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto("http://127.0.0.1:4176/", { waitUntil: "networkidle0" });
  await page.waitForFunction(() => window.__studio?.ready === true);
  await page.click('[data-quality="1080"]');
  const input = await page.$("#file");
  await input.uploadFile(path.join(work, "long.mp4"));
  await page.waitForFunction(() => (window.__studio?.words?.length || 0) >= 8, { timeout: 12 * 60 * 1000 });
  const heard = await page.evaluate(() => ({
    words: window.__studio.words.length,
    chunks: window.__studio.chunkCount,
    transcript: window.__studio.transcript,
  }));
  console.log("Heard", heard);
  if (!heard.chunks || heard.chunks < 3) throw new Error(`Expected several transcript chunks, saw ${heard.chunks}`);
  if (!/country|america|ask/i.test(heard.transcript || "")) throw new Error("Long clip did not transcribe.");

  await page.click('[data-step="export"]');
  const started = Date.now();
  await page.click("#go");
  await page.waitForFunction(() => window.__studio?.lastBlob || window.__studio?.error, { timeout: 12 * 60 * 1000 });
  const info = await page.evaluate(async () => {
    if (window.__studio.error && !window.__studio.lastBlob) return { error: window.__studio.error };
    const blob = window.__studio.lastBlob;
    const url = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.src = url;
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error("Could not read the export."));
    });
    const result = {
      width: video.videoWidth,
      height: video.videoHeight,
      duration: video.duration,
      bytes: blob.size,
    };
    URL.revokeObjectURL(url);
    return result;
  });
  console.log("Export", info, "in", Date.now() - started, "ms");
  if (info.error) throw new Error(info.error);
  if (info.width !== 1920 || info.height !== 1080) throw new Error(`Expected 1920x1080, got ${info.width}x${info.height}`);
  if (info.duration < 180) throw new Error(`Expected over 3 minutes, got ${info.duration}`);
  if (info.bytes < 100000) throw new Error("Export file is too small.");
  console.log("PASS long 1080p");
} catch (error) {
  console.error("FAIL", error);
  console.error(logs.slice(-40).join("\n"));
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
