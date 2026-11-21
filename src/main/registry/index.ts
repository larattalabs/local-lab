import { profileIssues, unavailable } from './profile-config'
import { existsSync } from 'node:fs'
import type { Adapter } from './types'
import { imageAdapters } from './image'
import { videoAdapters } from './video'
import { musicAdapters } from './music'
import { textAdapters } from './text'
import { omlxAdapters } from './omlx'
import { ds4Adapters } from './ds4'
import type { AvailabilityReport, Modality } from '@shared/types'

const builtins = [...imageAdapters, ...videoAdapters, ...musicAdapters, ...ds4Adapters]
if (profileIssues.has('qwen-native-runtime')) builtins.push(unavailable('qwen-native-runtime','image',profileIssues.get('qwen-native-runtime')!))
let cached = builtins
let pending: Promise<Adapter[]> | undefined
export function allAdapters() { return cached }

export function refresh(): Promise<Adapter[]> {
  return pending ??= Promise.all([textAdapters(), omlxAdapters()]).then(([ollama, omlx]) => {
    cached = [...builtins, ...ollama, ...omlx]
    return cached
  }).finally(() => { pending = undefined })
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
    const reason = profileIssues.get(a.id)
    if (reason) return { id:a.id, available:false, reason }
    const missing = a.requires.filter((p) => !existsSync(p))
    return missing.length
      ? { id: a.id, available: false, reason: `missing: ${missing.join(', ')}` }
      : { id: a.id, available: true }
  })
}

export type { Adapter }
