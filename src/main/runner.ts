import { profileIssues } from './registry/profile-config'
import { parseProgress } from '@shared/studio'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomInt, randomUUID } from 'node:crypto'
import type { Job, RunRequest, Modality } from '@shared/types'
import { byId } from './registry'
import { modelEnv, RUNS_DIR } from './env'
import { writeRunRecord } from './history'

type Emit = (job: Job) => void

/**
 * Heuristic, matched against what the loaders actually print when weights are
 * absent under HF_HUB_OFFLINE. Deliberately broad — a false positive costs a
 * misleading hint appended below the real traceback, which is still visible.
 */
function looksLikeMissingWeights(log: string): boolean {
  return /PathResolution|LocalEntryNotFound|OfflineModeIsEnabled|couldn't connect|weight_loader|snapshot_download|No such file or directory.*(hub|snapshots)/i.test(
    log
  )
}

/**
 * Jobs run ONE AT A TIME, deliberately.
 *
 * This app exists to compare model A against model B, which invites firing
 * several at once — and these are 14-41GB peak models on a single machine.
 * Two large runs in parallel don't halve the wall clock, they swap and crawl,
 * or the OS kills one. Comparison needs side-by-side *display*, not
 * simultaneous *execution*, so the queue serialises and the UI shows progress.
 */
export class Runner {
  private jobs = new Map<string, Job>()
  /** Conversation turns per queued job; consumed at spawn, never on Job itself. */
  private history = new Map<string, { role: 'user' | 'assistant'; content: string }[]>()
  private queue: string[] = []
  private active: { id: string; child?: ChildProcess; controller?: AbortController } | null = null
  private work = new Map<string, (signal: AbortSignal) => Promise<string>>()
  private listeners = new Set<Emit>()
  private generationGuards = new Set<() => Promise<void>>()

  /** Release preview-only runtimes before any model process takes the GPU. */
  beforeGeneration(fn: () => Promise<void>) {
    this.generationGuards.add(fn)
    return () => this.generationGuards.delete(fn)
  }

  private emit(job: Job) { job.progress = parseProgress(job); for (const fn of this.listeners) fn(job) }

  onUpdate(fn: Emit) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.queuedAt - a.queuedAt)
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id)
  }

  enqueueWork(id: string, label: string, work: (signal: AbortSignal) => Promise<string>): Job {
    if (this.jobs.has(id)) throw new Error('This queue identifier is already in use.')
    const job: Job = { id, kind: 'director', adapterId: 'prompt-director', adapterLabel: label,
      modality: 'text', prompt: '', params: {}, state: 'queued', queuedAt: Date.now(), log: '' }
    this.jobs.set(id, job); this.work.set(id, work); this.queue.push(id); this.emit(job); this.pump()
    return job
  }

  /** Fan one prompt out across N models. Returns the created jobs in order. */
  enqueue(req: RunRequest): Job[] {
    const created: Job[] = []
    for (const adapterId of req.adapterIds) {
      const adapter = byId(adapterId)
      if (!adapter) continue
      const params = { ...req.params[adapterId] }
      if (adapter.params?.some(p => p.type === 'seed') && (params.seed === '' || params.seed == null || Number(params.seed) === -1)) {
        const fallback = adapter.params.find(p => p.type === 'seed')?.default
        params.seed = params.seed === undefined && typeof fallback === 'number' && fallback >= 0 ? fallback : randomInt(2 ** 32)
      }
      const job: Job = {
        id: randomUUID(),
        adapterId,
        basic: req.basic, parentIds:req.parentIds,
        adapterLabel: adapter.label,
        modality: req.modality as Modality,
        prompt: req.directedPrompts?.[adapterId] ?? req.prompt,
        originalPrompt: req.basic?.originalPrompt ?? (req.directorRecords?.[adapterId] ? req.prompt : undefined),
        director: req.directorRecords?.[adapterId],
        params,
        images: req.images ?? [],
        state: 'queued',
        queuedAt: Date.now(),
        log: '',
      }
      if (req.history?.length) this.history.set(job.id, req.history)
      this.jobs.set(job.id, job)
      this.queue.push(job.id)
      created.push(job)
      this.emit(job)
    }
    this.pump()
    return created
  }

  cancel(id: string) {
    const job = this.jobs.get(id)
    if (!job) return
    if (this.active?.id === id) {
      // SIGTERM lets the Python process release GPU memory on the way out;
      // SIGKILL can strand several GB of wired memory until the OS reaps it.
      this.active.controller?.abort()
      this.active.child?.kill('SIGTERM')
      return
    }
    const qi = this.queue.indexOf(id)
    if (qi >= 0) {
      this.queue.splice(qi, 1)
      this.work.delete(id)
      job.state = 'cancelled'
      job.finishedAt = Date.now()
      this.emit(job)
    }
  }

  clearFinished(allow: (job:Job)=>boolean = () => true) {
    for (const [id, j] of this.jobs) {
      if (allow(j) && (j.state === 'done' || j.state === 'error' || j.state === 'cancelled')) {
        this.jobs.delete(id)
        this.history.delete(id)
      }
    }
  }

  private pump(): void {
    if (this.active || this.queue.length === 0) return
    const id = this.queue.shift()!
    const job = this.jobs.get(id)
    if (!job) return this.pump()
    const work = this.work.get(id)
    if (work) {
      this.work.delete(id)
      const controller = new AbortController()
      this.active = { id, controller }
      job.state = 'running'; job.startedAt = Date.now(); this.emit(job)
      void (async () => {
        try { job.text = await work(controller.signal); job.state = controller.signal.aborted ? 'cancelled' : 'done' }
        catch (e) { job.state = controller.signal.aborted ? 'cancelled' : 'error'; job.error = e instanceof Error ? e.message : String(e) }
        finally { job.finishedAt = Date.now(); this.active = null; this.emit(job); this.pump() }
      })()
      return
    }
    if (this.generationGuards.size) {
      const controller = new AbortController()
      this.active = { id, controller }
      void (async () => {
        try {
          // Cleanup is deliberately not aborted: cancellation cannot release this
          // queue slot while a previous model may still own GPU memory.
          for (const guard of this.generationGuards) await guard()
          controller.signal.throwIfAborted()
          this.active = null
          this.runModel(job)
        } catch (e) {
          job.state = controller.signal.aborted ? 'cancelled' : 'error'
          job.error = e instanceof Error ? e.message : String(e)
          job.finishedAt = Date.now()
          this.active = null; this.emit(job); this.pump()
        }
      })()
      return
    }
    this.runModel(job)
  }

  private runModel(job: Job): void {
    const adapter = byId(job.adapterId)
    if (!adapter || profileIssues.has(job.adapterId)) {
      job.state = 'error'
      job.error = profileIssues.get(job.adapterId) ?? `Unknown model: ${job.adapterId}`
      this.emit(job)
      return this.pump()
    }

    // Editing/variation CLIs hard-require an input image; catch it here with
    // a sentence instead of letting argparse produce a usage dump.
    if ((adapter.requiresImage || adapter.requiresAudio) && !(job.images?.length)) {
      const kind = adapter.requiresAudio ? 'a source audio file' : 'an input image'
      job.state = 'error'
      job.error = `${adapter.label} needs ${kind} — attach one above the prompt and rerun.`
      job.finishedAt = Date.now()
      this.emit(job)
      return this.pump()
    }

    const stamp = new Date(job.queuedAt).toISOString().replace(/[:.]/g, '-')
    const dir = join(RUNS_DIR, job.modality, `${stamp}_${adapter.id.replace(/[:/]/g, '_')}_${job.id.slice(0, 8)}`)
    mkdirSync(dir, { recursive: true })
    job.runDir = dir
    const outPath = adapter.outputExt
      ? join(dir, `output.${adapter.outputExt}`)
      : join(dir, 'output.txt')

    const history = this.history.get(job.id)
    this.history.delete(job.id)
    let spec
    try {
      spec = adapter.build({
        prompt: job.prompt,
        params: job.params,
        outPath,
        images: job.images ?? [],
        history,
      })
    } catch (e) {
      job.state = 'error'
      job.error = e instanceof Error ? e.message : String(e)
      job.finishedAt = Date.now()
      this.emit(job)
      return this.pump()
    }

    const arg = (flag: string) => {
      const index = spec.args.indexOf(flag)
      return index >= 0 ? spec.args[index+1] : undefined
    }
    const width = arg('--width'), height = arg('--height')
    const chosen = (key:string) => job.params[key] ?? adapter.params?.find(p=>p.key===key)?.default
    const lora = chosen('lora')
    const lastLora = spec.args.lastIndexOf('--lora')
    const scale = arg('--lora-scale') ?? (lastLora>=0 ? spec.args[lastLora+2] : undefined)
    job.details = {
      model: adapter.id, engine: String(chosen('image_engine') ?? (spec.bin.includes('/mflux-')?'mflux':adapter.family ?? adapter.id)),
      encoder: String(chosen('encoder') ?? (arg('--text-encoder') ? 'Configured text encoder' : 'Model default')),
      identity: lora ? String(lora) : job.images?.length ? 'Reference image' : undefined,
      strength: lora ? Number(scale && Number.isFinite(+scale) ? scale : chosen('lora_scale') ?? 1) : undefined,
      seed: job.params.seed == null ? undefined : Number(job.params.seed),
      size: width && height ? width+'x'+height : arg('--size') ?? String(job.params.resolution ?? job.params.aspect ?? ''),
      frames: job.params.frames ? Number(job.params.frames) : undefined, fps: adapter.frameRate,
    }
    job.state = 'running'
    job.startedAt = Date.now()
    job.log = `$ ${spec.bin} ${spec.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}\n\n`
    this.emit(job)

    const child = spawn(spec.bin, spec.args, {
      cwd: spec.cwd,
      env: modelEnv(spec.env),
    })
    this.active = { id: job.id, child }

    // Streaming adapters may emit a wire format rather than plain text
    // (Ollama's API streams NDJSON); makeStream returns a stateful parser
    // that extracts the display text. Without one, stdout IS the text.
    const extract = adapter.makeStream?.()
    let progressTimer: ReturnType<typeof setTimeout> | undefined
    const append = (chunk: Buffer, toText: boolean) => {
      const s = chunk.toString()
      const display = toText && extract ? extract(s) : s
      // Progress bars rewrite the same line thousands of times; keeping every
      // frame would grow the log without bound on a long run.
      job.log = (job.log + display).slice(-40_000)
      if (toText && adapter.streams) job.text = (job.text ?? '') + display
      progressTimer ??= setTimeout(() => {
        progressTimer = undefined
        this.emit(job)
      }, 150)
    }
    child.stdout?.on('data', (c: Buffer) => append(c, true))
    child.stderr?.on('data', (c: Buffer) => append(c, false))

    let settled = false
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(progressTimer)
      job.state = 'error'
      job.error = `Failed to launch ${spec.bin}: ${e.message}`
      job.finishedAt = Date.now()
      this.active = null
      this.emit(job)
      this.pump()
    })

    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(progressTimer)
      this.active = null
      job.finishedAt = Date.now()
      if (signal === 'SIGTERM') {
        job.state = 'cancelled'
      } else if (code === 0) {
        job.state = 'done'
        if (adapter.outputExt) {
          let file
          try { file = statSync(outPath) } catch { /* report the missing artifact on its job */ }
          if (file?.isFile() && file.size > 0) job.outputPath = outPath
          else {
            job.state = 'error'
            job.error = 'The model exited without writing a usable output file. Check its log and retry.'
          }
        }
        else job.text = job.text ?? ''
      } else {
        job.state = 'error'
        // The tail is where the traceback is; the head is usually banner noise.
        job.error = `exit ${code}\n${job.log.slice(-1500)}`

        // The most common first-run failure by far: the CLI is installed but
        // the model's weights were never downloaded, and offline mode (on by
        // default — see env.ts) turned that into a path-resolution error deep
        // inside the loader. That traceback says nothing about downloading, so
        // say it here.
        if (looksLikeMissingWeights(job.log) && process.env.LOCALLAB_ALLOW_DOWNLOAD !== '1') {
          job.error =
            `${adapter.label}'s weights don't appear to be downloaded yet.\n\n` +
            `Local Lab runs offline by default so a missing model fails fast ` +
            `instead of silently downloading gigabytes mid-run. To fetch it, ` +
            `relaunch with:\n\n    LOCALLAB_ALLOW_DOWNLOAD=1 pnpm dev\n\n` +
            `--- original error ---\n${job.error}`
        }
      }
      writeRunRecord(dir, adapter, job)
      this.emit(job)
      this.pump()
    })
  }
}

export const runner = new Runner()
