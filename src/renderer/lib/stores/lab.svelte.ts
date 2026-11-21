import type { AdapterInfo, AvailabilityReport, Chat, ChatMessage, Job, Modality, RunRecord, RunRequest, SubmitTurn } from '@shared/types'
import { studioProjects } from '@shared/studio'
import { lab } from '../api'
import { directorFlow } from './director.svelte'

/**
 * One store, because there is genuinely one piece of state: what models exist,
 * what jobs are running, and which models the user has selected per section.
 * Selections are kept per-modality so switching tabs doesn't lose your setup.
 */
class LabStore {
  adapters = $state<AdapterInfo[]>([])
  availability = $state<Record<string, AvailabilityReport>>({})
  jobs = $state<Job[]>([])
  runsDir = $state('')

  /** modality -> selected adapter ids */
  selected = $state<Record<Modality, string[]>>({ image: [], video: [], music: [], text: [] })
  /** modality -> prompt text */
  prompts = $state<Record<Modality, string>>({ image: '', video: '', music: '', text: '' })
  /** adapterId -> param overrides */
  params = $state<Record<string, Record<string, unknown>>>({})
  /** A chosen earlier result is a one-turn edit input, scoped to its image chat. */
  imageEditSources = $state<Record<string, string>>({})
  private imageEditRevisions: Record<string, number> = {}
  private pendingImageEdits: Record<string, { source: string; revision: number; jobIds: string[] }> = {}
  /** Reference inputs stay with their tab, so another draft cannot leak into a handoff. */
  images = $state<Record<Modality, string[]>>({ image: [], video: [], music: [], text: [] })

  /** every conversation, all modalities; sidebar filters per tab */
  chats = $state<Chat[]>([])
  /** modality -> active chat id (null = a fresh, not-yet-created chat) */
  activeChat = $state<Record<Modality, string | null>>({ image: null, video: null, music: null, text: null })
  /** runs from before chats existed (or whose chat was deleted) */
  unfiled = $state<RunRecord[]>([])
  /** modality -> viewing the read-only unfiled-runs log instead of a chat */
  viewingUnfiled = $state<Record<Modality, boolean>>({ image: false, video: false, music: false, text: false })
  /** context default carried into the next NEW chat, per modality */
  contextDraft = $state<Record<Modality, boolean>>({ image: true, video: true, music: true, text: true })

  private inFlight = new Set<Modality>()
  private retryTurns = new Map<string, { intent: string; turn: SubmitTurn }>()
  private animationRetry?: { intent: string; turn: SubmitTurn }
  private refreshSequence = 0
  async refreshChats() {
    const seq = ++this.refreshSequence
    const chats = await lab.listChats()
    if (seq === this.refreshSequence) this.chats = chats
  }
  private initialized = false
  async init() {
    if (this.initialized) return this.resync()
    this.adapters = await lab.listAdapters()
    void directorFlow.init().catch(() => {})
    try {
      const preferences = JSON.parse(localStorage.getItem('lab-preferences') ?? '{}')
      if (preferences.selected) this.selected = { ...this.selected, ...preferences.selected }
      if (preferences.params) this.params = preferences.params
      if (preferences.prompts) this.prompts = { ...this.prompts, ...preferences.prompts }
      if (preferences.images) this.images = { ...this.images, ...preferences.images }
      if (preferences.contextDraft) this.contextDraft = { ...this.contextDraft, ...preferences.contextDraft }
      if (preferences.imageEditSources) this.imageEditSources = preferences.imageEditSources
      if (preferences.activeChat) this.activeChat = { ...this.activeChat, ...preferences.activeChat }
    } catch { /* a damaged preference must not hide chats */ }
    const av = await lab.availability()
    this.availability = Object.fromEntries(av.map((a) => [a.id, a]))
    this.jobs = await lab.listJobs()
    this.runsDir = await lab.runsDir()

    this.chats = await lab.listChats()
    await this.refreshUnfiled()
    this.initialized = true
    if (lab.refreshAdapters) void lab.refreshAdapters().then(async (adapters) => {
      const reports = await lab.availability()
      this.adapters = adapters
      this.availability = Object.fromEntries(reports.map(a => [a.id, a]))
    }).catch(() => {})
    lab.onChatsUpdate(() => { void this.refreshChats().catch(() => {}) })
    lab.onSync?.(() => { void this.resync().catch(() => {}) })

    lab.onJobUpdate((job) => {
      const i = this.jobs.findIndex((j) => j.id === job.id)
      if (i >= 0) this.jobs[i] = job
      else this.jobs = [job, ...this.jobs]
      this.absorbJob(job)
    })
  }

  /** Runs not referenced by any chat — pre-chat history and orphans of deleted chats. */
  async refreshUnfiled() {
    const runs = await lab.listHistory()
    const filed = new Set(
      this.chats.flatMap((c) => c.messages.map((m) => m.runDir).filter(Boolean))
    )
    this.unfiled = runs.filter((r) => !filed.has(r.dir))
  }

  chatsFor(m: Modality): Chat[] {
    return this.chats.filter((c) => c.modality === m)
  }

  currentChat(m: Modality): Chat | undefined {
    const id = this.activeChat[m]
    return id ? this.chats.find((c) => c.id === id) : undefined
  }

  newChat(m: Modality) {
    this.viewingUnfiled[m] = false
    this.activeChat[m] = null
  }

  openChat(m: Modality, id: string) {
    this.viewingUnfiled[m] = false
    this.activeChat[m] = id
  }

  async removeChat(m: Modality, id: string) {
    await lab.deleteChat(id)
    this.chats = this.chats.filter((c) => c.id !== id)
    if (this.activeChat[m] === id) this.activeChat[m] = null
    // Its runs go back to being unfiled rather than disappearing.
    await this.refreshUnfiled()
  }

  async resync() {
    this.jobs = await lab.listJobs()
    await this.refreshChats()
    for (const job of this.jobs) this.absorbJob(job)
    await this.refreshUnfiled()
  }

  /** Copy a job's progress into the gen message that owns it; persist on settle. */
  private absorbJob(job: Job) {
    for (const chat of this.chats) {
      const msg = chat.messages.find((x) => x.jobId === job.id)
      if (!msg) continue
      if (job.modality !== 'text' && msg.state === 'running' && job.state === 'running') return
      msg.effectivePrompt = job.prompt
      msg.director = job.director
      msg.state = job.state
      msg.runDir = job.runDir
      if (job.state === 'done') {
        msg.outputPath = job.outputPath
        msg.textOut = job.text
      }
      if (job.state === 'error') msg.error = job.error
      if (job.startedAt && job.finishedAt) msg.durationMs = job.finishedAt - job.startedAt
      const seed = job.params?.seed
      if (seed != null && seed !== '') msg.seed = String(seed)
      if (job.state === 'done' || job.state === 'error' || job.state === 'cancelled') {
        const pending = this.pendingImageEdits[chat.id]
        if (pending?.jobIds.includes(job.id)) {
          const states = pending.jobIds.map((id) => chat.messages.find((m) => m.jobId === id)?.state)
          if (states.every((state) => state === 'done' || state === 'error' || state === 'cancelled')) {
            if (states.every((state) => state === 'done')
              && this.imageEditSources[chat.id] === pending.source
              && this.imageEditRevisions[chat.id] === pending.revision) {
              this.clearImageEditSource(chat.id)
            }
            delete this.pendingImageEdits[chat.id]
          }
        }
      }
      return
    }
  }

  /** What "context on" means, per modality — see the design note in ChatView. */
  private contextFor(chat: Chat, m: Modality, adapterIds: string[]):
    { history?: { role: 'user' | 'assistant'; content: string }[]; carryImage?: string } {
    if (m === 'text') {
      const history: { role: 'user' | 'assistant'; content: string }[] = []
      for (const msg of chat.messages) {
        if (msg.role === 'user' && msg.text) history.push({ role: 'user', content: msg.text })
        else if (msg.role === 'gen' && msg.state === 'done' && msg.textOut) {
          history.push({ role: 'assistant', content: msg.textOut })
        }
      }
      return history.length ? { history } : {}
    }
    if (m === 'image' || m === 'video') {
      // Carry the newest finished image forward as the init/reference input,
      // but only if every selected model can actually take one.
      const lastImage = [...chat.messages].reverse().find(
        (x) => x.role === 'gen' && x.state === 'done' && x.outputPath?.endsWith('.png')
      )
      const allAccept = adapterIds.every(
        (id) => this.adapters.find((a) => a.id === id)?.acceptsImages
      )
      const source = lastImage?.outputPath ?? chat.sourceImage
      if (source && allAccept) return { carryImage: source }
    }
    // Music: no conditioning mechanism yet — an honest no-op, not fake memory.
    return {}
  }

  selectImageForEdit(path: string) {
    const chat = this.currentChat('image')
    if (!chat?.messages.some((message) => message.role === 'gen' && message.state === 'done'
      && message.outputPath === path && path.endsWith('.png'))) {
      throw new Error('Choose a finished image in this chat.')
    }
    this.imageEditSources[chat.id] = path
    this.imageEditRevisions[chat.id] = (this.imageEditRevisions[chat.id] ?? 0) + 1
    this.images.image = []
  }

  clearImageEditSource(chatId = this.currentChat('image')?.id) {
    if (!chatId) return
    delete this.imageEditSources[chatId]
    this.imageEditRevisions[chatId] = (this.imageEditRevisions[chatId] ?? 0) + 1
  }

  /** Preview and submission share one plan, so image context cannot silently become text-only. */
  imageTurn() {
    const chat = this.currentChat('image')
    const previous = chat?.contextOn ? [...chat.messages].reverse().find(
      (message) => message.role === 'gen' && message.state === 'done'
        && message.outputPath?.endsWith('.png')
    )?.outputPath ?? chat.sourceImage : undefined
    const selectedImage = chat ? this.imageEditSources[chat.id] : undefined
    const sourceImage = selectedImage ?? previous
    const images = this.images.image.length ? [...this.images.image] : sourceImage ? [sourceImage] : []
    const routes = this.selected.image.filter((id) => this.isAvailable(id)).flatMap((id) => {
      const source = this.adapters.find((a) => a.id === id)
      if (!source) return []
      const target = images.length && source.imageEditAdapterId
        ? this.adapters.find((a) => a.id === source.imageEditAdapterId) : source
      return [{ source, target }]
    })
    let error = ''
    const params: Record<string, Record<string, unknown>> = {}
    for (const { source, target } of routes) {
      if (!target || !this.isAvailable(target.id)) {
        error ||= `The matching editor for ${source.label} is unavailable. Choose an installed editor or turn context off for a fresh image.`
        continue
      }
      if (images.length && !target.acceptsImages) {
        error ||= `${source.label} cannot use the previous or attached image. Choose an image editor or turn context off for a fresh image.`
        continue
      }
      if (!images.length && target.requiresImage) {
        error ||= `${target.label} needs an image. Attach one or enable context in a chat with a finished image.`
      }
      params[target.id] = this.resolvedParams(target)
      if (source.id !== target.id) {
        const sourceParams = this.resolvedParams(source)
        for (const setting of target.params) {
          if (Object.hasOwn(sourceParams, setting.key) && source.params.some((p) => p.key === setting.key)) {
            params[target.id][setting.key] = sourceParams[setting.key]
          }
        }
      }
    }
    const adapterIds = [...new Set(routes.flatMap(({ target }) => target ? [target.id] : []))]
    // A generator and its editor may both be selected; reject conflicting shared settings.
    if (adapterIds.length !== routes.length) {
      error ||= 'Choose either a generator or its matching editor, rather than both, for this edit.'
    }
    return { images, routes, adapterIds, params, error,
      fromSelection: !!selectedImage && !this.images.image.length,
      fromContext: !selectedImage && !!previous && !this.images.image.length }
  }

  async send(m: Modality) {
    if (this.inFlight.has(m)) return
    this.inFlight.add(m)
    try { return await this.sendTurn(m) } finally { this.inFlight.delete(m) }
  }
  private async sendTurn(m: Modality) {
    const ids = this.selected[m].filter((id) => this.isAvailable(id))
    const typedPrompt = this.prompts[m].trim()
    const promptOptional = ids.length > 0 && ids.every(
      (id) => this.adapters.find((a) => a.id === id)?.promptOptional
    )
    if (!ids.length || (!typedPrompt && !promptOptional)) return
    const prompt = typedPrompt || 'Upscale image'

    let chat = this.currentChat(m)
    if (!chat) {
      const fresh: Chat = {
        id: crypto.randomUUID(),
        modality: m,
        title: prompt.length > 48 ? prompt.slice(0, 48) + '…' : prompt,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        contextOn: this.contextDraft[m],
        messages: [],
      }
      this.chats = [fresh, ...this.chats]
      this.activeChat[m] = fresh.id
      this.viewingUnfiled[m] = false
      // Read the chat back THROUGH the $state proxy. Mutating the raw object
      // after it was copied into reactive state updates nothing on screen —
      // pushes land in the target silently and the log never re-renders.
      chat = this.currentChat(m)!
    }

    const useContext = chat.contextOn && chat.messages.length > 0
    const ctx = useContext ? this.contextFor(chat, m, ids) : {}
    const imageTurn = m === 'image' ? this.imageTurn() : undefined
    if (imageTurn?.error) throw new Error(imageTurn.error)
    const images = imageTurn?.images ?? (this.images[m].length ? [...this.images[m]] : ctx.carryImage ? [ctx.carryImage] : [])
    const chosenSource = imageTurn?.fromSelection
      ? { source: images[0], revision: this.imageEditRevisions[chat.id] } : undefined

    const params: Record<string, Record<string, unknown>> = {}
    for (const id of ids) {
      const a = this.adapters.find((x) => x.id === id)
      if (a) params[id] = this.resolvedParams(a)
    }

    if (imageTurn) Object.assign(params, imageTurn.params)

    const request: RunRequest = $state.snapshot({
      adapterIds: imageTurn?.adapterIds ?? ids, modality: m, prompt, params, images, history: ctx.history,
    })
    let turn: SubmitTurn = { turnId: crypto.randomUUID(),
      chat: { id: chat.id, modality: chat.modality, title: chat.title, contextOn: chat.contextOn,
        sourceImage: chat.sourceImage, revision: chat.revision }, request, contextUsed: useContext }
    const intent = JSON.stringify({ prompt, ids, params: this.params, attachments: this.images[m],
      selected: this.imageEditSources[chat.id], context: chat.contextOn })
    const retry = this.retryTurns.get(chat.id)
    if (retry?.intent === intent) turn = retry.turn
    else this.retryTurns.set(chat.id, { intent, turn: $state.snapshot(turn) })
    let result
    const directed = await directorFlow.prepare(turn)
    if (!directed) { this.retryTurns.delete(chat.id); return }
    turn = directed.turn
    this.retryTurns.set(chat.id, { intent, turn: $state.snapshot(turn) })
    try { result = 'result' in directed ? directed.result : await lab.submitTurn($state.snapshot(turn)) }
    catch (e) { if (String(e).includes('changed on another device')) this.retryTurns.delete(chat.id); await this.refreshChats().catch(() => {}); throw e }
    this.retryTurns.delete(chat.id)
    this.chats = [result.chat, ...this.chats.filter((c) => c.id !== result.chat.id)]
    chat = this.chats.find((c) => c.id === result.chat.id)!
    const jobs = result.jobs
    for (const job of jobs) if (!this.jobs.some((live) => live.id === job.id)) this.jobs = [job, ...this.jobs]
    if (chosenSource && jobs.length) {
      this.pendingImageEdits[chat.id] = { ...chosenSource, jobIds: jobs.map((job) => job.id) }
    }
    // Reconcile updates that arrived while the IPC request was being accepted.
    for (const job of jobs) this.absorbJob(this.jobs.find((live) => live.id === job.id) ?? job)
    if (this.activeChat[m] === chat.id && this.prompts[m].trim() === typedPrompt) {
      this.prompts[m] = ''
      this.images[m] = []
    }
    return result
  }

  acceptResult(result: import('@shared/types').TurnResult) {
    const m = result.chat.modality
    this.chats = [result.chat, ...this.chats.filter((c) => c.id !== result.chat.id)]
    this.activeChat[m] = result.chat.id; this.viewingUnfiled[m] = false
    for (const job of result.jobs) {
      if (!this.jobs.some((j) => j.id === job.id)) this.jobs = [job, ...this.jobs]
      this.absorbJob(this.jobs.find((j) => j.id === job.id) ?? job)
    }
  }

  /** Queue a still as a fresh video conversation without consuming another tab's draft. */
  async generateVideoFromImage(image: string, typedPrompt: string, adapterId: string,
    params: Record<string, unknown>): Promise<Chat> {
    const adapter = this.adapters.find((a) => a.id === adapterId)
    if (!adapter || adapter.modality !== 'video' || !adapter.acceptsImages || !this.isAvailable(adapterId)) {
      throw new Error('Choose an installed image-to-video model.')
    }
    const prompt = typedPrompt.trim()
    if (!image || !prompt) throw new Error('Choose a starting image and describe its motion.')
    const request: RunRequest = {
      adapterIds: [adapterId], modality: 'video', prompt,
      params: { [adapterId]: { ...this.resolvedParams(adapter), ...params } }, images: [image],
    }
    const now = Date.now()
    const fresh: Chat = {
      id: crypto.randomUUID(), modality: 'video', sourceImage: image,
      projectId: studioProjects(this.chats,[],[],{}).find(p=>p.items.some(i=>i.message.outputPath===image))?.id,
      title: prompt.length > 48 ? prompt.slice(0, 48) + '…' : prompt,
      createdAt: now, updatedAt: now, contextOn: true, messages: [],
    }
    const intent = JSON.stringify(request)
    const turn = this.animationRetry?.intent === intent ? this.animationRetry.turn
      : $state.snapshot({ turnId: crypto.randomUUID(), chat: fresh, request, contextUsed: false })
    this.animationRetry = { intent, turn }
    const directed = await directorFlow.prepare(turn)
    if (!directed) { this.animationRetry = undefined; throw new Error('Director preview closed. Your motion prompt is kept.') }
    this.animationRetry = { intent, turn: directed.turn }
    const result = 'result' in directed ? directed.result : await lab.submitTurn(directed.turn)
    this.animationRetry = undefined
    fresh.id = result.chat.id
    const jobs = result.jobs
    for (const job of jobs) if (!this.jobs.some((live) => live.id === job.id)) this.jobs = [job, ...this.jobs]
    this.chats = [result.chat, ...this.chats.filter((c) => c.id !== fresh.id)]
    this.activeChat.video = fresh.id
    this.viewingUnfiled.video = false
    this.selected.video = [adapterId]
    this.prompts.video = ''
    this.images.video = []
    this.params[adapterId] = { ...request.params[adapterId] }
    const chat = this.currentChat('video')!
    // A fast failure or progress event may have arrived during the IPC call.
    for (const job of jobs) this.absorbJob(this.jobs.find((j) => j.id === job.id) ?? job)
    return chat
  }

  forModality(m: Modality): AdapterInfo[] {
    return this.adapters.filter((a) => a.modality === m)
  }

  isAvailable(id: string): boolean {
    return this.availability[id]?.available !== false
  }

  unavailableReason(id: string): string | undefined {
    return this.availability[id]?.reason
  }

  toggle(m: Modality, id: string) {
    const cur = this.selected[m]
    this.selected[m] = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
  }

  /** Param value with the adapter's declared default as fallback. */
  param(a: AdapterInfo, key: string): unknown {
    const override = this.params[a.id]?.[key]
    if (override !== undefined) return override
    return a.params.find((p) => p.key === key)?.default ?? null
  }

  setParam(adapterId: string, key: string, value: unknown) {
    this.params[adapterId] = { ...(this.params[adapterId] ?? {}), [key]: value }
  }

  /** Every declared param, resolved — what actually gets sent to the adapter. */
  resolvedParams(a: AdapterInfo): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const p of a.params) out[p.key] = this.param(a, p.key)
    for (const p of a.params) {
      if (p.visibleWhen && out[p.visibleWhen.key] !== p.visibleWhen.value) delete out[p.key]
    }
    return out
  }

  jobsFor(m: Modality): Job[] {
    return this.jobs.filter((j) => j.modality === m)
  }

  get running(): Job | undefined {
    return this.jobs.find((j) => j.state === 'running')
  }

  get queuedCount(): number {
    return this.jobs.filter((j) => j.state === 'queued').length
  }

}

export const store = new LabStore()
