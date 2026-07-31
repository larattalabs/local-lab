import { existsSync } from 'node:fs'
import type { Adapter } from './types'
import { imageAdapters } from './image'
import { videoAdapters } from './video'
import { musicAdapters } from './music'
import { textAdapters } from './text'
import type { AvailabilityReport, Modality } from '@shared/types'

let cached: Adapter[] | null = null

export function allAdapters(): Adapter[] {
  // Text adapters are discovered from `ollama list`, so the registry is built
  // once per launch rather than being a module-level constant.
  if (!cached) {
    cached = [...imageAdapters, ...videoAdapters, ...musicAdapters, ...textAdapters()]
  }
  return cached
}

export function refresh(): Adapter[] {
  cached = null
  return allAdapters()
}

export function byId(id: string): Adapter | undefined {
  return allAdapters().find((a) => a.id === id)
}

export function byModality(m: Modality): Adapter[] {
  return allAdapters().filter((a) => a.modality === m)
}

/**
 * A model is "available" when every path it needs exists. Checking up front
 * means a missing venv shows as a greyed-out card with a reason, instead of a
 * spawn failure after the user has written a prompt and hit run.
 */
export function availability(): AvailabilityReport[] {
  return allAdapters().map((a) => {
    const missing = a.requires.filter((p) => !existsSync(p))
    return missing.length
      ? { id: a.id, available: false, reason: `missing: ${missing.join(', ')}` }
      : { id: a.id, available: true }
  })
}

export type { Adapter }
