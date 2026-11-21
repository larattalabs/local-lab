import type { ModifierConfig, ModifierSnapshot } from './modifiers'
import type { AdapterInfo, SubmitTurn } from './types'
import type { DirectorChoice } from './director'
export type BasicWorkflow = 'create' | 'edit' | 'animate' | 'upscale'
export type BasicQuality = 'fast' | 'detailed'
export interface BasicRecipe {
  originalPrompt?: string
  planId: string; presetId: string; version: number; label: string; workflow: BasicWorkflow
  quality: BasicQuality; subject: string; style: string; adult: boolean; intensity?: string; modifiers?: ModifierSnapshot
}
export interface BasicPreset {
  id: string; version: number; name: string; workflow: BasicWorkflow; adapterId: string
  params: Record<string, unknown>; exposed: string[]; director: string; thumbnail?: string; mood?: string; intensity?: string
}
export interface BasicCatalog {
  modifiers: ModifierConfig; presets: BasicPreset[]; subjects: { id: string; label: string }[]
  models: { fast: string; detailed: string; video: string }; available: string[]
}
export interface BasicInput {
  id: string; chat?: SubmitTurn['chat']; workflow: BasicWorkflow; presetId: string
  projectId?: string; sourceRatio?: number; matchSource?: boolean; exactSeed?: boolean
  prompt: string; sourceImage?: string; subject: string; quality: BasicQuality
  aspect: '1:1' | '2:3' | '3:2' | '9:16' | '16:9'; duration: '49' | '97' | '121' | '241'
  assistance: 'off' | 'auto' | 'preview'; mood: string; intensity?: string
  values?: Record<string, unknown>; repeatMessageId?: string
}
export interface BasicPlan { turn: SubmitTurn; choice: DirectorChoice; summary: string }
export const BASIC_STYLES = [
  { id: 'natural', name: 'Natural', icon: '☀', prompt: 'Natural photography, believable light and material texture.' },
  { id: 'cinematic', name: 'Cinematic', icon: '◐', prompt: 'Cinematic composition with coherent directional lighting and restrained color grading.' },
  { id: 'fashion', name: 'Fashion', icon: '◇', prompt: 'Editorial fashion photography. Preserve the requested outfit and emphasize fabric, styling and composition.' },
  { id: 'illustration', name: 'Illustration', icon: '✎', prompt: 'A carefully composed illustration with intentional shapes and a cohesive palette.' },
  { id: 'faithful', name: 'As described', icon: '◎', prompt: '' },
  { id: 'adult', name: '18+', icon: '♡', prompt: 'Adult subjects only. Preserve the requested wardrobe, action and degree of intimacy.' },
] as const
export function basicDefaults(workflow: BasicWorkflow = 'create'): Omit<BasicInput, 'id' | 'chat'> {
  return { workflow, presetId: 'natural', prompt: '', subject: '', quality: 'fast', aspect: '1:1',
    duration: '97', assistance: 'auto', mood: 'glamour', intensity: 'low', values: {} }
}
export function presetControls(preset: BasicPreset, adapter: AdapterInfo): AdapterInfo {
  return { ...adapter, params: adapter.params.filter((p) => preset.exposed.includes(p.key)).map((p) => ({ ...p, advanced: false })) }
}
