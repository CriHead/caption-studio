/**
 * Preview playback must not copy a 4K frame into a canvas.
 * Plays a 4K H.264 clip (and the HEVC .mov when the browser can read it)
 * and checks the caption canvas stays at the CSS size.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const media = "/tmp/cs-ios";
const artifacts = "/opt/cursor/artifacts";
mkdirSync(media, { recursive: true });
mkdirSync(artifacts, { recursive: true });

const chrome = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"]
  .find((candidate) => spawnSync("test", ["-x", candidate]).status === 0);
if (!chrome) throw new Error("Chrome is not installed.");

const h264 = path.join(media, "uhd-h264.mp4");
const hevc = path.join(media, "uhd.mov");
if (!existsSync(h264)) {
  const encoded = spawnSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=0x224466:s=3840x2160:r=60:d=3",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "32k", "-shortest",
    h264,
  ], { stdio: "inherit" });
  if (encoded.status !== 0) throw new Error("Could not encode the 4K H.264 clip.");
}

function treeRssKb(rootPid) {
  const result = spawnSync("ps", ["-eo", "pid=,ppid=,rss="], { encoding: "utf8" });
  const rows = [];
  const children = new Map();
  for (const line of result.stdout.split("\n")) {
    const [pid, ppid, rss] = line.trim().split(/\s+/).map(Number);
    if (!pid) continue;
    rows.push({ pid, ppid, rss: rss || 0 });
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  let sum = 0;
  const walk = (pid) => {
    const row = rows.find((item) => item.pid === pid);
    if (row) sum += row.rss;
    for (const child of children.get(pid) || []) walk(child);
  };
  walk(rootPid);
  return sum;
}

const server = await createServer({
  configFile: path.join(root, "vite.config.js"),
  server: { host: "127.0.0.1", port: 4391, strictPort: true },
});
await server.listen();
const origin = server.resolvedUrls?.local?.[0] || "http://127.0.0.1:4391/";
const logs = [];
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  protocolTimeout: 120000,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"],
});
const emptyRss = treeRssKb(browser.process().pid);

async function heapBytes(page) {
  const metrics = await page.metrics();
  return metrics.JSHeapUsedSize || 0;
}

async function openClip(page, file) {
  await page.goto(origin, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => window.__studio?.ready === true, { timeout: 20000 });
  await page.evaluate(() => {
    document.getElementById("text").value = "Play safe";
  });
  const input = await page.$("#file");
  await input.uploadFile(file);
  await page.waitForFunction(() => {
    const video = document.getElementById("previewVideo");
    const status = document.getElementById("status")?.textContent || "";
    return window.__studio?.fileName && (video.readyState >= 1 || /could not|wrong|problem/i.test(status));
  }, { timeout: 20000 });
  await new Promise((resolve) => setTimeout(resolve, 400));
}

async function arm(page) {
  await page.evaluate(() => {
    window.__drewVideo = 0;
    window.__bitmaps = 0;
    window.__frames = 0;
    window.__canvases = 0;
    window.__rvfc = 0;
    window.__imageData = 0;
    const canvas = document.getElementById("stage");
    const ctx = canvas.getContext("2d");
    const draw = ctx.drawImage.bind(ctx);
    ctx.drawImage = (source, ...rest) => {
      if (source && source.tagName === "VIDEO") window.__drewVideo += 1;
      return draw(source, ...rest);
    };
    const pixels = ctx.getImageData.bind(ctx);
    ctx.getImageData = (...args) => {
      window.__imageData += 1;
      return pixels(...args);
    };
    const create = document.createElement.bind(document);
    document.createElement = (tag, ...rest) => {
      if (String(tag).toLowerCase() === "canvas") window.__canvases += 1;
      return create(tag, ...rest);
    };
    if (window.createImageBitmap) {
      const bitmap = window.createImageBitmap.bind(window);
      window.createImageBitmap = (...args) => {
        window.__bitmaps += 1;
        return bitmap(...args);
      };
    }
    HTMLVideoElement.prototype.requestVideoFrameCallback = () => {
      window.__rvfc += 1;
      return 0;
    };
  });
}

async function playAndSample(page, file, label) {
  await openClip(page, file);
  await arm(page);
  const before = await page.evaluate(() => ({
    starts: window.__studio.transcribeStarts,
    videoWidth: document.getElementById("previewVideo").videoWidth,
    videoHeight: document.getElementById("previewVideo").videoHeight,
    canvasWidth: document.getElementById("stage").width,
    canvasHeight: document.getElementById("stage").height,
    cssWidth: Math.round(document.getElementById("stageFrame").getBoundingClientRect().width),
    cssHeight: Math.round(document.getElementById("stageFrame").getBoundingClientRect().height),
    autoplay: document.getElementById("previewVideo").autoplay,
    muted: document.getElementById("previewVideo").muted,
    volume: document.getElementById("previewVideo").volume,
    playsInline: document.getElementById("previewVideo").playsInline,
    preload: document.getElementById("previewVideo").preload,
    blobVideos: [...document.querySelectorAll("video")].filter((node) => String(node.src).startsWith("blob:")).length,
  }));
  const heapBefore = await heapBytes(page);
  const rssBefore = treeRssKb(browser.process().pid);
  await page.click("#play");
  await new Promise((resolve) => setTimeout(resolve, 1600));
  const during = await page.evaluate(() => {
    const video = document.getElementById("previewVideo");
    const canvas = document.getElementById("stage");
    const box = document.getElementById("stageFrame").getBoundingClientRect();
    return {
      starts: window.__studio.transcribeStarts,
      paused: video.paused,
      currentTime: video.currentTime,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      cssWidth: Math.round(box.width),
      cssHeight: Math.round(box.height),
      drewVideo: window.__drewVideo || 0,
      bitmaps: window.__bitmaps || 0,
      frames: window.__frames || 0,
      canvases: window.__canvases || 0,
      rvfc: window.__rvfc || 0,
      imageData: window.__imageData || 0,
      blobVideos: [...document.querySelectorAll("video")].filter((node) => String(node.src).startsWith("blob:")).length,
      status: document.getElementById("status").textContent,
      muted: video.muted,
      volume: video.volume,
      audioTracks: (() => {
        try {
          if (typeof video.captureStream === "function") return video.captureStream().getAudioTracks().length;
        } catch { /* the element can still be audible without a capture stream */ }
        return video.audioTracks ? video.audioTracks.length : 0;
      })(),
      decodedAudio: video.webkitAudioDecodedByteCount || 0,
    };
  });
  const heapAfter = await heapBytes(page);
  const rssAfter = treeRssKb(browser.process().pid);
  console.log(label, {
    before, during, heapBefore, heapAfter, rssBefore, rssAfter, emptyRss,
    addedMb: Math.round((rssAfter - emptyRss) / 1024),
  });
  if (before.autoplay) throw new Error(`${label}: autoplay is on`);
  if (before.muted || during.muted) throw new Error(`${label}: preview stayed muted`);
  if (!(before.volume > 0) || !(during.volume > 0)) throw new Error(`${label}: preview volume is 0`);
  if (before.videoWidth >= 640 && during.audioTracks < 1 && during.decodedAudio < 1) {
    throw new Error(`${label}: no audio track was playing`);
  }
  if (!before.playsInline) throw new Error(`${label}: playsinline is off`);
  if (before.preload !== "metadata") throw new Error(`${label}: preload is ${before.preload}`);
  if (before.blobVideos !== 1 || during.blobVideos !== 1) {
    throw new Error(`${label}: expected one object URL, saw ${before.blobVideos} then ${during.blobVideos}`);
  }
  if (during.starts !== before.starts) throw new Error(`${label}: play started transcription`);
  if (during.drewVideo !== 0) throw new Error(`${label}: drew the video into the canvas ${during.drewVideo} times`);
  if (during.bitmaps !== 0) throw new Error(`${label}: created ${during.bitmaps} image bitmaps while playing`);
  if (during.frames !== 0) throw new Error(`${label}: created ${during.frames} video frames while playing`);
  if (during.canvases !== 0) throw new Error(`${label}: created ${during.canvases} canvases while playing`);
  if (during.rvfc !== 0) throw new Error(`${label}: requestVideoFrameCallback ran ${during.rvfc} times`);
  if (during.imageData !== 0) throw new Error(`${label}: getImageData ran while playing`);
  const dpr = 1;
  const limit = Math.max(before.cssWidth, during.cssWidth) * Math.min(dpr, 2) + 4;
  if (during.canvasWidth > limit || during.canvasWidth < 100) {
    throw new Error(`${label}: caption canvas is ${during.canvasWidth}px, display is about ${during.cssWidth}px`);
  }
  if (before.videoWidth >= 1920 && during.canvasWidth >= before.videoWidth / 2) {
    throw new Error(`${label}: canvas ${during.canvasWidth} is far too close to the ${before.videoWidth}px video`);
  }
  const heapGrowth = heapAfter - heapBefore;
  const rssGrowth = rssAfter - rssBefore;
  const rssAdded = rssAfter - emptyRss;
  if (heapAfter > 200 * 1024 * 1024) throw new Error(`${label}: JS heap is ${Math.round(heapAfter / 1048576)} MB`);
  if (rssAdded > 800 * 1024) throw new Error(`${label}: playback added ${Math.round(rssAdded / 1024)} MB over an empty Chrome`);
  if (rssGrowth > 250 * 1024) throw new Error(`${label}: play added ${Math.round(rssGrowth / 1024)} MB of process memory`);
  if (heapGrowth > 40 * 1024 * 1024) throw new Error(`${label}: play added ${Math.round(heapGrowth / 1048576)} MB of JS heap`);
  return { before, during, heapBefore, heapAfter, rssBefore, rssAfter };
}

try {
  const page = await browser.newPage();
  page.on("console", (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (error) => logs.push(`[pageerror] ${error.message}`));
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });

  const played = await playAndSample(page, h264, "4K H.264");
  if (played.before.videoWidth !== 3840 || played.before.videoHeight !== 2160) {
    throw new Error(`Expected a 3840x2160 video, saw ${played.before.videoWidth}x${played.before.videoHeight}`);
  }
  if (played.during.paused && played.during.currentTime < 0.2) {
    throw new Error("Pressing play did not start the 4K clip.");
  }
  await page.screenshot({ path: path.join(artifacts, "preview-4k-playing.png") });

  let hevcNote = "HEVC file was not generated.";
  if (existsSync(hevc)) {
    const hevcPlay = await playAndSample(page, hevc, "4K HEVC");
    hevcNote = hevcPlay.before.videoWidth
      ? `HEVC decoded at ${hevcPlay.before.videoWidth}x${hevcPlay.before.videoHeight}, canvas ${hevcPlay.during.canvasWidth}px, time ${hevcPlay.during.currentTime.toFixed(2)}s`
      : `This Chrome build did not decode HEVC (${hevcPlay.during.status}). Canvas stayed ${hevcPlay.during.canvasWidth}px and play did not start transcription.`;
    if (hevcPlay.before.videoWidth >= 1920 && hevcPlay.during.paused && hevcPlay.during.currentTime < 0.2) {
      throw new Error("HEVC metadata loaded, but play did not start.");
    }
  }

  await page.click("#mute");
  const silenced = await page.evaluate(() => ({
    muted: document.getElementById("previewVideo").muted,
    volume: document.getElementById("previewVideo").volume,
  }));
  if (!silenced.muted || !(silenced.volume > 0)) throw new Error("Mute did not silence the preview");
  await page.click("#mute");

  await page.evaluate(() => {
    document.getElementById("previewVideo").pause();
    document.getElementById("previewVoice").pause();
    localStorage.setItem("caption-studio-busy", "play");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__studio?.ready === true);
  const ignored = await page.evaluate(() => ({
    hidden: document.getElementById("recovery").hidden,
    blocked: Boolean(window.__studio.blocked),
    marker: localStorage.getItem("caption-studio-busy"),
  }));
  console.log("Play marker", ignored);
  if (!ignored.hidden || ignored.blocked) throw new Error("Playing was treated as a crash");

  const keepMarker = () => {
    localStorage.setItem("caption-studio-busy", "transcribe");
    return localStorage.getItem("caption-studio-busy");
  };
  console.log("marker before reload", await page.evaluate(keepMarker) || await page.evaluate(() => localStorage.getItem("caption-studio-busy")));
  await page.reload({ waitUntil: "domcontentloaded" });
  let recoveryState = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    recoveryState = await page.evaluate(() => ({
      ready: window.__studio?.ready === true,
      blocked: Boolean(window.__studio?.blocked),
      marker: localStorage.getItem("caption-studio-busy"),
      hidden: document.getElementById("recovery")?.hidden,
      src: document.getElementById("previewVideo")?.currentSrc || "",
      status: document.getElementById("status")?.textContent || "",
      error: window.__studio?.error || "",
    })).catch((error) => ({ failed: error.message }));
    if (recoveryState.ready && recoveryState.blocked && String(recoveryState.src).startsWith("blob:")) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.log("recovery state", recoveryState);
  const recovery = await page.evaluate(() => {
    const card = document.getElementById("recovery");
    const stage = document.getElementById("stageFrame");
    return {
      hidden: card.hidden,
      title: document.querySelector("#recovery h2")?.textContent || "",
      hint: document.querySelector("#recovery .hint")?.textContent || "",
      position: getComputedStyle(card).position,
      cardTop: card.getBoundingClientRect().top,
      stageTop: stage.getBoundingClientRect().top,
      starts: window.__studio.transcribeStarts,
      currentSrc: document.getElementById("previewVideo").currentSrc,
      emptyHidden: document.getElementById("stageEmpty").hidden,
    };
  });
  console.log("Recovery", recovery);
  if (recovery.hidden) throw new Error("The crash card stayed hidden.");
  if (!/stopped unexpectedly/i.test(recovery.title)) throw new Error(`Unexpected card: ${recovery.title}`);
  if (/video was open/i.test(recovery.hint)) throw new Error("The card still blames simply having a video open");
  if (recovery.position !== "absolute") throw new Error("The recovery card pushes the page instead of overlaying it");
  if (recovery.cardTop > recovery.stageTop + 4) throw new Error("The recovery card sits below the preview");
  if (!recovery.currentSrc.startsWith("blob:")) throw new Error("The saved clip did not load into the preview");
  if (!recovery.emptyHidden) throw new Error("The preview still says to upload a clip");
  if (recovery.starts !== 0) throw new Error("Reload started transcription.");
  await page.click("#resume");
  await page.waitForFunction(() => (
    document.getElementById("recovery").hidden
    && String(document.getElementById("previewVideo").currentSrc).startsWith("blob:")
  ));
  await page.screenshot({ path: path.join(artifacts, "preview-recovery.png") });

  const summary = {
    h264Canvas: played.during.canvasWidth,
    h264Video: played.before.videoWidth,
    h264Time: played.during.currentTime,
    heapMb: Math.round(played.heapAfter / 1048576),
    rssMb: Math.round(played.rssAfter / 1024),
    hevcNote,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (logs.some((line) => line.startsWith("[pageerror]"))) {
    console.log(logs.filter((line) => line.startsWith("[pageerror]")).join("\n"));
    throw new Error("The page threw while the preview test ran.");
  }
} finally {
  await browser.close();
  await server.close();
}
