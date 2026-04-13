import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { openDatabase } from './db'
import {
  cancelRecording,
  loadAppData,
  persistSettings,
  retryRecording,
  startRecordingSession,
  stopRecordingAndProcess
} from './pipeline'
import type { PipelineProgress } from '../shared/types'

const __dirname = dirname(fileURLToPath(import.meta.url))

function resolvePreloadPath(): string {
  const mjs = join(__dirname, '../preload/index.mjs')
  const js = join(__dirname, '../preload/index.js')
  if (existsSync(mjs)) return mjs
  return js
}

let mainWindow: BrowserWindow | null = null

function sendProgress(p: PipelineProgress) {
  mainWindow?.webContents.send('pipeline:progress', p)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 520,
    minWidth: 360,
    minHeight: 160,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    roundedCorners: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: resolvePreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark'

  try {
    await openDatabase()
  } catch (e) {
    console.error('[glasscall] openDatabase failed', e)
    await dialog.showMessageBox({
      type: 'error',
      title: 'GlassCall Notes',
      message: 'Could not open the local database.',
      detail: String(e),
      buttons: ['OK']
    })
  }

  createWindow()

  ipcMain.handle('app:load', () => {
    try {
      return loadAppData()
    } catch (e) {
      console.error('[glasscall] app:load', e)
      throw e
    }
  })

  ipcMain.handle('settings:save', (_, patch: Parameters<typeof persistSettings>[0]) => {
    return persistSettings(patch)
  })

  ipcMain.handle('recording:start', async () => {
    return startRecordingSession(sendProgress)
  })

  ipcMain.handle('recording:stop', async () => {
    await stopRecordingAndProcess(sendProgress)
    return loadAppData()
  })

  ipcMain.handle('recording:cancel', () => {
    const rid = cancelRecording()
    if (rid) {
      sendProgress({ recordingId: rid, state: 'failed', message: 'Cancelled' })
    }
    return loadAppData()
  })

  ipcMain.handle('recording:retry', async (_, recordingId: string) => {
    await retryRecording(recordingId, sendProgress)
    return loadAppData()
  })

  ipcMain.handle('shell:openExternal', async (_, url: string) => {
    if (typeof url === 'string' && url.startsWith('http')) {
      await shell.openExternal(url)
    }
  })

  ipcMain.handle('path:reveal', async (_, filePath: string) => {
    if (typeof filePath === 'string' && filePath && existsSync(filePath)) {
      await shell.showItemInFolder(filePath)
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
