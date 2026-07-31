import type { AdapterInfo, AvailabilityReport, Job, Modality } from '@shared/types'
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
  /** attached reference/init images, shared across the image + video sections */
  images = $state<string[]>([])

  async init() {
    this.adapters = await lab.listAdapters()
    const av = await lab.availability()
    this.availability = Object.fromEntries(av.map((a) => [a.id, a]))
    this.jobs = await lab.listJobs()
    this.runsDir = await lab.runsDir()

    lab.onJobUpdate((job) => {
      const i = this.jobs.findIndex((j) => j.id === job.id)
      if (i >= 0) this.jobs[i] = job
      else this.jobs = [job, ...this.jobs]
    })
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

  async run(m: Modality) {
    const ids = this.selected[m].filter((id) => this.isAvailable(id))
    if (!ids.length || !this.prompts[m].trim()) return
    const params: Record<string, Record<string, unknown>> = {}
    for (const id of ids) {
      const a = this.adapters.find((x) => x.id === id)
      if (a) params[id] = this.resolvedParams(a)
    }
    const takesImages = ids.some((id) => this.adapters.find((a) => a.id === id)?.acceptsImages)

    // Everything here came out of `$state`, so it is a Proxy. Electron's IPC
    // uses structured clone, which throws "An object could not be cloned" on a
    // Proxy — snapshot it back to plain data before it crosses the bridge.
    await lab.run(
      $state.snapshot({
        adapterIds: ids,
        modality: m,
        prompt: this.prompts[m],
        params,
        images: takesImages ? this.images : [],
      })
    )
  }
}

export const store = new LabStore()
