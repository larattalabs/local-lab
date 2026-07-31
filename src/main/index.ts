import { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { allAdapters, availability, refresh, byModality } from './registry'
import { toInfo } from './registry/types'
import { runner } from './runner'
import { RUNS_DIR } from './env'
import type { Modality, RunRequest } from '@shared/types'
import { pathToFileURL } from 'node:url'
import { resolve, sep } from 'node:path'

/**
 * Generated artifacts are served over a custom `labfile://` scheme rather than
 * plain `file://`.
 *
 * In dev the renderer is served from http://localhost:5173, and Chromium
 * refuses to load file:// subresources from an http origin — the <img> simply
 * never appears, with no CSP violation logged. Disabling webSecurity would
 * "fix" it by turning off the sandbox for everything, which is not a trade
 * worth making for an app that spawns subprocesses.
 *
 * So: register one privileged scheme, and serve ONLY files under the runs
 * directory. A path that escapes it is refused, so a malicious renderer (or a
 * bug) can't turn this into an arbitrary file read.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'labfile',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false },
  },
])

let win: BrowserWindow | null = null

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1000,
    minHeight: 700,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0b0d10',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.on('ready-to-show', () => win?.show())

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  mkdirSync(RUNS_DIR, { recursive: true })

  const runsRoot = resolve(RUNS_DIR) + sep
  protocol.handle('labfile', (request) => {
    // URL shape is labfile://f/<the whole absolute path, URI-encoded as ONE
    // segment>. A `standard: true` scheme parses the first path segment as the
    // HOST, so the natural-looking `labfile:///Users/...` arrives with the path
    // mangled and fails the containment check. One opaque segment under a fixed
    // host sidesteps the parser entirely.
    const target = resolve(decodeURIComponent(new URL(request.url).pathname.replace(/^\//, '')))
    if (!target.startsWith(runsRoot)) {
      return new Response('forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(target).toString())
  })

  // Push every job transition to the renderer; the UI is a pure view of runner state.
  runner.onUpdate((job) => win?.webContents.send('job:update', job))

  ipcMain.handle('adapters:list', () => allAdapters().map(toInfo))
  ipcMain.handle('adapters:byModality', (_e, m: Modality) => byModality(m).map(toInfo))
  ipcMain.handle('adapters:availability', () => availability())
  ipcMain.handle('adapters:refresh', () => refresh().map(toInfo))

  ipcMain.handle('jobs:list', () => runner.list())
  ipcMain.handle('jobs:run', (_e, req: RunRequest) => runner.enqueue(req))
  ipcMain.handle('jobs:cancel', (_e, id: string) => runner.cancel(id))
  ipcMain.handle('jobs:clearFinished', () => runner.clearFinished())

  ipcMain.handle('files:pickImages', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    })
    return r.canceled ? [] : r.filePaths
  })
  ipcMain.handle('files:reveal', (_e, p: string) => shell.showItemInFolder(p))
  ipcMain.handle('files:openRuns', () => shell.openPath(RUNS_DIR))
  ipcMain.handle('app:runsDir', () => RUNS_DIR)

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
