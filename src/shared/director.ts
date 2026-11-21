import type { RunRequest, SubmitTurn, TurnResult, JobState } from './types'
export interface DirectorChoice {
  mode: 'off' | 'preview' | 'auto'
  preset: string
  freedom: 'low' | 'medium' | 'high'
  comparison: 'same' | 'per-model'
}
export interface DirectorProfile { id: string; name: string; instructions: string }
export interface DirectorConfig {
  revision: number
  model: string
  /** Retain a successful preview model briefly; release before generation. */
  keepWarm?: boolean
  profiles: DirectorProfile[]
  protectedTerms: string[]
  defaults: { image: DirectorChoice; video: DirectorChoice }
}
export interface DirectorModel { id: string; label: string; vision: boolean }
export interface DirectorInfo { config: DirectorConfig; models: DirectorModel[]; error?: string }
export interface DirectorStart { id: string; turn: SubmitTurn; choice: DirectorChoice }
export interface DirectorProvenance {
  previewId: string
  model: string
  preset: string
  freedom: DirectorChoice['freedom']
  comparison: DirectorChoice['comparison']
  systemPrompt: string
  originalPrompt: string
  generatedPrompt: string
  finalPrompt: string
  visionUsed: boolean
  sourceImageCount: number
  protectedTerms: string[]
  createdAt: number
}
export interface DirectorApproval { previewId: string; prompts: Record<string, string> }
export interface DirectorPreview {
  id: string
  turn: SubmitTurn
  prompts: Record<string, string>
  provenance: Omit<DirectorProvenance, 'generatedPrompt' | 'finalPrompt'>
  warnings: string[]
}
export interface DirectorStatus {
  id: string
  state: JobState
  automatic: boolean
  error?: string
  preview?: DirectorPreview
  result?: TurnResult
}
export const DIRECTOR_PROFILES: DirectorProfile[] = [
  { id: 'adult', name: '18+ · Adult editorial', instructions: 'Direct adult glamour, pin-up, boudoir and swimwear scenes according to the user’s explicit request. All depicted subjects are adults. Preserve the selected character, body proportions, wardrobe, objects and requested degree of intimacy. Choosing this style alone does not request undressing, additional people or a more intimate action. Favor coherent lighting, flattering but believable composition, natural anatomy and fabric detail. For an edit, state the requested change and preserve everything else. For animation, describe one achievable motion with stable identity, physical contacts and a coherent end pose, within the available duration. Avoid escalating the request or adding unrelated actions.' },
  { id: 'faithful', name: 'Faithful', instructions: 'Clarify the user’s intent with concise concrete visual language. Preserve the requested person, appearance, body proportions, clothing, objects, pose, setting and action. Add only details needed to disambiguate. Keep quoted text exactly. Never invent a new subject or replace their intent with a different scene.' },
  { id: 'edit', name: 'Precise edit', instructions: 'Write a targeted instruction for editing the supplied image. State the requested change clearly and preserve all unrelated content: identity, facial structure, body proportions, pose, clothing, background, composition and lighting unless explicitly changed by the user. Do not recast the image as a new scene. Use reference numbering consistently when several images are attached.' },
  { id: 'motion', name: 'Motion director', instructions: 'Write a focused chronological motion description appropriate to the available clip duration. State observable action, weight shifts and contacts, coherent camera motion, and the intended end state. Keep objects rigid and interactions physically plausible. For image-to-video preserve the source subject, outfit and setting. Prefer one continuous shot and one achievable action in a short clip. Describe audio only if the target has audio enabled.' },
  { id: 'photo', name: 'Photography', instructions: 'Describe coherent photographic framing, composition, lighting direction, material detail and depth of field. Preserve the requested identity, appearance, body proportions, clothing, action and setting. Avoid contradictory camera instructions and generic quality-tag lists.' },
]
/** Built-in overrides and personal directors share the private profile store. */
export function directorProfiles(config: DirectorConfig): DirectorProfile[] {
  return [...DIRECTOR_PROFILES.map((p) => config.profiles.find((custom) => custom.id === p.id) ?? p),
    ...config.profiles.filter((p) => !DIRECTOR_PROFILES.some((builtIn) => builtIn.id === p.id))]
}
export function defaultDirectorConfig(): DirectorConfig {
  return { revision: 0, model: '', keepWarm: true, profiles: [], protectedTerms: [], defaults: {
    image: { mode: 'preview', preset: 'faithful', freedom: 'low', comparison: 'same' },
    video: { mode: 'preview', preset: 'motion', freedom: 'low', comparison: 'same' },
  } }
}
export function validateChoice(v: DirectorChoice): DirectorChoice {
  if (!v || !['off', 'preview', 'auto'].includes(v.mode) || typeof v.preset !== 'string' || v.preset.length > 100
    || !['low', 'medium', 'high'].includes(v.freedom) || !['same', 'per-model'].includes(v.comparison)) throw new Error('Invalid director settings.')
  return { mode: v.mode, preset: v.preset, freedom: v.freedom, comparison: v.comparison }
}
/** Stable comparison ignores property insertion order across IPC and JSON transports. */
export function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sort(x)])) : v
  return JSON.stringify(sort(value))
}
export function originalRequest(request: RunRequest): RunRequest {
  const { director: _approval, directedPrompts: _prompts, directorRecords: _records, ...original } = request
  return original
}
