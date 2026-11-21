import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import {
  ALL_OMP_TOOLS, DEFAULT_CODE_SETTINGS, reduceCode,
  type CodeAgent, type CodeApprovalMode, type CodeAttachment, type CodeBackend, type CodeCatalogEntry, type CodeChangedFile,
  type CodeChanges, type CodeCheckResult, type CodeCommand, type CodeDelivery, type CodeDiscovered, type CodeEvent,
  type CodeModel, type CodeNewSession, type CodePush, type CodeServerSettings, type CodeSession, type CodeSettings,
  type CodeStatus, type CodeThinking, type CodeTranscript,
} from '@shared/code'
import { RUNS_DIR } from '../env'
import {
  BACKEND_LABEL, BACKENDS, BackendManager, checkToolCalls, codeModels, discoverModels, readServerSettings,
  removeFromCatalog, setOmlxContext, upsertCatalog,
} from './catalog'
import { syncOmpContextWindow } from './omp-config'

const run = promisify(execFile)
const THINKING: CodeThinking[] = ['default', 'on', 'off', 'low', 'medium', 'high']
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

/**
 * DwarfStar servers hold 86-93 GB and, unlike oMLX (300 s idle unload) or
 * Ollama (keep_alive), never release it on their own. The Text tab's V4.1
 * worker stops its server after every job for the same reason; here a whole
 * agent session reuses the loaded model, so it is stopped after this much idle
 * time instead — before an image job or a terminal omp can load on top of it.
 */
const IDLE_UNLOAD_OVERRIDE_MS = process.env.LOCALLAB_CODE_IDLE_UNLOAD_MS ? Number(process.env.LOCALLAB_CODE_IDLE_UNLOAD_MS) : undefined
const RESIDENT: CodeBackend[] = ['ds4', 'ds4-ablit', 'ds4-v41']
import type { Driver } from './driver'
import { OmpDriver, ompAvailable } from './omp'
import { OpencodeDriver, opencodeAvailable, opencodeServer } from './opencode'

/**
 * Code tab state in the main process: the session index, each session's
 * reduced transcript (persisted after every event batch), and one live driver
 * per open session. The renderer is a view; it gets every event pushed and can
 * ask for the full transcript on (re)open.
 */
export class CodeService {
  private dir: string
  private sessions: CodeSession[] = []
  private transcripts = new Map<string, CodeTranscript>()
  private drivers = new Map<string, Driver>()
  private status = new Map<string, CodeStatus>()
  private backends = new BackendManager()
  private listeners = new Set<(p: CodePush | null) => void>()
  private saveTimers = new Map<string, NodeJS.Timeout>()
  private models?: Promise<CodeModel[]>
  private idleTimer?: NodeJS.Timeout
  private settingsCache: CodeSettings
  private uploads: string

  constructor(userData: string, private jobsBusy: () => boolean, uploads = join(RUNS_DIR, 'uploads')) {
    this.dir = join(userData, 'code')
    this.uploads = uploads
    mkdirSync(this.dir, { recursive: true })
    this.settingsCache = this.loadSettings()
    try { this.sessions = JSON.parse(readFileSync(join(this.dir, 'sessions.json'), 'utf8')) } catch { this.sessions = [] }
  }

  /** `null` means the session list changed. */
  onPush(fn: (p: CodePush | null) => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  private push(p: CodePush | null) { for (const l of this.listeners) l(p) }

  private writeJson(path: string, value: unknown) {
    const tmp = path + '.tmp'
    writeFileSync(tmp, JSON.stringify(value))
    renameSync(tmp, path)
  }

  private saveIndex() { this.writeJson(join(this.dir, 'sessions.json'), this.sessions) }

  private transcript(id: string): CodeTranscript {
    let t = this.transcripts.get(id)
    if (!t) {
      try { t = JSON.parse(readFileSync(join(this.dir, `${id}.json`), 'utf8')) as CodeTranscript } catch { t = { items: [] } }
      this.transcripts.set(id, t)
    }
    return t
  }

  private flush(id: string) {
    clearTimeout(this.saveTimers.get(id))
    this.saveTimers.delete(id)
    const t = this.transcripts.get(id)
    if (!t || !this.sessions.some((s) => s.id === id)) return
    try { this.writeJson(join(this.dir, `${id}.json`), t) } catch (e) { console.error('[code] could not save transcript', id, e) }
  }

  private scheduleSave(id: string) {
    if (this.saveTimers.has(id)) return
    this.saveTimers.set(id, setTimeout(() => this.flush(id), 400))
  }

  private loadSettings(): CodeSettings {
    try { return { ...DEFAULT_CODE_SETTINGS, ...JSON.parse(readFileSync(join(this.dir, 'settings.json'), 'utf8')) } } catch { return { ...DEFAULT_CODE_SETTINGS } }
  }

  settings(): CodeSettings { return this.settingsCache }

  saveSettings(input: Partial<CodeSettings>): CodeSettings {
    const next = { ...this.settingsCache }
    if (Array.isArray(input.ompTools)) {
      const tools = input.ompTools.map(String).filter((t) => ALL_OMP_TOOLS.includes(t))
      if (!tools.length) throw new Error('Keep at least one omp tool.')
      next.ompTools = [...new Set(tools)]
    }
    if (typeof input.appendSystemPrompt === 'string') next.appendSystemPrompt = input.appendSystemPrompt.slice(0, 8000)
    if (typeof input.idleUnloadMinutes === 'number' && Number.isFinite(input.idleUnloadMinutes)) {
      next.idleUnloadMinutes = Math.min(240, Math.max(0, Math.round(input.idleUnloadMinutes)))
    }
    this.settingsCache = next
    this.writeJson(join(this.dir, 'settings.json'), next)
    // Running omp processes keep their launch flags until they restart; idle ones restart now.
    for (const [id, d] of this.drivers) if (!d.running) { d.dispose(); this.drivers.delete(id) }
    this.scheduleIdleUnload()
    return next
  }

  private scheduleIdleUnload() {
    clearTimeout(this.idleTimer)
    const ms = IDLE_UNLOAD_OVERRIDE_MS ?? this.settingsCache.idleUnloadMinutes * 60_000
    if (!ms) return
    this.idleTimer = setTimeout(() => {
      const b = this.backends.current
      if (!b || !RESIDENT.includes(b) || [...this.drivers.values()].some((d) => d.running)) return
      this.backends.stop(b).catch((e) => console.error('[code] idle unload failed', e))
    }, ms)
    this.idleTimer.unref?.()
  }

  private emit(id: string, event: CodeEvent) {
    if (event.type === 'turn-end') this.scheduleIdleUnload()
    if (event.type === 'status') this.status.set(id, event.status)
    else {
      this.transcripts.set(id, reduceCode(this.transcript(id), event))
      this.scheduleSave(id)
    }
    this.push({ sessionId: id, event })
  }

  async catalog(): Promise<{ models: CodeModel[]; harnesses: { omp: boolean; opencode: boolean } }> {
    this.models ??= codeModels()
    const models = await this.models.catch(() => { this.models = undefined; return [] as CodeModel[] })
    return { models, harnesses: { omp: ompAvailable(), opencode: opencodeAvailable() } }
  }

  async refreshCatalog() { this.models = undefined; return this.catalog() }

  backendState() { return this.backends.state() }

  list(): (CodeSession & { status: CodeStatus })[] {
    return this.sessions
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => ({ ...s, status: this.status.get(s.id) ?? { state: 'idle' } }))
  }

  open(id: string): { session: CodeSession; transcript: CodeTranscript; status: CodeStatus } {
    const session = this.get(id)
    return { session, transcript: this.transcript(id), status: this.status.get(id) ?? { state: 'idle' } }
  }

  private get(id: string): CodeSession {
    const s = this.sessions.find((x) => x.id === id)
    if (!s) throw new Error('That Code session no longer exists.')
    return s
  }

  private async model(id: string): Promise<CodeModel> {
    const m = (await this.catalog()).models.find((x) => x.id === id)
    if (!m) throw new Error(`Model ${id} is not in the Code catalog.`)
    return m
  }

  async create(input: CodeNewSession): Promise<CodeSession> {
    const cwd = resolve(String(input.cwd ?? ''))
    if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error('Choose an existing folder.')
    if (!['omp', 'opencode'].includes(input.harness)) throw new Error('Unknown harness.')
    if (!['ask', 'edit', 'auto'].includes(input.mode)) throw new Error('Unknown approval mode.')
    await this.model(input.modelId)
    const now = Date.now()
    const s: CodeSession = {
      id: randomUUID(), title: cwd.split('/').pop() || cwd, cwd, harness: input.harness, modelId: input.modelId,
      mode: input.mode, leanTools: input.leanTools ?? true, createdAt: now, updatedAt: now,
      ...(input.thinking && THINKING.includes(input.thinking) ? { thinking: input.thinking } : {}),
      ...(input.agent ? { agent: String(input.agent).slice(0, 40) } : {}),
    }
    this.sessions.push(s)
    this.saveIndex()
    this.push(null)
    return s
  }

  private touch(s: CodeSession, patch: Partial<CodeSession> = {}) {
    Object.assign(s, patch, { updatedAt: Date.now() })
    this.saveIndex()
    this.push(null)
  }

  /** The backend another running session depends on, if any. */
  private busyBackend(except: string): CodeBackend | undefined {
    for (const [id, d] of this.drivers) {
      if (id === except || !d.running) continue
      const s = this.sessions.find((x) => x.id === id)
      if (s) return s.modelId.split('/')[0] as CodeBackend
    }
    return undefined
  }

  private async driver(s: CodeSession): Promise<Driver> {
    let d = this.drivers.get(s.id)
    if (d) return d
    const host = {
      session: s,
      model: await this.model(s.modelId),
      emit: (ev: CodeEvent) => this.emit(s.id, ev),
      setRef: (ref: string) => { if (s.harnessRef !== ref) this.touch(s, { harnessRef: ref }) },
      settings: () => this.settingsCache,
      othersRunning: () => [...this.drivers].some(([other, x]) => other !== s.id && x.running),
    }
    d = s.harness === 'omp' ? new OmpDriver(host) : new OpencodeDriver(host, async () => (await this.catalog()).models)
    this.drivers.set(s.id, d)
    return d
  }

  /** Attachments must be images the app saved under its uploads folder. */
  private attachments(paths: unknown): CodeAttachment[] {
    if (!Array.isArray(paths) || !paths.length) return []
    mkdirSync(this.uploads, { recursive: true })
    const root = realpathSync(this.uploads)
    return paths.slice(0, 8).map((p) => {
      const real = realpathSync(String(p))
      const mime = IMAGE_TYPES[extname(real).toLowerCase()]
      if (!real.startsWith(root + sep) || !mime) throw new Error('Attach PNG, JPEG or WebP images.')
      return { path: real, mime }
    })
  }

  /** Save a pasted or dropped image (base64) into the uploads folder. */
  saveImage(base64: string, mime: string): string {
    const ext = ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' } as Record<string, string>)[mime]
    if (!ext) throw new Error('Paste a PNG, JPEG or WebP image.')
    const data = Buffer.from(String(base64), 'base64')
    if (!data.length || data.length > 20 * 1024 * 1024) throw new Error('Images must be under 20 MB.')
    mkdirSync(this.uploads, { recursive: true })
    const path = join(this.uploads, randomUUID() + ext)
    writeFileSync(path, data, { mode: 0o600 })
    return path
  }

  /**
   * What the harness receives. Attached images travel inline with the message,
   * but agents otherwise go hunting the disk for "the attached image" (seen
   * live: a model searched ~/Pictures), so say so explicitly.
   */
  private forAgent(msg: string, images: CodeAttachment[]): string {
    if (!images.length) return msg
    const n = images.length === 1 ? 'An image is' : `${images.length} images are`
    return `${msg}\n\n(${n} attached to this message and shown to you inline. There is no file on disk to look for.)`
  }

  async send(id: string, text: string, imagePaths: unknown = [], delivery?: CodeDelivery): Promise<void> {
    const s = this.get(id)
    const msg = String(text ?? '').trim()
    if (!msg) return
    const images = this.attachments(imagePaths)
    if (images.length && !(await this.model(s.modelId)).vision) throw new Error('This model cannot see images. Pick a vision model or remove the attachments.')
    const live = this.drivers.get(id)
    if (live?.running) {
      // Typed while the agent works: queue for after this turn, or steer it now.
      const how: CodeDelivery = delivery === 'steer' ? 'steer' : 'queue'
      this.emit(id, { type: 'user', text: msg, images: images.map((a) => a.path), delivery: how })
      await live.prompt({ text: this.forAgent(msg, images), images, delivery: how })
      return
    }
    if (this.jobsBusy()) throw new Error('A Local Lab job is running. Wait for it to finish before loading a text model, so the two do not compete for memory.')
    const model = await this.model(s.modelId)
    clearTimeout(this.idleTimer)
    if (s.title === s.cwd.split('/').pop() && !this.transcript(id).items.length) s.title = msg.split('\n')[0].slice(0, 60)
    this.touch(s)
    this.emit(id, { type: 'user', text: msg, images: images.map((a) => a.path) })
    try {
      this.emit(id, { type: 'status', status: { state: 'backend', detail: 'Preparing model server…' } })
      await this.backends.ensure(model.backend, (line) => this.emit(id, { type: 'status', status: { state: 'backend', detail: line } }), this.busyBackend(id))
      const d = await this.driver(s)
      await d.prompt({ text: this.forAgent(msg, images), images })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.emit(id, { type: 'notice', level: 'error', text: message })
      this.emit(id, { type: 'status', status: { state: 'error', detail: message } })
      this.emit(id, { type: 'turn-end' })
    }
  }

  async stop(id: string) { await this.drivers.get(id)?.abort() }

  /** Model servers panel: stop one server (Ollama: unload its models). */
  async stopBackend(b: CodeBackend) {
    if (!Object.hasOwn(BACKEND_LABEL, b)) throw new Error('Unknown model server.')
    const busy = this.busyBackend('')
    if (busy === b) throw new Error(`A Code session is running on ${BACKEND_LABEL[b]}. Stop it first.`)
    await this.backends.stop(b)
  }

  async answer(id: string, approvalId: string, approve: boolean) {
    await this.drivers.get(id)?.answer(String(approvalId), !!approve)
  }

  async configure(id: string, patch: { modelId?: string; mode?: CodeApprovalMode; leanTools?: boolean; title?: string; thinking?: CodeThinking; agent?: string }) {
    const s = this.get(id)
    const d = this.drivers.get(id)
    const onlyTitle = Object.keys(patch).every((k) => k === 'title')
    if (d?.running && !onlyTitle) throw new Error('Wait for the current turn to finish first.')
    if (patch.thinking && patch.thinking !== s.thinking) {
      if (!THINKING.includes(patch.thinking)) throw new Error('Unknown thinking level.')
      s.thinking = patch.thinking
      await d?.setThinking(patch.thinking).catch(() => {})
    }
    if (patch.agent && patch.agent !== s.agent) {
      s.agent = String(patch.agent).slice(0, 40)
      await d?.setAgent(s.agent).catch(() => {})
    }
    if (patch.modelId && patch.modelId !== s.modelId) {
      const m = await this.model(patch.modelId)
      s.modelId = m.id
      await d?.setModel(m).catch(() => {})
    }
    if (patch.mode && patch.mode !== s.mode) {
      if (!['ask', 'edit', 'auto'].includes(patch.mode)) throw new Error('Unknown approval mode.')
      s.mode = patch.mode
    }
    if (typeof patch.leanTools === 'boolean') s.leanTools = patch.leanTools
    if (typeof patch.title === 'string' && patch.title.trim()) s.title = patch.title.trim().slice(0, 80)
    // omp takes approval mode and tool set as launch flags: restart it on the
    // next prompt (it resumes the same session file). opencode re-applies
    // permissions when the session is reattached.
    if (d && (patch.mode || typeof patch.leanTools === 'boolean')) { d.dispose(); this.drivers.delete(id) }
    this.touch(s)
    return s
  }

  async compact(id: string) {
    const s = this.get(id)
    const model = await this.model(s.modelId)
    if (this.jobsBusy()) throw new Error('A Local Lab job is running; compacting needs the model loaded.')
    await this.backends.ensure(model.backend, (line) => this.emit(id, { type: 'status', status: { state: 'backend', detail: line } }), this.busyBackend(id))
    try {
      await (await this.driver(s)).compact()
    } finally {
      this.emit(id, { type: 'status', status: { state: 'idle' } })
    }
  }

  async commands(id: string): Promise<CodeCommand[]> {
    const s = this.get(id)
    // Listing commands never needs the model, only the harness.
    return (await this.driver(s)).commands()
  }

  async agents(): Promise<CodeAgent[]> {
    await opencodeServer.ensure((await this.catalog()).models, this.settingsCache, () => [...this.drivers.values()].some((d) => d.running))
    return opencodeServer.agents()
  }

  /** The session folder's uncommitted changes (git), harness-independent. */
  async changes(id: string): Promise<CodeChanges> {
    const cwd = this.get(id).cwd
    const git = async (...args: string[]) => (await run('/usr/bin/git', ['-C', cwd, ...args], { maxBuffer: 16 * 1024 * 1024, timeout: 15_000 })).stdout
    try { await git('rev-parse', '--is-inside-work-tree') } catch { return { repo: false, files: [] } }
    try {
      const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD').catch(() => '')).trim() || undefined
      const hasHead = await git('rev-parse', '--verify', 'HEAD').then(() => true, () => false)
      const base = hasHead ? 'HEAD' : '4b825dc642cb6eb9a060e54bf8d69288fbee4904' // empty tree
      const files = new Map<string, CodeChangedFile>()
      for (const line of (await git('diff', '--numstat', base, '--', '.')).split('\n')) {
        const m = line.match(/^(\S+)\t(\S+)\t(.+)$/)
        if (m) files.set(m[3], { path: m[3], status: 'modified', additions: Number(m[1]) || 0, deletions: Number(m[2]) || 0, patch: '' })
      }
      const patch = await git('diff', '--no-color', base, '--', '.')
      for (const chunk of patch.split(/^(?=diff --git )/m)) {
        const m = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m)
        const f = m && files.get(m[2])
        if (!f) continue
        f.patch = chunk.length > 60_000 ? chunk.slice(0, 60_000) + '\n…(diff truncated)' : chunk
        if (/^new file mode/m.test(chunk)) f.status = 'added'
        else if (/^deleted file mode/m.test(chunk)) f.status = 'deleted'
      }
      // Untracked files, shown as additions (text only, capped).
      for (const rel of (await git('ls-files', '--others', '--exclude-standard', '--', '.')).split('\n').filter(Boolean).slice(0, 100)) {
        const path = join(cwd, rel)
        let body = ''
        try { body = statSync(path).size > 200_000 ? '' : readFileSync(path, 'utf8') } catch { /* unreadable */ }
        const lines = body.includes('\u0000') ? [] : body.split('\n')
        if (lines.at(-1) === '') lines.pop()
        files.set(rel, { path: rel, status: 'untracked', additions: lines.length, deletions: 0,
          patch: `--- /dev/null\n+++ b/${rel}\n` + lines.slice(0, 400).map((l) => '+' + l).join('\n') + (lines.length > 400 ? '\n…(truncated)' : '') })
      }
      return { repo: true, branch, files: [...files.values()].slice(0, 300) }
    } catch (e) {
      return { repo: true, files: [], error: e instanceof Error ? e.message : String(e) }
    }
  }

  // ---- Settings: model catalog and servers -------------------------------------------------

  async discover(): Promise<CodeDiscovered[]> { return discoverModels() }

  /** Bring the model's server up and run the tool-call admission check. */
  async checkModel(backend: CodeBackend, model: string, onStatus: (line: string) => void): Promise<CodeCheckResult> {
    if (!BACKENDS.includes(backend)) throw new Error('Unknown model server.')
    if (this.jobsBusy()) throw new Error('A Local Lab job is running. Check models when it has finished.')
    if ([...this.drivers.values()].some((d) => d.running)) throw new Error('A Code session is running. Check models when it has finished.')
    await this.backends.ensure(backend, onStatus)
    onStatus(`Asking ${model} to call a tool…`)
    const result = await checkToolCalls(backend, String(model))
    this.scheduleIdleUnload()
    return result
  }

  async saveModel(entry: CodeCatalogEntry) {
    upsertCatalog(entry)
    if (entry.backend === 'omlx' && entry.contextWindow) syncOmpContextWindow(entry.model, entry.contextWindow)
    return this.refreshCatalog()
  }

  async removeModel(id: string) {
    removeFromCatalog(String(id))
    return this.refreshCatalog()
  }

  serverSettings(): CodeServerSettings { return readServerSettings() }

  /** Change one oMLX model's context cap; restarts oMLX (when idle) so it applies. */
  async setOmlxContext(model: string, maxContext: number | null): Promise<CodeServerSettings> {
    if (this.busyBackend('') === 'omlx') throw new Error('A Code session is running on oMLX. Try again when it has finished.')
    setOmlxContext(String(model), maxContext)
    const state = await this.backends.state()
    if (state.up.includes('omlx')) await this.backends.stop('omlx')
    // Keep the catalog and omp's view of the window in step with the server.
    const native = readServerSettings().omlx.find((m) => m.model === model)?.native
    const effective = maxContext ?? native
    const entry = (await this.catalog()).models.find((m) => m.backend === 'omlx' && m.model === model)
    if (effective) {
      if (entry) upsertCatalog({ ...entry, contextWindow: effective })
      syncOmpContextWindow(model, effective)
      await this.refreshCatalog()
    }
    return readServerSettings()
  }

  remove(id: string) {
    this.drivers.get(id)?.dispose()
    this.drivers.delete(id)
    clearTimeout(this.saveTimers.get(id))
    this.saveTimers.delete(id)
    this.sessions = this.sessions.filter((s) => s.id !== id)
    this.transcripts.delete(id)
    rmSync(join(this.dir, `${id}.json`), { force: true })
    this.saveIndex()
    this.push(null)
  }

  shutdown() {
    clearTimeout(this.idleTimer)
    for (const id of [...this.saveTimers.keys()]) this.flush(id)
    const b = this.backends.current
    if (b && RESIDENT.includes(b)) this.backends.stopDetached(b)
    for (const d of this.drivers.values()) d.dispose()
    this.drivers.clear()
    opencodeServer.stop()
  }
}
