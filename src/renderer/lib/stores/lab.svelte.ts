import type { AdapterInfo, AvailabilityReport, Chat, ChatMessage, Job, Modality, RunRecord, RunRequest } from '@shared/types'
import { lab } from '../api'

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

  async init() {
    this.adapters = await lab.listAdapters()
    const av = await lab.availability()
    this.availability = Object.fromEntries(av.map((a) => [a.id, a]))
    this.jobs = await lab.listJobs()
    this.runsDir = await lab.runsDir()

    this.chats = await lab.listChats()
    await this.refreshUnfiled()

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

  private persist(chat: Chat) {
    chat.updatedAt = Date.now()
    lab.saveChat($state.snapshot(chat) as Chat)
  }

  /** Copy a job's progress into the gen message that owns it; persist on settle. */
  private absorbJob(job: Job) {
    for (const chat of this.chats) {
      const msg = chat.messages.find((x) => x.jobId === job.id)
      if (!msg) continue
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
        this.persist(chat)
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

  async send(m: Modality) {
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
    const images = this.images[m].length ? [...this.images[m]] : ctx.carryImage ? [ctx.carryImage] : []

    const params: Record<string, Record<string, unknown>> = {}
    for (const id of ids) {
      const a = this.adapters.find((x) => x.id === id)
      if (a) params[id] = this.resolvedParams(a)
    }

    chat.messages.push({
      id: crypto.randomUUID(),
      role: 'user',
      at: Date.now(),
      text: prompt,
      contextOn: useContext,
      images: images.length ? images : undefined,
    })

    const jobs = await lab.run(
      $state.snapshot({
        adapterIds: ids,
        modality: m,
        prompt,
        params,
        images,
        history: ctx.history,
      })
    )
    for (const job of jobs) {
      chat.messages.push({
        id: crypto.randomUUID(),
        role: 'gen',
        at: Date.now(),
        jobId: job.id,
        adapterId: job.adapterId,
        adapterLabel: job.adapterLabel,
        state: job.state,
      })
    }
    this.persist(chat)
    this.prompts[m] = ''
    this.images[m] = []
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
    // Wait for acceptance before touching the active chat or model selection.
    const jobs = await lab.run($state.snapshot(request))
    if (!jobs.length) throw new Error('The video could not be queued. Please try again.')
    const now = Date.now()
    const fresh: Chat = {
      id: crypto.randomUUID(), modality: 'video', sourceImage: image,
      title: prompt.length > 48 ? prompt.slice(0, 48) + '…' : prompt,
      createdAt: now, updatedAt: now, contextOn: true,
      messages: [{ id: crypto.randomUUID(), role: 'user', at: now, text: prompt,
        contextOn: false, images: [image] }, ...jobs.map((job): ChatMessage => ({
          id: crypto.randomUUID(), role: 'gen', at: now, jobId: job.id,
          adapterId: job.adapterId, adapterLabel: job.adapterLabel, state: job.state,
        }))],
    }
    this.chats = [fresh, ...this.chats]
    this.activeChat.video = fresh.id
    this.viewingUnfiled.video = false
    this.selected.video = [adapterId]
    this.prompts.video = ''
    this.images.video = []
    this.params[adapterId] = { ...request.params[adapterId] }
    const chat = this.currentChat('video')!
    // A fast failure or progress event may have arrived during the IPC call.
    for (const job of jobs) this.absorbJob(this.jobs.find((j) => j.id === job.id) ?? job)
    this.persist(chat)
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
