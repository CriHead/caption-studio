/**
 * Phone checks for the accuracy default and an iPhone-friendly MP4.
 * A typed caption skips the speech model so this stays short.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { createServer } from "vite";

const chrome = "/usr/bin/google-chrome";
const clip = "/tmp/cs-ios/h264.mp4";
const server = await createServer({
  configFile: "/workspace/client/vite.config.js",
  server: { host: "127.0.0.1", port: 4399, strictPort: true },
});
await server.listen();
const origin = server.resolvedUrls?.local?.[0] || "http://127.0.0.1:4399/";
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  protocolTimeout: 180000,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

function moovBeforeMdat(bytes) {
  const moov = indexOf(bytes, "moov");
  const mdat = indexOf(bytes, "mdat");
  return moov >= 0 && mdat >= 0 && moov < mdat;
}

function indexOf(bytes, text) {
  const needle = [...text].map((char) => char.charCodeAt(0));
  for (let i = 0; i < bytes.length - 4; i += 1) {
    if (needle.every((code, offset) => bytes[i + offset] === code)) return i;
  }
  return -1;
}

try {
  const phone = await browser.newPage();
  await phone.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1");
  await phone.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await phone.goto(origin, { waitUntil: "domcontentloaded" });
  await phone.waitForFunction(() => window.__studio?.ready === true);
  const ui = await phone.evaluate(() => ({
    accuracy: document.getElementById("accuracy").value,
    lang: document.getElementById("lang").value,
    go: document.getElementById("go").textContent,
    shareHidden: document.getElementById("share").hidden,
    edit: Boolean(document.getElementById("editWords")),
  }));
  console.log("ui", ui);
  if (ui.accuracy !== "best") throw new Error(`Accuracy default is ${ui.accuracy}`);
  if (ui.lang !== "en") throw new Error(`Language default is ${ui.lang}`);
  if (ui.go !== "Save to Camera Roll") throw new Error(`Export button says ${ui.go}`);
  if (!ui.shareHidden) throw new Error("Share button is visible before a video exists");
  if (!ui.edit) throw new Error("Edit words is missing");
  await phone.evaluate(() => {
    const file = new File([new Uint8Array([0, 0, 0, 1])], "captioned.mp4", { type: "video/mp4" });
    window.__studio.lastFile = file;
    window.__shared = "";
    navigator.canShare = () => true;
    navigator.share = async (data) => {
      window.__shared = data.files?.[0]?.name || "";
    };
    document.getElementById("result").style.display = "block";
    document.getElementById("share").hidden = false;
  });
  await phone.evaluate(() => document.getElementById("share").click());
  const shared = await phone.evaluate(() => window.__shared);
  if (shared !== "captioned.mp4") throw new Error(`Share did not send the video (${shared})`);

  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__studio?.ready === true);
  await page.evaluate(() => { document.getElementById("text").value = "Hello studio"; });
  const input = await page.$("#file");
  await input.uploadFile(clip);
  await page.waitForFunction(() => window.__studio?.fileName);
  await page.click('[data-step="export"]');
  await page.click("#go");
  await page.waitForFunction(() => document.getElementById("save").href.startsWith("blob:"), { timeout: 120000 });
  const bytes = await page.evaluate(async () => {
    const response = await fetch(document.getElementById("save").href);
    const buffer = await response.arrayBuffer();
    return Array.from(new Uint8Array(buffer));
  });
  const dir = mkdtempSync(path.join(tmpdir(), "cs-share-"));
  const file = path.join(dir, "out.mp4");
  writeFileSync(file, Buffer.from(bytes));
  const probe = spawnSync("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_name,codec_type,pix_fmt,width,height:format=duration",
    "-of", "json", file,
  ], { encoding: "utf8" });
  if (probe.status !== 0) throw new Error(probe.stderr || "ffprobe failed");
  const info = JSON.parse(probe.stdout);
  console.log(JSON.stringify(info, null, 2));
  const video = info.streams.find((stream) => stream.codec_type === "video");
  const audio = info.streams.find((stream) => stream.codec_type === "audio");
  if (!video || video.codec_name !== "h264") throw new Error("Export is not H.264");
  if (video.pix_fmt !== "yuv420p" && video.pix_fmt !== "yuvj420p") {
    throw new Error(`Pixel format is ${video.pix_fmt}`);
  }
  if (!audio) throw new Error("Export has no audio");
  if (audio.codec_name !== "aac" && audio.codec_name !== "opus") throw new Error(`Unexpected audio ${audio.codec_name}`);
  const duration = Number(info.format?.duration || 0);
  if (duration < 2 || duration > 8) throw new Error(`Unexpected duration ${duration}`);
  if (!moovBeforeMdat(bytes)) throw new Error("moov is not at the front of the file");
  console.log("SHARE_OK", { audio: audio.codec_name, duration, bytes: bytes.length });
} finally {
  await browser.close();
  await server.close();
}
