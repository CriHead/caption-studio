/** Low-resolution face and subject detection. One pair of models, then they are closed. */

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.2/wasm";
const FACE_MODEL = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
const OBJECT_MODEL = "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite";

let faceDetector = null;
let objectDetector = null;
let loading = null;
let sampleCanvas = null;
let sampleCtx = null;

export function visionLoaded() {
  return Boolean(faceDetector);
}

export async function ensureVision() {
  if (faceDetector) return true;
  if (loading) return loading;
  const started = startVision().catch((error) => {
    console.warn("Subject detection is unavailable.", error);
    return false;
  });
  const timeout = new Promise((resolve) => setTimeout(() => resolve(false), 12000));
  loading = Promise.race([started, timeout]).finally(() => {
    if (!faceDetector) loading = null;
  });
  return loading;
}

async function startVision() {
  const vision = await import("@mediapipe/tasks-vision");
  const files = await vision.FilesetResolver.forVisionTasks(WASM_URL);
  faceDetector = await vision.FaceDetector.createFromOptions(files, {
    baseOptions: { modelAssetPath: FACE_MODEL, delegate: "CPU" },
    runningMode: "IMAGE",
    minDetectionConfidence: 0.5,
  });
  objectDetector = await vision.ObjectDetector.createFromOptions(files, {
    baseOptions: { modelAssetPath: OBJECT_MODEL, delegate: "CPU" },
    runningMode: "IMAGE",
    scoreThreshold: 0.4,
    maxResults: 5,
  });
  return true;
}

export async function unloadVision() {
  try { faceDetector?.close?.(); } catch { /* already closed */ }
  try { objectDetector?.close?.(); } catch { /* already closed */ }
  faceDetector = null;
  objectDetector = null;
  loading = null;
  sampleCanvas = null;
  sampleCtx = null;
}

function normalized(box, width, height) {
  if (!box || !width || !height) return null;
  const w = box.width / width;
  const h = box.height / height;
  if (w < 0.02 || h < 0.02) return null;
  return {
    x: box.originX / width,
    y: box.originY / height,
    w,
    h,
  };
}

/** Detect on a small copy of the frame. The full-resolution picture is not stored. */
export async function detectKeepOut(source) {
  const ready = await ensureVision();
  if (!ready || !source) return [];
  const sw = source.videoWidth || source.naturalWidth || source.width || 0;
  const sh = source.videoHeight || source.naturalHeight || source.height || 0;
  if (!sw || !sh) return [];
  const width = 192;
  const height = Math.max(64, Math.round((width * sh) / sw));
  if (!sampleCanvas) {
    sampleCanvas = document.createElement("canvas");
    sampleCtx = sampleCanvas.getContext("2d", { alpha: false, willReadFrequently: true });
  }
  if (sampleCanvas.width !== width || sampleCanvas.height !== height) {
    sampleCanvas.width = width;
    sampleCanvas.height = height;
  }
  sampleCtx.drawImage(source, 0, 0, width, height);
  const boxes = [];
  try {
    const faces = faceDetector.detect(sampleCanvas);
    for (const hit of faces.detections || []) {
      const box = normalized(hit.boundingBox, width, height);
      if (box) boxes.push(box);
    }
  } catch { /* this frame can be skipped */ }
  try {
    const found = objectDetector.detect(sampleCanvas);
    for (const hit of found.detections || []) {
      const box = normalized(hit.boundingBox, width, height);
      if (box) boxes.push(box);
    }
  } catch { /* this frame can be skipped */ }
  return boxes;
}
