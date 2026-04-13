import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export function getUserDataPath(): string {
  return app.getPath('userData')
}

export function getDbPath(): string {
  return join(getUserDataPath(), 'glasscall.sqlite')
}

export function ensureOutputDir(custom?: string): string {
  const base = custom?.trim() || join(getUserDataPath(), 'recordings')
  if (!existsSync(base)) {
    mkdirSync(base, { recursive: true })
  }
  return base
}

function projectRootCandidates(): string[] {
  const cwd = process.cwd()
  const appPath = app.getAppPath()
  return [cwd, appPath, join(appPath, '..'), join(__dirname, '..', '..', '..')]
}

export function resolveAudioCaptureBinary(): string {
  if (app.isPackaged) {
    const bundled = join(process.resourcesPath, 'GlassCallAudioCapture')
    if (existsSync(bundled)) return bundled
  }

  const relPaths = [
    ['native', 'GlassCallAudioCapture', '.build', 'arm64-apple-macosx', 'release', 'GlassCallAudioCapture'],
    ['native', 'GlassCallAudioCapture', '.build', 'release', 'GlassCallAudioCapture'],
    ['resources', 'GlassCallAudioCapture']
  ]
  for (const root of projectRootCandidates()) {
    for (const segs of relPaths) {
      const p = join(root, ...segs)
      if (existsSync(p)) return p
    }
  }
  return join(process.cwd(), ...relPaths[0])
}

export function resolvePythonWorkerDir(): string {
  if (app.isPackaged) {
    const unpacked = join(process.resourcesPath, 'app.asar.unpacked', 'python-worker')
    if (existsSync(join(unpacked, 'transcribe.py'))) return unpacked
  }

  const sub = ['python-worker', 'transcribe.py']
  for (const root of projectRootCandidates()) {
    const p = join(root, ...sub)
    if (existsSync(p)) return join(root, 'python-worker')
  }
  const packaged = join(process.resourcesPath, 'python-worker')
  if (existsSync(join(packaged, 'transcribe.py'))) return packaged
  return join(process.cwd(), 'python-worker')
}
