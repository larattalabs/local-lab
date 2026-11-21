import { randomUUID } from 'node:crypto'
import type { Chat, Job, SubmitTurn, TurnResult } from '@shared/types'
import { listChats, saveChat, deleteChat } from './chats'

interface Queue { enqueue(req: SubmitTurn['request']): Job[]; list(): Job[]; onUpdate(fn: (job: Job) => void): unknown }

/** Only this service writes dialogue. Clients submit turns, never whole message arrays. */
export class Conversations {
  private chats = new Map<string, Chat>()
  private listeners = new Set<() => void>()
  constructor(private queue: Queue, private disk = { listChats, saveChat, deleteChat }, private resolveRequest = (turn: SubmitTurn) => turn.request) {
    for (const chat of disk.listChats()) this.chats.set(chat.id, chat)
    queue.onUpdate((job) => this.absorb(job))
  }
  resetHistory() { this.chats.clear(); this.emit() }
  list() { return structuredClone([...this.chats.values()].sort((a, b) => b.updatedAt - a.updatedAt)) }
  onChange(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  private emit() { for (const fn of this.listeners) fn() }
  private persist(chat: Chat) { this.disk.saveChat(chat) }
  submit(turn: SubmitTurn): TurnResult {
    const { chat: draft, request, turnId } = turn
    if (!/^[a-z0-9-]{1,100}$/i.test(draft.id) || !/^[a-z0-9-]{1,100}$/i.test(turnId)) throw new Error('Invalid conversation identifier.')
    let chat = this.chats.get(draft.id)
    // Retrying a lost response never launches a duplicate GPU job.
    if (chat?.messages.some((m) => m.turnId === turnId)) {
      const ids = new Set(chat.messages.filter((m) => m.turnId === turnId).map((m) => m.jobId))
      return structuredClone({ chat, jobs: this.queue.list().filter((j) => ids.has(j.id)) })
    }
    if (chat && (chat.revision ?? 0) !== (draft.revision ?? 0)) {
      throw new Error('This chat changed on another device. Review the updated chat and send again.')
    }
    if (!chat && (draft.revision ?? 0) > 0) throw new Error('This chat is no longer available. Start a new chat.')
    if (request.modality !== draft.modality || (chat && chat.modality !== request.modality)) throw new Error('Conversation type mismatch.')
    const now = Date.now()
    if (!chat && draft.projectId && !/^[a-z0-9-]{1,100}$/i.test(draft.projectId)) throw new Error('Invalid project.')
    if (!chat) chat = { ...draft, projectId: draft.projectId ?? draft.id, title: draft.title.slice(0, 100), messages: [], createdAt: now, updatedAt: now }
    chat.contextOn = draft.contextOn
    const resolved = this.resolveRequest(turn)
    const sourcePaths = new Set(request.images ?? [])
    const parentIds = sourcePaths.size ? [...this.chats.values()].flatMap(c => c.messages.filter(m => m.outputPath && sourcePaths.has(m.outputPath)).map(m => m.id)) : []
    const jobs = this.queue.enqueue({ ...resolved, parentIds })
    if (!jobs.length) throw new Error('No models accepted this request.')
    chat.messages.push({ id: randomUUID(), turnId, role: 'user', at: now, text: request.prompt,
      contextOn: turn.contextUsed, images: request.images })
    for (const job of jobs) {
      chat.messages.push({ id: randomUUID(), turnId, role: 'gen', at: now, jobId: job.id, parentIds,
        adapterId: job.adapterId, adapterLabel: job.adapterLabel, images: job.images,
        requestSnapshot: { modality: job.modality, adapterIds: [job.adapterId], params: { [job.adapterId]: job.params }, prompt: job.prompt, images: job.images, basic: job.basic } })
      this.copyJob(chat, job)
    }
    chat.revision = (chat.revision ?? 0) + 1
    chat.updatedAt = now
    this.chats.set(chat.id, chat)
    this.persist(chat)
    this.emit()
    return structuredClone({ chat, jobs })
  }
  private copyJob(chat: Chat, job: Job) {
    const msg = chat.messages.find((m) => m.jobId === job.id)
    if (!msg) return false
    Object.assign(msg, { originalPrompt:job.originalPrompt, effectivePrompt: job.prompt, director: job.director, state: job.state, runDir: job.runDir, outputPath: job.outputPath,
      details: job.details, textOut: job.text, error: job.error,
      durationMs: job.startedAt && job.finishedAt ? job.finishedAt - job.startedAt : undefined,
      seed: job.params.seed == null ? undefined : String(job.params.seed) })
    return true
  }
  private absorb(job: Job) {
    for (const chat of this.chats.values()) {
      if (!this.copyJob(chat, job)) continue
      if (['done', 'error', 'cancelled'].includes(job.state)) {
        chat.updatedAt = Date.now()
        this.persist(chat)
        this.emit()
      }
      break
    }
  }
  remove(id: string) { this.disk.deleteChat(id); this.chats.delete(id); this.emit() }
}
