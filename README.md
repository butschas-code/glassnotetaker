# GlassCall Notes

Local-first macOS utility that captures **system audio** during calls (Zoom, Google Meet, Teams), then **transcribes** with **WhisperX** (default: ASR + alignment + optional **speaker diarization** via pyannote), **summarizes** via LM Studio (OpenAI-compatible API), and creates a structured **Notion** page. Metadata is stored in **SQLite** (via sql.js).

Outputs per recording include **`*.transcript.json`** (segments with `speaker`, `start`, `end`, `text`) and **`*.transcript.txt`** (human-readable). The summarizer receives diarized lines like `[mm:ss] SPEAKER_00: …`.

## Requirements

- macOS **14** or later (ScreenCaptureKit paths used by the Swift helper)
- Apple Silicon recommended (M1 MacBook Pro 16 GB RAM is enough for `small` / `medium` Whisper models)
- **Xcode Command Line Tools** (for `swift build`)
- **Node.js** 20+ and **npm**
- **Python 3.10–3.12** recommended (with `pip`); **ffmpeg** on `PATH` (`brew install ffmpeg`)
- **LM Studio** running locally with a chat model loaded
- **Notion** integration token and a database with matching properties (see below)

## Quick start (development)

```bash
cd glasscall-notes

# 1) JavaScript / Electron
npm install

# 2) Native system-audio capture helper (ScreenCaptureKit)
npm run native:audio

# 3) Python env + WhisperX (see “Python environment” below). If `python3` is 3.14, use 3.12 or 3.13:
#    PYTHON=/usr/local/bin/python3.13 npm run python:install
npm run python:install

# 4) Run the app
npm run dev
```

On first launch, grant **Screen Recording** when macOS prompts (System Settings → Privacy & Security → Screen Recording → enable **GlassCall Notes** / **Electron** during development).

## Settings you must configure

Open **Settings** in the app:

| Field | Purpose |
| --- | --- |
| **Notion integration token** | Internal integration secret (`secret_…`) |
| **Notion database ID** | Target database for new pages |
| **Property names** | Must match your database: default `Name`, `Date`, `Status`, `Duration` |
| **LM Studio base URL** | Usually `http://localhost:1234/v1` |
| **LM Studio model name** | Exact loaded model id as shown in LM Studio |
| **Transcription backend** | `whisperx` (default) or `faster_whisper` |
| **Diarization** | Toggle + **Hugging Face token** (free; accept pyannote model licenses on huggingface.co) |
| **WhisperX model** | e.g. `large-v2` — larger = better quality, more RAM/time |
| **faster-whisper model** | Used for `faster_whisper` backend and as fallback if WhisperX fails |
| **Transcript language** | e.g. `en`, or `auto` |
| **Recording mode** | System-only vs **Mic + system** (experimental two-track) |

### Notion database schema

Create a Notion database with:

- **Name** — Title
- **Date** — Date
- **Status** — Select (include option **Completed**)
- **Duration** — Text

If your property names differ, change them in Settings.

### LM Studio

1. Start LM Studio and load a model.
2. Open the **Local Server** tab and start the server (default port **1234**).
3. Use the same **model name** in GlassCall Notes settings as in LM Studio.

## Packaging (macOS)

```bash
npm run native:audio
npm run build:vite
# Copy the Swift helper next to the app bundle resources if you use a custom script, or run from dev paths documented in paths.ts
npm run build
```

The `electron-builder` configuration signs with hardened runtime entitlements in `build/entitlements.mac.plist`. For ad-hoc local use you may need to adjust signing in `package.json` under `build.mac`.

**Bundling the Swift binary:** after `swift build -c release`, copy `native/GlassCallAudioCapture/.build/arm64-apple-macosx/release/GlassCallAudioCapture` (or `release/` on your machine) into the app’s `Resources` folder as `GlassCallAudioCapture`, **or** run from the project tree so `paths.ts` can find `.build` during development.

## Architecture (short)

- **Electron main**: IPC, SQLite (sql.js), orchestration (record → transcribe → LM Studio → Notion).
- **Preload**: `contextBridge` API `window.glasscall`.
- **Renderer**: React + glass-style CSS (vibrancy under the window on macOS).
- **Swift helper**: `ScreenCaptureKit` stream with `capturesAudio`, writes **M4A**, stops on `STOP` over stdin, prints result JSON on stdout.
- **Python**: `python-worker/transcribe.py` runs **WhisperX** (or **faster-whisper**), writes **`transcript.json`** + **`transcript.txt`**, streams progress phases on stderr for the UI (`transcribing` vs `diarizing`).

## A) Transcription dependencies (Node + Python)

**Node (project root)** — unchanged from the Electron app: see `package.json` (`electron`, `electron-vite`, `react`, `sql.js`, `@notionhq/client`, `zod`, …).

**Python (`python-worker/requirements.txt`)** — core stack:

| Package | Role |
| --- | --- |
| `torch`, `torchaudio` | Backend for WhisperX / alignment (Apple Silicon: MPS optional; CPU is the most reliable default for long jobs) |
| `numpy` | Numerics |
| `ffmpeg-python` | Helper bindings (CLI `ffmpeg` must still be installed) |
| `whisperx` | ASR + forced alignment + diarization pipeline |
| `faster-whisper` | Fallback ASR if WhisperX errors; also the `faster_whisper` backend |
| `huggingface_hub` | Authentication for pyannote models |

**System:** `ffmpeg` (e.g. `brew install ffmpeg`).

**Hugging Face (diarization):** create a token and accept the user conditions for **pyannote** segmentation/diarization models (no paid API; license acceptance required). Use the same token in **Settings** or set `HF_TOKEN`.

## B) Python environment setup on Apple Silicon (M1, 16 GB RAM)

**Do not use Python 3.14** for WhisperX yet — the installer will exit with a clear message. Use **3.12** (recommended) or **3.13**.

From the repo root:

```bash
npm run python:install
```

That runs `python-worker/install.sh`, which creates `python-worker/.venv` and installs `requirements.txt` (WhisperX **≥3.8** pulls a compatible PyTorch stack).

If your default `python3` is 3.14, point at 3.12/3.13 explicitly:

```bash
PYTHON=/usr/local/bin/python3.13 npm run python:install
# or after: brew install python@3.12
PYTHON=/opt/homebrew/opt/python@3.12/bin/python3.12 npm run python:install
```

Point the app at the venv interpreter (optional): set env **`GLASSCALL_PYTHON`** to  
`.../glasscall-notes/python-worker/.venv/bin/python3` in your shell or `.env`.

**RAM:** for 30–120 minute calls, prefer **`medium`** or **`large-v2`** WhisperX models with **batch size 4–8** in Settings if you see memory pressure; use **`large-v3`** only if you have headroom.

## Transcription quality notes (mixed / system audio)

- **Single mixed system track:** Zoom/Meet/Teams downmix everyone into one stereo signal. Diarization then relies on **acoustic speaker change**, not separate channels — accuracy is good but not studio-perfect.
- **Two-track “Mic + system” mode:** records **system output** and **your microphone** into separate files, then **ffmpeg-amixes** them to mono before WhisperX. This helps **separate you vs remote** somewhat but is still a single mixed stream for the model; it does not restore a per-remote-participant stem.
- **Diarization off or HF token missing:** segments still have **timestamps**; speakers are **`Unknown`**.
- **WhisperX failure:** worker automatically falls back to **faster-whisper** with **`Unknown`** speakers (still timestamped).

## Troubleshooting

| Issue | What to check |
| --- | --- |
| Native binary not found | Run `npm run native:audio` and confirm `.build/.../GlassCallAudioCapture` exists |
| Screen capture fails | Screen Recording permission for the app; restart app after enabling |
| Transcription fails | Use Python **3.12/3.13** (not 3.14); run `npm run python:install`; install **`ffmpeg`** (`brew install ffmpeg`); set `GLASSCALL_PYTHON` to venv python |
| pip `ResolutionImpossible` | Same as above — old `whisperx` + `numpy<2` + Python 3.14 caused conflicts; use the new `install.sh` + `requirements.txt` |
| LM Studio errors | Server running, model name exact, URL includes `/v1` |
| Notion errors | Token, database ID, property names and types match |

## License

Personal / internal use; not prepared for App Store submission without further hardening and review.
