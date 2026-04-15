import { app, BrowserWindow, desktopCapturer, ipcMain } from 'electron'
import { createWriteStream, existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export interface AudioCaptureResult {
  outputPath: string
  durationSec: number
}

export class AudioCaptureError extends Error {
  constructor(
    message: string,
    public readonly code?: string
  ) {
    super(message)
    this.name = 'AudioCaptureError'
  }
}

function resolveCapturePreload(): string {
  const mjs = join(__dirname, '../preload/capture/preload.mjs')
  const js = join(__dirname, '../preload/capture/preload.js')
  if (existsSync(mjs)) return mjs
  return js
}

function micGainDbToLinear(db: number): number {
  const clamped = Math.max(0, Math.min(24, db))
  return Math.pow(10, clamped / 20)
}

function captureScript(micGainLinear: number): string {
  const gain = Number.isFinite(micGainLinear) && micGainLinear > 0 ? micGainLinear : 1
  return `
(async () => {
  const api = window.captureApi;
  const allStreams = [];
  const MIC_GAIN = ${gain};

  try {
    // 1. System audio via getDisplayMedia (loopback)
    let sysStream = null;
    try {
      sysStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      const vt = sysStream.getVideoTracks()[0];
      if (vt) vt.stop();
      allStreams.push(sysStream);
    } catch (e) {
      console.warn('System audio unavailable:', e.message);
    }

    // 2. Microphone via getUserMedia
    let micStream = null;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
      allStreams.push(micStream);
    } catch (e) {
      console.warn('Microphone unavailable:', e.message);
    }

    const sysAudioTracks = sysStream ? sysStream.getAudioTracks() : [];
    const micAudioTracks = micStream ? micStream.getAudioTracks() : [];

    if (!sysAudioTracks.length && !micAudioTracks.length) {
      api.sendError('No audio sources available. Grant Screen Recording and Microphone permissions.');
      return;
    }

    // 3. Mix both sources using Web Audio API
    const ctx = new AudioContext({ sampleRate: 48000 });
    const dest = ctx.createMediaStreamDestination();

    if (sysAudioTracks.length) {
      const sysSource = ctx.createMediaStreamSource(new MediaStream(sysAudioTracks));
      sysSource.connect(dest);
    }
    if (micAudioTracks.length) {
      const micSource = ctx.createMediaStreamSource(new MediaStream(micAudioTracks));
      const micGain = ctx.createGain();
      micGain.gain.value = MIC_GAIN;
      micSource.connect(micGain);
      micGain.connect(dest);
    }

    // 4. Record the mixed output
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus' : 'audio/webm';
    const recorder = new MediaRecorder(dest.stream, { mimeType, audioBitsPerSecond: 192000 });
    const startTime = Date.now();

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) e.data.arrayBuffer().then(buf => api.sendChunk(buf));
    };
    recorder.onstop = () => {
      api.sendDone((Date.now() - startTime) / 1000);
      allStreams.forEach(s => s.getTracks().forEach(t => t.stop()));
      ctx.close().catch(() => {});
    };
    recorder.onerror = (e) => api.sendError('MediaRecorder error: ' + (e.error?.message || 'unknown'));
    recorder.start(1000);

    const sources = [];
    if (sysAudioTracks.length) sources.push('system');
    if (micAudioTracks.length) sources.push('mic');
    api.sendReady();
    api.sendLog('Capturing: ' + sources.join(' + '));

    api.onStop(() => {
      if (recorder.state !== 'inactive') recorder.stop();
      else api.sendDone(0);
    });
  } catch (err) {
    allStreams.forEach(s => s.getTracks().forEach(t => t.stop()));
    api.sendError('Capture failed: ' + (err.message || String(err)));
  }
})();
`
}

export class SystemAudioCapture {
  private win: BrowserWindow | null = null
  private fileStream: ReturnType<typeof createWriteStream> | null = null
  private bytesWritten = 0
  private started = false
  private resolveStop: ((r: AudioCaptureResult) => void) | null = null
  private rejectStop: ((e: Error) => void) | null = null
  private onReadyOnce: (() => void) | null = null
  private onErrorOnce: ((msg: string) => void) | null = null

  constructor(
    private readonly outputPath: string,
    private readonly opts?: { micGainDb?: number }
  ) {}

  async start(): Promise<void> {
    try { if (existsSync(this.outputPath)) unlinkSync(this.outputPath) } catch { /* ok */ }

    this.fileStream = createWriteStream(this.outputPath)
    this.bytesWritten = 0

    this.win = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      webPreferences: {
        preload: resolveCapturePreload(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })

    this.win.webContents.session.setDisplayMediaRequestHandler(async (_req, cb) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] })
        if (!sources.length) { cb({}); return }
        cb({ video: sources[0], audio: 'loopback' })
      } catch {
        cb({})
      }
    })

    ipcMain.on('capture:chunk', this.onChunk)
    ipcMain.on('capture:done', this.onDone)
    ipcMain.on('capture:error', this.onError)
    ipcMain.on('capture:ready', this.onReady)
    ipcMain.on('capture:log', this.onLog)

      const micDb = this.opts?.micGainDb ?? 6
      const js = captureScript(micGainDbToLinear(micDb))

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.cleanup()
        reject(new AudioCaptureError('Timed out starting audio capture', 'START_TIMEOUT'))
      }, 15_000)

      this.onReadyOnce = () => {
        clearTimeout(timeout)
        this.started = true
        resolve()
      }
      this.onErrorOnce = (msg: string) => {
        clearTimeout(timeout)
        this.cleanup()
        reject(new AudioCaptureError(msg, 'START_FAILED'))
      }

      const htmlPath = join(app.getPath('temp'), 'glasscall-capture.html')
      writeFileSync(htmlPath, '<!DOCTYPE html><html><head></head><body></body></html>', 'utf8')
      this.win!.loadFile(htmlPath)
      this.win!.webContents.once('did-finish-load', () => {
        this.win?.webContents.executeJavaScript(js).catch((err: Error) => {
          clearTimeout(timeout)
          this.cleanup()
          reject(new AudioCaptureError('Script error: ' + err.message, 'SCRIPT_ERROR'))
        })
      })
    })
  }

  stop(): Promise<AudioCaptureResult> {
    return new Promise((resolve, reject) => {
      if (!this.win || !this.started) {
        reject(new AudioCaptureError('Capture not running', 'NOT_RUNNING'))
        return
      }

      this.resolveStop = resolve
      this.rejectStop = reject

      const timeout = setTimeout(() => {
        const rej = this.rejectStop
        this.cleanup()
        rej?.(new AudioCaptureError('Timed out stopping audio capture', 'TIMEOUT'))
      }, 30_000)

      const origResolve = resolve
      this.resolveStop = (r) => {
        clearTimeout(timeout)
        origResolve(r)
      }
      const origReject = reject
      this.rejectStop = (e) => {
        clearTimeout(timeout)
        origReject(e)
      }

      this.win.webContents.send('capture:stop')
    })
  }

  kill(): void {
    this.cleanup()
  }

  private onReady = () => {
    this.onReadyOnce?.()
    this.onReadyOnce = null
  }

  private onLog = (_event: Electron.IpcMainEvent, message: string) => {
    console.log('[capture]', message)
  }

  private onChunk = (_event: Electron.IpcMainEvent, buf: Buffer) => {
    if (this.fileStream) {
      this.fileStream.write(buf)
      this.bytesWritten += buf.length
    }
  }

  private onDone = (_event: Electron.IpcMainEvent, durationSec: number) => {
    const resolve = this.resolveStop
    const reject = this.rejectStop
    const bytes = this.bytesWritten
    this.cleanup()
    if (bytes === 0) {
      reject?.(
        new AudioCaptureError(
          'No audio was recorded. Check Screen Recording permission in System Settings → Privacy & Security.',
          'NO_AUDIO'
        )
      )
      return
    }
    resolve?.({ outputPath: this.outputPath, durationSec })
  }

  private onError = (_event: Electron.IpcMainEvent, message: string) => {
    if (this.onErrorOnce) {
      this.onErrorOnce(message)
      this.onErrorOnce = null
      return
    }
    const reject = this.rejectStop
    this.cleanup()
    reject?.(new AudioCaptureError(message, 'CAPTURE_ERROR'))
  }

  private cleanup(): void {
    this.onReadyOnce = null
    this.onErrorOnce = null

    ipcMain.removeListener('capture:chunk', this.onChunk)
    ipcMain.removeListener('capture:done', this.onDone)
    ipcMain.removeListener('capture:error', this.onError)
    ipcMain.removeListener('capture:ready', this.onReady)
    ipcMain.removeListener('capture:log', this.onLog)

    if (this.fileStream) {
      this.fileStream.end()
      this.fileStream = null
    }
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy()
    }
    this.win = null
    this.started = false
  }
}
