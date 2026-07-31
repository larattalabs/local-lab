import type { AdapterInfo } from '@shared/types'

export interface RunContext {
  prompt: string
  params: Record<string, unknown>
  /** Absolute path the adapter must write its artifact to. */
  outPath: string
  /** Reference / init images, absolute paths. Empty unless `acceptsImages`. */
  images: string[]
}

export interface Spawn {
  bin: string
  args: string[]
  /** Some CLIs only resolve their own resources relative to their repo root. */
  cwd?: string
  /** Merged over the base environment; see main/env.ts. */
  env?: Record<string, string>
}

export interface Adapter extends AdapterInfo {
  /**
   * Filesystem paths this adapter needs. Checked before the model appears as
   * runnable, so a missing venv reads as "not installed" instead of a spawn
   * error twenty seconds into a job.
   */
  requires: string[]
  build(ctx: RunContext): Spawn
}

/** Strip the functions and internals so the object can cross the IPC bridge. */
export function toInfo(a: Adapter): AdapterInfo {
  return {
    id: a.id,
    label: a.label,
    modality: a.modality,
    family: a.family,
    notes: a.notes,
    outputExt: a.outputExt,
    params: a.params,
    acceptsImages: a.acceptsImages,
    streams: a.streams,
    approxPeakGb: a.approxPeakGb,
  }
}
