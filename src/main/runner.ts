import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Job, RunRequest, Modality } from '@shared/types'
import { byId } from './registry'
import { modelEnv, RUNS_DIR } from './env'

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
class Runner {
  private jobs = new Map<string, Job>()
  private queue: string[] = []
  private active: { id: string; child: ChildProcess } | null = null
  private emit: Emit = () => {}

  onUpdate(fn: Emit) {
    this.emit = fn
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.queuedAt - a.queuedAt)
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id)
  }

  /** Fan one prompt out across N models. Returns the created jobs in order. */
  enqueue(req: RunRequest): Job[] {
    const created: Job[] = []
    for (const adapterId of req.adapterIds) {
      const adapter = byId(adapterId)
      if (!adapter) continue
      const job: Job = {
        id: randomUUID(),
        adapterId,
        adapterLabel: adapter.label,
        modality: req.modality as Modality,
        prompt: req.prompt,
        params: req.params[adapterId] ?? {},
        images: req.images ?? [],
        state: 'queued',
        queuedAt: Date.now(),
        log: '',
      }
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
      this.active.child.kill('SIGTERM')
      return
    }
    const qi = this.queue.indexOf(id)
    if (qi >= 0) {
      this.queue.splice(qi, 1)
      job.state = 'cancelled'
      job.finishedAt = Date.now()
      this.emit(job)
    }
  }

  clearFinished() {
    for (const [id, j] of this.jobs) {
      if (j.state === 'done' || j.state === 'error' || j.state === 'cancelled') {
        this.jobs.delete(id)
      }
    }
  }

  private pump(): void {
    if (this.active || this.queue.length === 0) return
    const id = this.queue.shift()!
    const job = this.jobs.get(id)
    if (!job) return this.pump()
    const adapter = byId(job.adapterId)
    if (!adapter) {
      job.state = 'error'
      job.error = `Unknown model: ${job.adapterId}`
      this.emit(job)
      return this.pump()
    }

    const stamp = new Date(job.queuedAt).toISOString().replace(/[:.]/g, '-')
    const dir = join(RUNS_DIR, job.modality, `${stamp}_${adapter.id.replace(/[:/]/g, '_')}`)
    mkdirSync(dir, { recursive: true })
    const outPath = adapter.outputExt
      ? join(dir, `output.${adapter.outputExt}`)
      : join(dir, 'output.txt')

    let spec
    try {
      spec = adapter.build({
        prompt: job.prompt,
        params: job.params,
        outPath,
        images: job.images ?? [],
      })
    } catch (e) {
      job.state = 'error'
      job.error = e instanceof Error ? e.message : String(e)
      job.finishedAt = Date.now()
      this.emit(job)
      return this.pump()
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

    const append = (chunk: Buffer, toText: boolean) => {
      const s = chunk.toString()
      // Progress bars rewrite the same line thousands of times; keeping every
      // frame would grow the log without bound on a long run.
      job.log = (job.log + s).slice(-40_000)
      if (toText && adapter.streams) job.text = (job.text ?? '') + s
      this.emit(job)
    }
    child.stdout?.on('data', (c: Buffer) => append(c, true))
    child.stderr?.on('data', (c: Buffer) => append(c, false))

    child.on('error', (e) => {
      job.state = 'error'
      job.error = `Failed to launch ${spec.bin}: ${e.message}`
      job.finishedAt = Date.now()
      this.active = null
      this.emit(job)
      this.pump()
    })

    child.on('close', (code, signal) => {
      this.active = null
      job.finishedAt = Date.now()
      if (signal === 'SIGTERM') {
        job.state = 'cancelled'
      } else if (code === 0) {
        job.state = 'done'
        if (adapter.outputExt) job.outputPath = outPath
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
      this.emit(job)
      this.pump()
    })
  }
}

export const runner = new Runner()
