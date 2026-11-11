/** Phone-sized check: automatic captions, face avoidance, style apply, play icon, and sound. */
import puppeteer from "puppeteer-core";
import { createServer } from "vite";

const chrome = "/usr/bin/google-chrome";
const server = await createServer({
  configFile: "/workspace/client/vite.config.js",
  server: { host: "127.0.0.1", port: 4397, strictPort: true },
});
await server.listen();
const origin = server.resolvedUrls?.local?.[0] || "http://127.0.0.1:4397/";
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  protocolTimeout: 180000,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
page.on("pageerror", (error) => console.log("pageerror", error.message));
try {
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__studio?.ready === true);
  const input = await page.$("#file");
  await input.uploadFile("/tmp/cs-face/speech.mp4");
  await page.waitForFunction(() => (window.__studio?.words?.length || 0) >= 4, { timeout: 180000 });
  const heard = await page.evaluate(() => ({
    words: window.__studio.words.length,
    transcript: window.__studio.transcript,
    status: document.getElementById("status").textContent,
  }));
  console.log("heard", heard);
  await page.click("#play");
  await page.waitForFunction(() => (window.__studio.keepOut || []).some((sample) => (sample.boxes || []).length), { timeout: 90000 });
  const playback = await page.evaluate(() => {
    const video = document.getElementById("previewVideo");
    const play = document.getElementById("play");
    let tracks = 0;
    try { tracks = video.captureStream().getAudioTracks().length; } catch { /* ignore */ }
    return {
      muted: video.muted,
      volume: video.volume,
      paused: video.paused,
      time: video.currentTime,
      tracks,
      playingClass: play.classList.contains("is-playing"),
      hasPlay: Boolean(play.querySelector(".icon-play")),
      hasPause: Boolean(play.querySelector(".icon-pause")),
    };
  });
  console.log("playback", playback);
  if (playback.muted || !(playback.volume > 0)) throw new Error("Preview audio is muted");
  if (playback.paused || playback.time < 0.2) throw new Error("Play did not start");
  if (playback.tracks < 1) throw new Error("No audio track on the preview");
  if (!playback.playingClass || !playback.hasPlay || !playback.hasPause) throw new Error("Play button is missing the play/pause icons");
  await page.screenshot({ path: "/opt/cursor/artifacts/phone-auto-captions.png" });

  const placed = await page.evaluate(() => {
    const canvas = document.getElementById("stage");
    const ctx = canvas.getContext("2d");
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const samples = window.__studio.keepOut || [];
    const boxes = samples.flatMap((sample) => sample.boxes || []);
    let face = null;
    for (const box of boxes) {
      if (!face || box.w * box.h > face.w * face.h) face = box;
    }
    let bright = 0;
    let inside = 0;
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const i = (y * width + x) * 4;
        if (data[i] > 200 && data[i + 1] > 185 && data[i + 3] > 140) {
          bright += 1;
          if (face) {
            const nx = x / width;
            const ny = y / height;
            if (nx >= face.x && nx <= face.x + face.w && ny >= face.y && ny <= face.y + face.h) inside += 1;
          }
        }
      }
    }
    return { bright, inside, samples: samples.length, face };
  });
  console.log("placed", JSON.stringify(placed));
  if (placed.bright < 8) throw new Error("Captions were not drawn on the preview");
  if (!placed.face) throw new Error("No face or subject box was found");
  if (placed.inside / placed.bright > 0.35) {
    throw new Error(`Captions cover the face (${placed.inside} of ${placed.bright} bright pixels)`);
  }

  await page.click('[data-step="style"]');
  await page.click('[data-style="bold-pop"]');
  await new Promise((resolve) => setTimeout(resolve, 400));
  const previewing = await page.evaluate(() => ({
    previewing: document.querySelector('[data-style="bold-pop"]')?.classList.contains("previewing"),
    applyHidden: document.getElementById("styleActions").hidden,
    styleId: window.__studio.styleId,
  }));
  console.log("previewing", previewing);
  if (!previewing.previewing || previewing.applyHidden) throw new Error("Style preview did not open");
  if (previewing.styleId === "bold-pop") throw new Error("The style was applied before Apply");
  await page.screenshot({ path: "/opt/cursor/artifacts/phone-style-preview.png" });
  await page.click("#applyStyle");
  const applied = await page.evaluate(() => window.__studio.styleId);
  if (applied !== "bold-pop") throw new Error(`Apply did not keep the style (${applied})`);
  await page.screenshot({ path: "/opt/cursor/artifacts/phone-play.png" });
  console.log("FACE_OK");
} finally {
  await browser.close();
  await server.close();
}
