import {
  DEFAULT_CODE_SETTINGS, reduceCode,
  type CodeAgent, type CodeApprovalMode, type CodeBackend, type CodeBackendState, type CodeCatalogEntry, type CodeChanges,
  type CodeCheckResult, type CodeCommand, type CodeDelivery, type CodeDiscovered, type CodeHarness, type CodeModel,
  type CodeNewSession, type CodePush, type CodeServerSettings, type CodeSession, type CodeSettings, type CodeStatus,
  type CodeThinking, type CodeTranscript,
} from '@shared/code'

type Patch = { modelId?: string; mode?: CodeApprovalMode; leanTools?: boolean; title?: string; thinking?: CodeThinking; agent?: string }

type ListedSession = CodeSession & { status: CodeStatus }

interface CodeApi {
  catalog(): Promise<{ models: CodeModel[]; harnesses: Record<CodeHarness, boolean> }>
  refreshCatalog(): Promise<{ models: CodeModel[]; harnesses: Record<CodeHarness, boolean> }>
  backends(): Promise<CodeBackendState>
  list(): Promise<ListedSession[]>
  open(id: string): Promise<{ session: CodeSession; transcript: CodeTranscript; status: CodeStatus }>
  create(input: CodeNewSession): Promise<CodeSession>
  send(id: string, text: string, images?: string[], delivery?: CodeDelivery): Promise<void>
  saveImage(base64: string, mime: string): Promise<string>
  pickImages(): Promise<string[]>
  compact(id: string): Promise<void>
  commands(id: string): Promise<CodeCommand[]>
  agents(): Promise<CodeAgent[]>
  changes(id: string): Promise<CodeChanges>
  settings(): Promise<CodeSettings>
  saveSettings(input: Partial<CodeSettings>): Promise<CodeSettings>
  discover(): Promise<CodeDiscovered[]>
  checkModel(backend: CodeBackend, model: string): Promise<CodeCheckResult>
  saveModel(entry: CodeCatalogEntry): Promise<{ models: CodeModel[]; harnesses: Record<CodeHarness, boolean> }>
  removeModel(id: string): Promise<{ models: CodeModel[]; harnesses: Record<CodeHarness, boolean> }>
  serverSettings(): Promise<CodeServerSettings>
  setOmlxContext(model: string, ctx: number | null): Promise<CodeServerSettings>
  onCheckStatus(cb: (line: string) => void): () => void
  stop(id: string): Promise<void>
  stopBackend(backend: CodeBackend): Promise<void>
  answer(id: string, approvalId: string, approve: boolean): Promise<void>
  configure(id: string, patch: Patch): Promise<CodeSession>
  remove(id: string): Promise<void>
  pickFolder(): Promise<string | undefined>
  reveal(path: string): Promise<void>
  onEvent(cb: (p: CodePush) => void): () => void
  onSessions(cb: () => void): () => void
}

declare global { interface Window { labCode?: CodeApi } }

export const codeApi = (): CodeApi => {
  if (!window.labCode) throw new Error('The Code tab is only available in the desktop app.')
  return window.labCode
}

const PREFS = 'code-preferences'
interface Prefs { harness: CodeHarness; modelId: string; mode: CodeApprovalMode; cwd: string; leanTools: boolean; thinking: CodeThinking; agent: string }

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function loadPrefs(): Partial<Prefs> {
  try { return JSON.parse(localStorage.getItem(PREFS) ?? '{}') } catch { return {} }
}

class CodeStore {
  ready = $state(false)
  error = $state('')
  models = $state<CodeModel[]>([])
  harnesses = $state<Record<CodeHarness, boolean>>({ omp: false, opencode: false })
  sessions = $state<ListedSession[]>([])
  activeId = $state<string | null>(null)
  session = $state<CodeSession | null>(null)
  transcript = $state<CodeTranscript>({ items: [] })
  status = $state<CodeStatus>({ state: 'idle' })
  backends = $state<CodeBackendState>({ up: [] })
  /** Settings for the next new session (and the defaults remembered across launches). */
  draft = $state<Prefs>({ harness: 'omp', modelId: '', mode: 'ask', cwd: '', leanTools: true, thinking: 'default', agent: 'build' })
  sending = $state(false)
  /** Images attached to the message being written (paths under the uploads folder). */
  attachments = $state<string[]>([])
  commands = $state<CodeCommand[]>([])
  agents = $state<CodeAgent[]>([])
  settings = $state<CodeSettings>({ ...DEFAULT_CODE_SETTINGS })
  changes = $state<CodeChanges | null>(null)
  changesOpen = $state(false)
  changesLoading = $state(false)
  settingsOpen = $state(false)
  private unsubs: (() => void)[] = []

  async init() {
    if (this.ready) return
    try {
      const api = codeApi()
      const [cat, list] = await Promise.all([api.catalog(), api.list()])
      this.models = cat.models
      this.harnesses = cat.harnesses
      this.sessions = list
      const p = loadPrefs()
      const harness = p.harness && cat.harnesses[p.harness] ? p.harness : cat.harnesses.omp ? 'omp' : 'opencode'
      this.draft = {
        harness,
        modelId: cat.models.some((m) => m.id === p.modelId) ? p.modelId! : (cat.models[0]?.id ?? ''),
        mode: p.mode ?? 'ask',
        cwd: p.cwd ?? '',
        leanTools: p.leanTools ?? true,
        thinking: p.thinking ?? 'default',
        agent: p.agent ?? 'build',
      }
      void api.settings().then((x) => { this.settings = x }).catch(() => {})
      this.unsubs.push(api.onEvent((p) => this.onPush(p)))
      this.unsubs.push(api.onSessions(() => { void this.refreshList() }))
      void this.refreshBackends()
      this.ready = true
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
    }
  }

  savePrefs() {
    try { localStorage.setItem(PREFS, JSON.stringify(this.draft)) } catch { /* private mode */ }
  }

  model(id: string | undefined): CodeModel | undefined {
    return this.models.find((m) => m.id === id)
  }

  async refreshList() {
    this.sessions = await codeApi().list()
    if (this.activeId && !this.sessions.some((s) => s.id === this.activeId)) this.newSession()
    else if (this.activeId) this.session = this.sessions.find((s) => s.id === this.activeId) ?? this.session
  }

  async refreshBackends() {
    try { this.backends = await codeApi().backends() } catch { /* ignore */ }
  }

  stoppingBackend = $state<CodeBackend | null>(null)
  async stopBackend(b: CodeBackend) {
    this.stoppingBackend = b
    try { await codeApi().stopBackend(b) } catch (e) {
      this.error = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)
    } finally { this.stoppingBackend = null; await this.refreshBackends() }
  }

  async refreshCatalog() {
    const cat = await codeApi().refreshCatalog()
    this.models = cat.models
    this.harnesses = cat.harnesses
  }

  private onPush(p: CodePush) {
    const ev = p.event
    if (ev.type === 'status') {
      const s = this.sessions.find((x) => x.id === p.sessionId)
      if (s) s.status = ev.status
      if (p.sessionId === this.activeId) this.status = ev.status
      if (ev.status.state === 'idle' || ev.status.state === 'error') void this.refreshBackends()
      return
    }
    if (p.sessionId === this.activeId) {
      this.transcript = reduceCode(this.transcript, ev)
      // Files probably changed: refresh an open Changes panel after each turn.
      if (ev.type === 'turn-end' && this.changesOpen) void this.loadChanges()
    }
  }

  newSession() {
    this.activeId = null
    this.session = null
    this.transcript = { items: [] }
    this.status = { state: 'idle' }
    this.error = ''
    this.commands = []
    this.changes = null
  }

  async select(id: string) {
    const r = await codeApi().open(id)
    this.activeId = id
    this.session = r.session
    this.transcript = r.transcript
    this.status = r.status
    this.error = ''
    this.commands = []
    this.changes = null
    if (this.changesOpen) void this.loadChanges()
    void codeApi().commands(id).then((c) => { if (this.activeId === id) this.commands = c }).catch(() => {})
  }

  async pickFolder() {
    const dir = await codeApi().pickFolder()
    if (dir) { this.draft.cwd = dir; this.savePrefs() }
  }

  get busy(): boolean {
    return ['backend', 'running', 'approval'].includes(this.status.state)
  }

  async send(text: string, delivery?: CodeDelivery) {
    const msg = text.trim()
    if (!msg || this.sending) return
    this.error = ''
    this.sending = true
    const images = this.attachments.slice()
    try {
      if (this.busy && this.activeId) {
        // Mid-turn message: queued for after this turn, or steered in now.
        await codeApi().send(this.activeId, msg, images, delivery ?? 'queue')
        this.attachments = []
        return
      }
      let id = this.activeId
      if (!id) {
        if (!this.draft.cwd) throw new Error('Choose a folder for the agent to work in.')
        if (!this.draft.modelId) throw new Error('Choose a model.')
        const s = await codeApi().create({ ...$state.snapshot(this.draft) })
        this.savePrefs()
        await this.refreshList()
        await this.select(s.id)
        id = s.id
      }
      // Optimistic status so the composer locks immediately; events take over.
      this.status = { state: 'backend', detail: 'Preparing model server…' }
      this.attachments = []
      await codeApi().send(id, msg, images)
    } catch (e) {
      this.error = errText(e)
      if (!this.attachments.length) this.attachments = images
      if (this.status.state === 'backend') this.status = { state: 'idle' }
    } finally {
      this.sending = false
    }
  }

  async stop() {
    if (this.activeId) await codeApi().stop(this.activeId)
  }

  async answer(approvalId: string, approve: boolean) {
    if (!this.activeId) return
    try { await codeApi().answer(this.activeId, approvalId, approve) } catch (e) { this.error = String(e) }
  }

  async configure(patch: Patch) {
    if (!this.activeId) {
      Object.assign(this.draft, patch)
      this.savePrefs()
      return
    }
    try {
      this.session = await codeApi().configure(this.activeId, patch)
      Object.assign(this.draft, patch)
      this.savePrefs()
    } catch (e) {
      this.error = errText(e)
    }
  }

  async rename(title: string) {
    if (!this.activeId || !title.trim()) return
    await this.configure({ title: title.trim() })
    await this.refreshList()
  }

  async attachFiles(files: FileList | File[]) {
    for (const f of [...files]) {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(f.type)) { this.error = 'Attach PNG, JPEG or WebP images.'; continue }
      const buf = new Uint8Array(await f.arrayBuffer())
      let bin = ''
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
      try { this.attachments = [...this.attachments, await codeApi().saveImage(btoa(bin), f.type)] } catch (e) { this.error = errText(e) }
    }
  }

  async pickAttachments() {
    const paths = await codeApi().pickImages()
    this.attachments = [...this.attachments, ...paths].slice(0, 8)
  }

  private agentsLoading = false
  /** opencode's primary agents; loaded when an opencode session is first shown, retried until it works. */
  async loadAgents() {
    if (this.agentsLoading || this.agents.length) return
    this.agentsLoading = true
    try { this.agents = await codeApi().agents() } catch { /* server still starting; the next view retries */ }
    finally { this.agentsLoading = false }
  }

  async compact() {
    if (!this.activeId) return
    this.error = ''
    try { await codeApi().compact(this.activeId) } catch (e) { this.error = errText(e) }
  }

  async loadChanges() {
    if (!this.activeId) return
    const id = this.activeId
    this.changesLoading = true
    try { const c = await codeApi().changes(id); if (this.activeId === id) this.changes = c } catch (e) { this.error = errText(e) }
    finally { this.changesLoading = false }
  }

  async toggleChanges() {
    this.changesOpen = !this.changesOpen
    if (this.changesOpen) await this.loadChanges()
  }

  async saveSettings(patch: Partial<CodeSettings>) {
    try { this.settings = await codeApi().saveSettings(patch) } catch (e) { this.error = errText(e); throw e }
  }

  async remove(id: string) {
    await codeApi().remove(id)
    if (id === this.activeId) this.newSession()
    await this.refreshList()
  }
}

export const code = new CodeStore()
