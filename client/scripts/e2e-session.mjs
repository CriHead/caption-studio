/**
 * Phone-sized check: editing does not re-transcribe, and a reload restores
 * the clip, transcript, and chosen style without another upload.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { preview } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = "/tmp/caption-studio-session";
mkdirSync(work, { recursive: true });
const chrome = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"].find(
  (candidate) => spawnSync("test", ["-x", candidate]).status === 0,
);
if (!chrome) throw new Error("Chrome is not installed.");

function run(cmd) {
  const result = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit" });
  if (result.status !== 0) throw new Error(cmd.join(" ") + " failed");
}

const wav = path.join(work, "jfk.wav");
run(["curl", "-fsSL", "-o", wav, "https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav"]);
run([
  "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "color=c=0x1a120e:s=640x360:r=30:d=8",
  "-i", wav, "-t", "8",
  "-c:v", "libx264", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "96k",
  path.join(work, "speech.mp4"),
]);

const server = await preview({
  configFile: path.join(root, "vite.config.js"),
  preview: { host: "127.0.0.1", port: 4174, strictPort: true },
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
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  await page.goto("http://127.0.0.1:4174/", { waitUntil: "networkidle0" });
  await page.waitForFunction(() => window.__studio?.ready === true);

  const input = await page.$("#file");
  await input.uploadFile(path.join(work, "speech.mp4"));
  await page.waitForFunction(() => (window.__studio?.words?.length || 0) >= 4, { timeout: 8 * 60 * 1000 });
  const before = await page.evaluate(() => ({
    starts: window.__studio.transcribeStarts,
    fileName: window.__studio.fileName,
    transcript: window.__studio.transcript,
  }));
  if (before.starts !== 1) throw new Error(`Expected one transcription, saw ${before.starts}`);
  if (!/country|america|ask/i.test(before.transcript || "")) {
    throw new Error(`Unexpected transcript: ${before.transcript}`);
  }

  await page.click('[data-step="style"]');
  await page.click('[data-style="bold-pop"]');
  await page.click("#applyStyle");
  await page.evaluate(() => {
    document.querySelector("#animations").closest("details").open = true;
    document.querySelector("#placements").closest("details").open = true;
  });
  await page.click('[data-animation="pop"]');
  await page.click('[data-placement="center"]');
  await page.type("#cta", "Shop now");
  await page.evaluate(() => window.__studio.whenSaved);
  const edited = await page.evaluate(() => ({
    starts: window.__studio.transcribeStarts,
    fileName: window.__studio.fileName,
    styleId: window.__studio.styleId,
    words: window.__studio.words.length,
  }));
  if (edited.starts !== 1) throw new Error(`Editing re-transcribed (${edited.starts} starts).`);
  if (edited.fileName !== before.fileName) throw new Error("Editing cleared the file name.");
  if (edited.styleId !== "bold-pop") throw new Error(`Style did not stick: ${edited.styleId}`);
  if (edited.words < 4) throw new Error("Editing cleared the captions.");

  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForFunction(() => window.__studio?.ready && window.__studio?.restored, { timeout: 20000 });
  const restored = await page.evaluate(() => ({
    starts: window.__studio.transcribeStarts,
    fileName: window.__studio.fileName,
    styleId: window.__studio.styleId,
    transcript: window.__studio.transcript,
    words: window.__studio.words.length,
    cta: document.getElementById("cta").value,
    selected: document.querySelector('[data-style="bold-pop"]')?.classList.contains("selected") || false,
    resetVisible: !document.getElementById("reset").hidden,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    status: document.getElementById("status").textContent,
  }));
  console.log("Restored", restored);
  if (restored.starts !== 0) throw new Error(`Reload transcribed again (${restored.starts}).`);
  if (restored.fileName !== before.fileName) throw new Error("Reload lost the file.");
  if (restored.styleId !== "bold-pop" || !restored.selected) throw new Error("Reload lost the style.");
  if (!/country|america|ask/i.test(restored.transcript || "")) throw new Error("Reload lost the transcript.");
  if (restored.words < 4) throw new Error("Reload lost the caption words.");
  if (restored.cta !== "Shop now") throw new Error(`Reload lost the button text: ${restored.cta}`);
  if (!restored.resetVisible) throw new Error("Start over was hidden after restore.");
  if (restored.overflow > 2) throw new Error(`Mobile page overflowed by ${restored.overflow}px`);

  page.once("dialog", (dialog) => dialog.accept());
  await page.click("#reset");
  await page.evaluate(() => window.__studio.whenSaved);
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForFunction(() => window.__studio?.ready === true, { timeout: 20000 });
  const cleared = await page.evaluate(() => ({
    restored: window.__studio.restored,
    fileName: window.__studio.fileName,
    words: window.__studio.words.length,
  }));
  console.log("Cleared", cleared);
  if (cleared.restored || cleared.fileName || cleared.words) {
    throw new Error("Start over did not clear the saved clip.");
  }
  console.log("PASS session restore");
} catch (error) {
  console.error("FAIL", error);
  console.error(logs.slice(-40).join("\n"));
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
