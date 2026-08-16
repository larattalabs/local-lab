import { app, BrowserWindow, ipcMain, dialog, shell, protocol } from 'electron'
import { join } from 'node:path'
import { createReadStream, mkdirSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { allAdapters, availability, refresh, byModality } from './registry'
import { toInfo } from './registry/types'
import { runner } from './runner'
import { deleteRun, listRuns } from './history'
import { deleteChat, listChats, saveChat } from './chats'
import { RUNS_DIR } from './env'
import type { Chat, Modality, RunRequest } from '@shared/types'
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

// Dev affordance, opt-in: LOCALLAB_CDP=<port> opens Chrome DevTools Protocol
// on that port so an agent or script can drive the real UI (Runtime.evaluate
// against the renderer) instead of guessing at screen coordinates. Never set
// in normal use; nothing listens unless you ask.
if (process.env.LOCALLAB_CDP) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.LOCALLAB_CDP)
}

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
    // Serve the bytes ourselves with real Range support. Proxying through
    // net.fetch(file://) drops the renderer's Range header and answers with a
    // rangeless 200 — Chromium's media stack then can't seek, so the scrub bar
    // snaps back and <audio> duration is a guess until the stream ends.
    let size: number
    try {
      const st = statSync(target)
      if (!st.isFile()) return new Response('not a file', { status: 404 })
      size = st.size
    } catch {
      return new Response('not found', { status: 404 })
    }
    const type =
      { wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', mp4: 'video/mp4',
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
        txt: 'text/plain; charset=utf-8' }[target.split('.').pop() ?? ''] ??
      'application/octet-stream'
    const headers: Record<string, string> = { 'Content-Type': type, 'Accept-Ranges': 'bytes' }

    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range') ?? '')
    let start = 0
    let end = size - 1
    if (range && (range[1] || range[2])) {
      start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
      if (range[1] && range[2]) end = Math.min(Number(range[2]), size - 1)
      if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`
    }
    headers['Content-Length'] = String(end - start + 1)
    const body = Readable.toWeb(
      createReadStream(target, { start, end })
    ) as ReadableStream<Uint8Array>
    return new Response(body, { status: range ? 206 : 200, headers })
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
  ipcMain.handle('history:list', () => listRuns())
  ipcMain.handle('history:delete', (_e, dir: string) => deleteRun(dir))
  ipcMain.handle('chats:list', () => listChats())
  ipcMain.handle('chats:save', (_e, chat: Chat) => saveChat(chat))
  ipcMain.handle('chats:delete', (_e, id: string) => deleteChat(id))
  ipcMain.handle('files:openRuns', () => shell.openPath(RUNS_DIR))
  ipcMain.handle('app:runsDir', () => RUNS_DIR)

  createWindow()

  // Dev affordance: LOCALLAB_SHOT=/some/dir makes the app write a PNG of its
  // own window there every 2s. Lets an agent (or a bug report) see the real
  // rendered UI without fighting macOS screen-recording permissions — the app
  // captures itself via capturePage, which needs no permission at all.
  const shotDir = process.env.LOCALLAB_SHOT
  if (shotDir) {
    mkdirSync(shotDir, { recursive: true })
    setInterval(async () => {
      if (!win || win.isDestroyed()) return
      try {
        const img = await win.webContents.capturePage()
        const { writeFile } = await import('node:fs/promises')
        await writeFile(join(shotDir, 'locallab.png'), img.toPNG())
      } catch {
        /* window mid-teardown — skip this tick */
      }
    }, 2000)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
