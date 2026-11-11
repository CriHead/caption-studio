/** Keep the clip, transcript, and settings on this device across reloads. */

const DB_NAME = "caption-studio";
const STORE = "session";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function put(key, value) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(STORE).put(value, key);
    });
  } finally {
    db.close();
  }
}

async function get(key) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export function saveMedia(media) {
  return put("media", media);
}

export function saveVoice(voice) {
  return put("voice", voice);
}

export function saveCaptions(captions) {
  return put("captions", captions);
}

export function saveSettings(settings) {
  return put("settings", settings);
}

export async function loadSession() {
  const [media, voice, captions, settings] = await Promise.all([
    get("media"),
    get("voice"),
    get("captions"),
    get("settings"),
  ]);
  return { media, voice, captions, settings };
}

export async function clearSession() {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(STORE).clear();
    });
  } finally {
    db.close();
  }
}
