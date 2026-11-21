import { containedPath, MEDIA_TYPES, mediaRange } from './phone/assets'
import { HistoryReset, recoverHistory } from './history-reset'
import type { HistoryClear } from '@shared/history-reset'
import type { ModifierConfig } from '@shared/modifiers'
import { app, BrowserWindow, ipcMain, dialog, shell, protocol, powerSaveBlocker, nativeImage } from 'electron'
import { join, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createReadStream, mkdirSync, statSync, copyFileSync, realpathSync } from 'node:fs'
import { Readable } from 'node:stream'
import { allAdapters, availability, refresh, byModality } from './registry'
import { toInfo } from './registry/types'
import { runner } from './runner'
import { deleteRun, listRuns } from './history'
import { Conversations } from './conversations'
import { StudioService } from './studio/service'
import type { StudioChange } from '@shared/studio'
import { BasicService } from './basic/service'
import type { BasicInput, BasicPreset } from '@shared/basic'
import { AI_ROOT } from './env'
import { Director } from './director/service'
import { validateTurn } from './phone/validation'
import type { DirectorConfig, DirectorStart } from '@shared/director'
import { PhoneServer } from './phone/server'
import { registerCodeIpc } from './code/ipc'
import { RUNS_DIR } from './env'
import type { Job, Modality, RunRequest, SubmitTurn } from '@shared/types'
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

if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => { if (win) { win.show(); win.focus() } else createWindow() })
let win: BrowserWindow | null = null
let phone: PhoneServer | undefined
let director: Director
let basic: BasicService
let conversations: Conversations

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
  win.on('closed', () => { win = null })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  mkdirSync(RUNS_DIR, { recursive: true })
  const recovered = recoverHistory(RUNS_DIR, app.getPath('userData'))
  conversations = new Conversations(runner, undefined, (turn) => { basic.verify(turn); return director.resolve(turn) })


  const thumbnails = new Map<string,Promise<Buffer | undefined>>()
  function thumbnail(path: string) {
    const st = statSync(path)
    const key = JSON.stringify([path,st.mtimeMs,st.size])
    const existing = thumbnails.get(key)
    if (existing) return existing
    const pending = nativeImage.createThumbnailFromPath(path,{width:240,height:240})
      .then(image => image.isEmpty() ? undefined : image.toJPEG(78)).catch(() => undefined)
    if (thumbnails.size >= 96) thumbnails.delete(thumbnails.keys().next().value!)
    thumbnails.set(key,pending)
    return pending
  }

  protocol.handle('labfile', async (request) => {
    // URL shape is labfile://f/<the whole absolute path, URI-encoded as ONE
    // segment>. A `standard: true` scheme parses the first path segment as the
    // HOST, so the natural-looking `labfile:///Users/...` arrives with the path
    // mangled and fails the containment check. One opaque segment under a fixed
    // host sidesteps the parser entirely.
    let target: string
    try { target = containedPath(RUNS_DIR, decodeURIComponent(new URL(request.url).pathname.slice(1))) }
    catch { return new Response('Media unavailable', { status: 404 }) }
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
    const type = MEDIA_TYPES[extname(target).toLowerCase()] ?? (extname(target) === '.txt' ? 'text/plain' : undefined)
    if (!type) return new Response('Unsupported media', { status: 415 })
    if (type.startsWith('image/') && new URL(request.url).searchParams.has('thumbnail')) {
      const jpeg = await thumbnail(target)
      if (jpeg) return new Response(new Uint8Array(jpeg), { headers: { 'Content-Type': 'image/jpeg' } })
    }
    const headers: Record<string, string> = { 'Content-Type': type, 'Accept-Ranges': 'bytes' }
    const range = request.headers.get('Range')
    const bounds = mediaRange(size, range)
    if (!bounds) return new Response(null,{status:416,headers:{'Content-Range':`bytes */${size}`}})
    const {start,end} = bounds
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
    if (!size || request.method === 'HEAD') return new Response(null,{status:range?206:200, headers:{...headers,'Content-Length':String(Math.max(0,end-start+1))}})
    headers['Content-Length'] = String(end - start + 1)
    const body = Readable.toWeb(
      createReadStream(target, { start, end })
    ) as ReadableStream<Uint8Array>
    return new Response(body, { status: range ? 206 : 200, headers })
  })

  director = new Director(app.getPath('userData'), RUNS_DIR, runner, {
    adapters: () => allAdapters().map(toInfo), chats: () => conversations.list(), submit: (turn) => conversations.submit(turn),
    image: (path) => {
      const image = nativeImage.createFromPath(path)
      if (image.isEmpty()) throw new Error('Could not read the reference image.')
      const size = image.getSize(), scale = Math.min(1, 1024 / Math.max(size.width, size.height))
      return image.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale) }).toJPEG(85).toString('base64')
    },
  })
  basic = new BasicService(app.getPath('userData'), RUNS_DIR, join(AI_ROOT, 'local-lab-private', 'basic-profiles.json'), {
    adapters: () => allAdapters().map(toInfo), available: () => availability().filter((a) => a.available).map((a) => a.id),
    chats: () => conversations.list(), directorConfig: async () => (await director.info()).config,
  })
  const studio = new StudioService(app.getPath('userData'), RUNS_DIR)
  const history = new HistoryReset(RUNS_DIR, app.getPath('userData'), {
    busy: () => runner.list().some((j) => ['queued','running'].includes(j.state)),
    trash: (path) => shell.trashItem(path),
    reset: () => {
      thumbnails.clear()
      conversations.resetHistory(); runner.clearFinished(); director.resetHistory()
      const errors: unknown[] = []
      for (const reset of [() => basic.resetHistory(), () => studio.resetHistory()]) try { reset() } catch(e) { errors.push(e) }
      if(errors.length)throw new Error(errors.map(String).join('; '))
    },
  })
  if (recovered) history.finishRecovery()
  const guardedHandle = (name: string, fn: (...args: any[]) => unknown) => ipcMain.handle(name, (...args) => history.access(() => fn(...args)))
  ipcMain.handle('history:state', () => history.info())
  ipcMain.handle('history:preview', () => history.preview())
  ipcMain.handle('history:clear', (_e, input: HistoryClear) => history.clear(input))
  history.onChange(() => { if(win && !win.isDestroyed())win.webContents.send('history:reset') })

  const commands = {
    studioInfo: () => studio.info(),
    studioUpdate: (input: StudioChange) => studio.update(input),
    basicModifiers: (input: ModifierConfig) => basic.configureModifiers(input),
    basicCatalog: () => basic.catalog(),
    basicPlan: (input: BasicInput) => basic.plan(input),
    basicSave: (input: BasicPreset) => basic.save(input),
    basicDelete: (input: { id: string; version: number }) => basic.remove(input),
    directorInfo: () => director.info(),
    directorConfigure: (config: DirectorConfig) => director.configure(config),
    directorStart: (input: DirectorStart) => director.start({ ...input, turn: validateTurn(input.turn, allAdapters().map(toInfo)) }),
    directorStatus: (id: string) => director.status(id),
  }
  for (const [name, command] of Object.entries(commands)) {
    const channel = name.replace(/[A-Z]/, letter => ':'+letter.toLowerCase())
    guardedHandle(channel, (_event, arg) => (command as (input:unknown)=>unknown)(arg))
  }
  studio.onChange(() => { if (win && !win.isDestroyed()) win.webContents.send('studio:update') })
  basic.onChange(() => { if (win && !win.isDestroyed()) win.webContents.send('basic:update') })

  // Push every job transition to the renderer; the UI is a pure view of runner state.
  runner.onUpdate((job) => { if (win && !win.isDestroyed()) win.webContents.send('job:update', { ...job, log:'' }) })
  conversations.onChange(() => { if (win && !win.isDestroyed()) win.webContents.send('chats:update') })
  const visual = (row: { modality: string; kind?:string }) => row.kind==='director' || row.modality === 'image' || row.modality === 'video'
  const phoneJob = (job: Job): Job => visual(job) ? {...job, log:'',text:undefined} : {
    id:job.id, modality:job.modality, adapterId:'desktop-only', adapterLabel:'Mac job', state:job.state,
    queuedAt:job.queuedAt, startedAt:job.startedAt, finishedAt:job.finishedAt, prompt:'',params:{},log:'',
    progress:{label:job.state==='running'?'Mac is busy':job.state==='queued'?'Waiting on Mac':'Finished on Mac'},
  }
  phone = new PhoneServer(join(app.getPath('userData'), 'phone'), join(__dirname, '../renderer'), RUNS_DIR, {
    adapters: () => allAdapters().map(toInfo),
    thumbnail,
    access: (operation) => history.access(operation),
    submit: (turn) => history.access(() => conversations.submit(turn)),
    call: (method, arg) => {
      if(method === 'historyState')return history.info()
      if(method === 'historyPreview')return history.preview()
      if(method === 'historyClear')return history.clear(arg as HistoryClear)
      return history.access<unknown>(() => {
      if (Object.hasOwn(commands,method)) return (commands[method as keyof typeof commands] as (input:unknown)=>unknown)(arg)
      switch (method) {
        case 'listAdapters': return allAdapters().filter((a) => ['image', 'video'].includes(a.modality)).map(toInfo)
        case 'availability': return availability().map(({ id, available }) => ({ id, available, reason: available ? undefined : 'Not installed on the Mac.' }))
        case 'listJobs': return runner.list().filter(j=>visual(j)||j.state==='running'||j.state==='queued').map(phoneJob)
        case 'listChats': return conversations.list().filter((c) => ['image', 'video'].includes(c.modality))
        case 'listHistory': return listRuns().filter((r) => ['image', 'video'].includes(r.modality))
        case 'cancel': if (runner.list().some(j=>j.id===arg&&visual(j))) return runner.cancel(arg as string); throw new Error('This job is managed on the Mac.')
        case 'clearFinished': return runner.clearFinished(visual)
        case 'deleteChat': if (conversations.list().some(c=>c.id===arg&&visual(c))) return conversations.remove(arg as string); throw new Error('Choose a visual chat.')
      }
      })
    },
    subscribe: (fn) => {
      const jobs = runner.onUpdate((job) => fn('job', phoneJob(job)))
      const chats = conversations.onChange(() => fn('chats', null))
      const library = studio.onChange(() => fn('studio', null))
      const recipes = basic.onChange(() => fn('basic', null))
      const resets = history.onChange(() => fn('history-reset', null))
      return () => { jobs(); chats(); library(); recipes(); resets() }
    },
  }, process.env.LOCALLAB_SMOKE_PORT ? {address:'127.0.0.1',hostname:'localhost',port:Number(process.env.LOCALLAB_SMOKE_PORT)} : {})
  // An enabled phone service must remain reachable during idle display sleep.
  let wakeLock: number | undefined
  setInterval(() => {
    const needed = phone!.status().enabled || runner.list().some((j) => ['running', 'queued'].includes(j.state))
    if (needed && wakeLock === undefined) wakeLock = powerSaveBlocker.start('prevent-app-suspension')
    if (!needed && wakeLock !== undefined) { powerSaveBlocker.stop(wakeLock); wakeLock = undefined }
  }, 5000).unref()
  void phone.restore()
  guardedHandle('phone:status', () => phone!.status())
  guardedHandle('phone:enable', () => phone!.start())
  guardedHandle('phone:disable', () => phone!.stop())
  guardedHandle('phone:pair', () => phone!.pairing())
  guardedHandle('phone:approve', (_e, id: string, allow: boolean) => phone!.approve(id, allow))
  guardedHandle('phone:revoke', (_e, id: string) => phone!.revoke(id))
  guardedHandle('phone:certificate', () => shell.showItemInFolder(join(app.getPath('userData'), 'phone', 'Local Lab Wi-Fi.cer')))
  guardedHandle('chats:submit', (_e, turn: SubmitTurn) => conversations.submit(turn))

  guardedHandle('adapters:list', () => allAdapters().map(toInfo))
  guardedHandle('adapters:byModality', (_e, m: Modality) => byModality(m).map(toInfo))
  guardedHandle('adapters:availability', () => availability())
  guardedHandle('adapters:refresh', async () => (await refresh()).map(toInfo))

  guardedHandle('jobs:list', () => runner.list().map(job=>({...job,log:''})))
  guardedHandle('jobs:log', (_e,id:string) => runner.get(id)?.log ?? '')
  guardedHandle('jobs:run', (_e, req: RunRequest) => runner.enqueue(req))
  guardedHandle('jobs:cancel', (_e, id: string) => runner.cancel(id))
  guardedHandle('jobs:clearFinished', () => runner.clearFinished())

  guardedHandle('files:pickAudio', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'aiff'] }],
    })
    return r.canceled ? [] : r.filePaths
  })
  guardedHandle('files:pickImages', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    })
    if (r.canceled) return []
    const folder = join(RUNS_DIR, 'uploads'); mkdirSync(folder, { recursive: true })
    return r.filePaths.map((source) => {
      const target = join(folder, randomUUID() + extname(source).toLowerCase())
      copyFileSync(source, target)
      return target
    })
  })
  guardedHandle('files:save', async (_e, path: string) => {
    const source = realpathSync(path)
    if (!source.startsWith(realpathSync(RUNS_DIR) + sep) || !['.png', '.jpg', '.jpeg', '.webp', '.mp4', '.wav', '.mp3'].includes(extname(source).toLowerCase())) throw new Error('Choose media in the library.')
    const destination = await dialog.showSaveDialog({ defaultPath: 'local-lab' + extname(source) })
    if (!destination.canceled && destination.filePath && destination.filePath !== source) copyFileSync(source, destination.filePath)
  })
  guardedHandle('files:reveal', (_e, p: string) => shell.showItemInFolder(p))
  guardedHandle('history:list', () => listRuns())
  guardedHandle('history:delete', (_e, dir: string) => deleteRun(dir))
  guardedHandle('chats:list', () => conversations.list())
  guardedHandle('chats:delete', (_e, id: string) => conversations.remove(id))
  guardedHandle('files:openRuns', () => shell.openPath(RUNS_DIR))
  guardedHandle('app:runsDir', () => RUNS_DIR)
  registerCodeIpc(() => win, () => runner.list().some((j) => j.state === 'running' || j.state === 'queued'))

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
