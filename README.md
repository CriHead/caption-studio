---
title: Caption Studio
emoji: 🎬
colorFrom: pink
colorTo: yellow
sdk: docker
app_port: 7860
pinned: false
short_description: Upload a photo or video, pick a look, and save a 720p clip.
---

# Caption Studio

A free, phone-friendly app for adding captions to a photo or a short video.
Upload a file, pick a style, animation, color, placement, language, optional
emoji bursts and a call-to-action, then save a 720p MP4.

This Space wraps an original local caption engine (ASS subtitles burned in
with ffmpeg/libass, plus Ken Burns-style motion). It is not a copy of a
paid caption app.

## Browser version (free, no server)

`client/` is the same studio running entirely in the browser. The built
site is in `docs/`, ready for GitHub Pages. Videos, photos, and audio stay
on the device: Whisper (tiny or base, multilingual) transcribes speech with
word timestamps, and captions are burned into an H.264 MP4 (720p or 1080p)
with WebCodecs. Clips can run up to about 5 minutes. No API key and no paid host.

GitHub Pages cannot send the headers multithreaded WASM needs, so inference
uses one WASM thread, or WebGPU when the browser has it. The speech model
downloads once from the public Hugging Face CDN and is cached in the browser.

Enable Pages:

1. Merge this to `main` (the site already lives in `/docs`).
2. On GitHub, open **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
4. Choose branch **main** and folder **/docs**, then save.

The site will be at `https://<user>.github.io/<repo>/`. Paths are relative,
so a project site and a user site both work. To rebuild after a client
change: `cd client && npm install && npm run build`, then commit `docs/`.

A 15-second clip on a desktop CPU took about 5 seconds to transcribe with
Whisper tiny and about 2 seconds to render the 720p file. A phone is slower,
and the first transcription also downloads the model.

The Flask app in `app.py` is unchanged and can still be run locally or as
a Docker Space.

## Limits (free CPU)

- Output is 720p (landscape 1280×720, or vertical 720×1280)
- Uploads are capped at 50 MB and 60 seconds
- One render at a time
- Files you upload are processed on Hugging Face servers and deleted after
  the video is ready. Temporary files are removed after each job.

## How to use

1. Upload a photo or a short video (tap the drop zone on your phone).
2. For a photo, type a short caption. For a video, leave the box blank to
   caption the speech, or type your own words.
3. Pick a style, color, animation, placement, and language.
4. Optionally add a call-to-action (for example “Shop now”) and emoji bursts.
5. Tap **Make it**, then **Save video**.

Speech captions use the multilingual Whisper **tiny** model (CPU, int8),
pre-downloaded when the Docker image is built so the first run stays fast.

## Fonts

Only SIL Open Font License 1.1 or Apache 2.0 families are bundled, each
with its license file, plus [Noto Color Emoji](https://github.com/googlefonts/noto-emoji)
(OFL). Color emoji are also composited from PNG glyphs because libass does
not render the color-emoji font. Noto CJK (for Chinese, Japanese, and Korean)
is installed in the image from Debian’s `fonts-noto-cjk` package (OFL) rather
than being copied into this folder.

## Run locally

You need Python 3.11, ffmpeg with libass, and the packages in
`requirements.txt`.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
# Optional: cache Whisper tiny next to the app
python -c "from faster_whisper import WhisperModel; WhisperModel('tiny', device='cpu', compute_type='int8', download_root='models/faster-whisper')"
python app.py --host 0.0.0.0 --port 7860
```

Then open http://127.0.0.1:7860/

## Deploy to a Hugging Face Space

This folder is ready to push. It does **not** include a token or an account.

1. Create a free Hugging Face account.
2. Create a new Space, hardware **CPU basic**, SDK **Docker**.
3. Push this directory. `NotoColorEmoji.ttf` is a little over 10 MB, so
   Git LFS may be required (`git lfs track "fonts/noto-emoji/*.ttf"`).
4. The image build downloads the public Whisper tiny model. No access token
   is needed at build or at runtime for that step.
5. After the Space starts, share the `https://huggingface.co/spaces/...` link.

To push with the Hugging Face CLI (after you are logged in):

```bash
huggingface-cli upload YOUR_USER/caption-studio . . --repo-type space
```

## Hardware

Designed for the free CPU basic Space (2 vCPU). Encoding uses `libx264`
`veryfast` with two threads. Keep clips short so a render stays reasonable.
