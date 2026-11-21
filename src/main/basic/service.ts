import { editTarget, motionPlan } from '@shared/media-plan'
import { defaultModifiers, modifierPrompt, type ModifierConfig, type ModifierSnapshot } from '@shared/modifiers'
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, realpathSync } from 'node:fs'
import { join, sep, extname } from 'node:path'
import { randomUUID, randomInt } from 'node:crypto'
import { canonical, originalRequest, directorProfiles, type DirectorConfig } from '@shared/director'
import { BASIC_STYLES, type BasicCatalog, type BasicInput, type BasicPlan, type BasicPreset, type BasicRecipe } from '@shared/basic'
import type { AdapterInfo, Chat, RunRequest, SubmitTurn } from '@shared/types'
import { validateTurn } from '../phone/validation'
interface PrivateProfiles {
  models?: BasicCatalog['models']; subjects?: { id: string; label: string; lora: string; trigger: string }[]
}
interface Dependencies { adapters(): AdapterInfo[]; available(): string[]; chats(): Chat[]; directorConfig(): Promise<DirectorConfig> }
const validId = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9-]{1,100}$/i.test(v)
function atomic(path: string, value: unknown) { writeFileSync(path + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 }); renameSync(path + '.tmp', path) }
export class BasicService {
  private presets: BasicPreset[]
  private profiles: PrivateProfiles
  private plans: string
  private file: string
  private modifierFile: string
  private modifiers: ModifierConfig
  private listeners = new Set<() => void>()
  onChange(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  private changed() { for (const fn of this.listeners) fn() }
  constructor(settings: string, private runs: string, profiles: string, private dep: Dependencies) {
    mkdirSync(settings, { recursive: true }); this.plans = join(runs, 'basic-plans'); mkdirSync(this.plans, { recursive: true })
    this.modifierFile = join(settings, 'basic-modifiers.json')
    this.modifiers = existsSync(this.modifierFile) ? JSON.parse(readFileSync(this.modifierFile, 'utf8')) : defaultModifiers()
    this.file = join(settings, 'basic-presets.json')
    this.presets = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : []
    this.profiles = existsSync(profiles) ? JSON.parse(readFileSync(profiles, 'utf8')) : {}
  }
  resetHistory() {
    this.preparing.clear(); mkdirSync(this.plans, {recursive:true})
    const next = this.presets.map((p) => ({...p, thumbnail: undefined, version: p.version + 1}))
    atomic(this.file, next); this.presets = next; this.changed()
  }
  catalog(): BasicCatalog {
    return structuredClone({ modifiers: this.modifiers, presets: this.presets, subjects: (this.profiles.subjects ?? []).map(({ id, label }) => ({ id, label })),
      models: this.profiles.models ?? { fast: 'qwen-image-2.1-turbo', detailed: 'qwen-image-2.1', video: 'ltx-2.5' }, available: this.dep.available() })
  }
  configureModifiers(input: ModifierConfig): BasicCatalog {
    if (!input || input.revision !== this.modifiers.revision) throw new Error('Moods or intensities changed on another device. Reload before saving.')
    const defaults = defaultModifiers()
    const next: ModifierConfig = { revision: this.modifiers.revision + 1, moods: [], intensities: [] }
    for (const kind of ['moods', 'intensities'] as const) {
      const list = input[kind]
      if (!Array.isArray(list) || list.length > 30 || list.length < defaults[kind].length) throw new Error('Keep the built-in options and at most 30 entries per editor.')
      const ids = new Set<string>(), names = new Set<string>()
      for (const entry of list) {
        if (!entry || !validId(entry.id) || ids.has(entry.id) || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 60
          || typeof entry.description !== 'string' || entry.description.length > 240 || typeof entry.instructions !== 'string' || entry.instructions.length > 2000
          || typeof entry.motionInstructions !== 'string' || entry.motionInstructions.length > 1000) throw new Error('Use unique IDs, names up to 60 characters, and instructions within the editor limits.')
        const name = entry.name.trim()
        if (names.has(name.toLocaleLowerCase())) throw new Error('Give each option a different name.')
        ids.add(entry.id); names.add(name.toLocaleLowerCase())
        next[kind].push({ id: entry.id, name, description: entry.description.trim(), instructions: entry.instructions.trim(), motionInstructions: entry.motionInstructions.trim() })
      }
      if (defaults[kind].some((p) => !ids.has(p.id))) throw new Error('Built-in options can be edited or restored, but not removed.')
      const key = kind === 'moods' ? 'mood' : 'intensity'
      if (this.presets.some((p) => p.director === 'adult' && p[key] && !ids.has(p[key]!))) throw new Error('An existing preset uses this option. Edit that preset before removing it.')
    }
    atomic(this.modifierFile, next); this.modifiers = next; this.changed(); return this.catalog()
  }
  private resolveModifiers(mood = 'glamour', intensity = 'low'): ModifierSnapshot {
    const selectedMood = this.modifiers.moods.find((p) => p.id === mood)
    const selectedIntensity = this.modifiers.intensities.find((p) => p.id === intensity)
    if (!selectedMood || !selectedIntensity) throw new Error('This mood or intensity is unavailable. Choose another option in Style.')
    return structuredClone({ revision: this.modifiers.revision, mood: selectedMood, intensity: selectedIntensity })
  }
  private image(path: string) {
    const real = realpathSync(path)
    if (!real.startsWith(realpathSync(this.runs) + sep) || !['.png', '.jpg', '.jpeg', '.webp'].includes(extname(real).toLowerCase())) throw new Error('Choose an image in the media library.')
    return real
  }
  private adapter(id: string) {
    const a = this.dep.adapters().find((a) => a.id === id)
    if (!a || !this.dep.available().includes(id)) throw new Error('This preset’s model is unavailable. Choose another preset or use Advanced mode.')
    return a
  }
  async save(input: BasicPreset) {
    if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || !Array.isArray(input.exposed)
      || input.exposed.length > 12 || new Set(input.exposed).size !== input.exposed.length
      || !['create', 'edit', 'animate', 'upscale'].includes(input.workflow)) throw new Error('Invalid preset.')
    const a = this.adapter(input.adapterId)
    if (!['image', 'video'].includes(a.modality) || (input.workflow === 'animate') !== (a.modality === 'video')
      || (input.workflow === 'create' && a.requiresImage) || (['edit', 'upscale'].includes(input.workflow) && !a.acceptsImages)
      || (input.workflow === 'upscale' && !a.promptOptional)) throw new Error('Choose a model compatible with this workflow.')
    if (input.exposed.some((key) => !a.params.some((p) => p.key === key))) throw new Error('Unknown exposed control.')
    if (!directorProfiles(await this.dep.directorConfig()).some((p) => p.id === input.director)) throw new Error('Choose an existing director.')
    if (input.director === 'adult') this.resolveModifiers(input.mood, input.intensity)
    const old = this.presets.find((p) => p.id === input.id)
    if (input.id && (!old || old.version !== input.version)) throw new Error('This preset changed on another device. Reload and retry.')
    if (!old && this.presets.length >= 50) throw new Error('Keep up to 50 saved presets.')
    const params = this.validate(a, input.params, 'Preset validation', [], undefined).request.params[a.id]
    const saved: BasicPreset = { id: old?.id ?? randomUUID(), version: (old?.version ?? 0) + 1, name: input.name.trim(), workflow: input.workflow,
      adapterId: a.id, params, exposed: [...input.exposed], director: input.director,
      ...(input.director === 'adult' ? { mood: input.mood ?? 'glamour', intensity: input.intensity ?? 'low' } : {}),
      thumbnail: input.thumbnail ? this.image(input.thumbnail) : undefined }
    this.presets = [...this.presets.filter((p) => p.id !== saved.id), saved]; atomic(this.file, this.presets); this.changed()
    return this.catalog()
  }
  remove(input: { id: string; version: number }) {
    const old = this.presets.find((p) => p.id === input?.id)
    if (!old || old.version !== input.version) throw new Error('This preset changed on another device. Reload and retry.')
    this.presets = this.presets.filter((p) => p.id !== old.id); atomic(this.file, this.presets); this.changed(); return this.catalog()
  }
  private validate(a: AdapterInfo, params: Record<string, unknown>, prompt: string, images: string[], chat: SubmitTurn['chat'] | undefined, id: string = randomUUID()) {
    return validateTurn({ turnId: id, chat: chat ?? { id: randomUUID(), modality: a.modality, title: prompt.slice(0, 48), contextOn: false }, contextUsed: false,
      request: { modality: a.modality, adapterIds: [a.id], prompt, params: { [a.id]: params }, images } }, this.dep.adapters())
  }
  private preparing = new Map<string, { signature: string; promise: Promise<BasicPlan> }>()
  async plan(input: BasicInput): Promise<BasicPlan> {
    const key = input?.id, signature = canonical(input), pending = this.preparing.get(key)
    if (pending) {
      if (pending.signature !== signature) throw new Error('This request identifier belongs to another draft.')
      return structuredClone(await pending.promise)
    }
    const promise = this.prepare(input)
    this.preparing.set(key, { signature, promise })
    try { return structuredClone(await promise) } finally { this.preparing.delete(key) }
  }
  private async prepare(input: BasicInput): Promise<BasicPlan> {
    if (!input || !validId(input.id) || !['create', 'edit', 'animate', 'upscale'].includes(input.workflow)
      || typeof input.prompt !== 'string' || input.prompt.length > 12000 || !['fast', 'detailed'].includes(input.quality)
      || !['1:1', '2:3', '3:2', '9:16', '16:9'].includes(input.aspect) || !['49', '97', '121', '241'].includes(input.duration)
      || !['off', 'auto', 'preview'].includes(input.assistance) || !validId(input.mood) || (input.intensity !== undefined && !validId(input.intensity))) throw new Error('Invalid Basic mode request.')
    const path = join(this.plans, input.id + '.json'), signature = canonical(input)
    if (existsSync(path)) {
      const old = JSON.parse(readFileSync(path, 'utf8'))
      if (old.signature !== signature) throw new Error('This request identifier belongs to another draft.')
      return old.plan
    }
    let a: AdapterInfo, params: Record<string, unknown>, prompt = input.prompt.trim(), images: string[] = [], recipe: BasicRecipe
    let director = input.workflow === 'animate' ? 'motion' : input.workflow === 'edit' ? 'edit' : 'photo'
    let assistance = input.assistance
    let modifiers: ModifierSnapshot | undefined
    if (input.repeatMessageId) {
      const m = this.dep.chats().flatMap((c) => c.messages).find((m) => m.id === input.repeatMessageId && m.state === 'done')
      if (!m?.requestSnapshot) throw new Error('This older result has no saved settings. Open it in Advanced to create a new preset.')
      const snap = m.requestSnapshot; a = this.adapter(snap.adapterIds[0]); params = { ...snap.params[a.id], seed: input.exactSeed ? snap.params[a.id].seed : randomInt(2 ** 32) }
      if (!a.params.some((p) => p.key === 'seed')) delete params.seed
      prompt = m.effectivePrompt ?? snap.prompt; images = (snap.images ?? []).map((p) => this.image(p)); assistance = 'off'
      recipe = { ...(snap.basic ?? { presetId: 'repeat', version: 1, label: 'Make another', workflow: a.modality === 'video' ? 'animate' : images.length ? 'edit' : 'create', quality: 'fast', subject: '', style: '', adult: false }), planId: input.id }
    } else {
      const custom = this.presets.find((p) => p.id === input.presetId), style = BASIC_STYLES.find((p) => p.id === input.presetId)
      if (!custom && !style) throw new Error('This preset is unavailable. Choose another.')
      if (custom && custom.workflow !== input.workflow) throw new Error('Choose the matching workflow for this preset.')
      if (input.workflow !== 'create') {
        if (!input.sourceImage) throw new Error('Select a source image first.')
        images = [this.image(input.sourceImage)]
      }
      const models = this.catalog().models
      let id = custom?.adapterId ?? (input.workflow === 'animate' ? models.video : input.workflow === 'upscale' ? 'seedvr2' : models[input.quality])
      if (!custom && input.workflow === 'edit') {
        const base = this.adapter(id); if (!editTarget(base)) throw new Error('This preset has no matching editor.')
        id = editTarget(base)!
      }
      a = this.adapter(id)
      params = Object.fromEntries(a.params.filter((p) => p.default !== undefined).map((p) => [p.key, p.default]))
      if (custom) {
        Object.assign(params, custom.params)
        for (const [key, value] of Object.entries(input.values ?? {})) {
          if (!custom.exposed.includes(key)) throw new Error('This setting is not exposed by the preset.')
          params[key] = value
        }
        director = custom.director
        const subject = this.profiles.subjects?.find((s) => s.lora === params.lora)
        if (subject && ['create', 'edit'].includes(input.workflow)) prompt = `${subject.trigger}, ${prompt}`
      } else {
        if (a.params.some((p) => p.key === 'aspect')) params.aspect = input.aspect
        if (input.workflow === 'animate') Object.assign(params, motionPlan(a, input.matchSource && Number(input.sourceRatio)>0 ? Number(input.sourceRatio) :
          Number(input.aspect.split(':')[0])/Number(input.aspect.split(':')[1]), Number(input.duration)/24,input.quality==='fast'))
        if (input.subject && ['create', 'edit'].includes(input.workflow)) {
          const subject = this.profiles.subjects?.find((s) => s.id === input.subject)
          if (!subject || !a.params.find((p) => p.key === 'lora')?.options?.some((o) => o.value === subject.lora)) throw new Error('This subject is incompatible with the selected preset.')
          params.lora = subject.lora; params.lora_scale = 1
          prompt = `${subject.trigger}, ${prompt}`
        }
        if (['faithful', 'illustration'].includes(style?.id ?? '') && input.workflow === 'create') director = 'faithful'
        if (style?.prompt) prompt += '\n' + style.prompt
        if (style?.id === 'adult' && input.workflow !== 'upscale') {
          director = 'adult'; modifiers = this.resolveModifiers(input.mood, input.intensity ?? 'low')
          const addition = modifierPrompt(modifiers, input.workflow === 'animate')
          if (addition) prompt += '\n' + addition
        }
        if (input.workflow === 'edit') prompt += '\nEdit only the requested elements; preserve the source identity and unrelated content.'
        if (input.workflow === 'animate') prompt += '\nPreserve the starting image’s subject, outfit and setting. One continuous shot.'
      }
      if (custom?.director === 'adult' && input.workflow !== 'upscale') {
        modifiers = this.resolveModifiers(input.mood, input.intensity ?? custom?.intensity ?? 'low')
        const addition = modifierPrompt(modifiers, input.workflow === 'animate')
        if (addition) prompt += '\n' + addition
      }
      if (input.workflow === 'upscale') { prompt = 'Restore and upscale the selected image.'; assistance = 'off' }
      else if (!input.prompt.trim()) throw new Error('Describe what you want to create or change.')
      if (a.params.some((p) => p.key === 'seed') && !(custom?.exposed.includes('seed') && input.values?.seed != null && input.values.seed !== '')) params.seed = randomInt(2 ** 32)
      recipe = { originalPrompt:input.prompt, planId: input.id, presetId: input.presetId, version: custom?.version ?? 1, label: custom?.name ?? style!.name,
        workflow: input.workflow, quality: input.quality, subject: custom ? this.profiles.subjects?.find((s) => s.lora === params.lora)?.id ?? '' : input.subject, style: modifiers?.mood.id ?? input.mood, ...(modifiers ? { intensity: modifiers.intensity.id, modifiers } : {}), adult: style?.id === 'adult' || custom?.director === 'adult' }
    }
    const suppliedChat = input.chat?.modality === a.modality ? input.chat : undefined
    const turn = this.validate(a, params, prompt, images, suppliedChat, input.id)
    if (input.projectId && !validId(input.projectId)) throw new Error('Invalid project.')
    if (!suppliedChat && input.projectId) turn.chat.projectId = input.projectId
    if (!suppliedChat) turn.chat.title = (input.workflow === 'upscale' ? 'Image upscale' : input.prompt.trim()).replace(/\s+/g, ' ').slice(0, 48)
    turn.chat.sourceImage = a.modality === 'video' ? images[0] : undefined
    turn.request.basic = recipe
    if (assistance !== 'off' && !directorProfiles(await this.dep.directorConfig()).some((p) => p.id === director)) throw new Error('This preset’s director was removed. Edit the preset or choose another.')
    const plan: BasicPlan = { turn, choice: { mode: assistance, preset: director, freedom: 'low', comparison: 'same' }, summary: `${recipe.label} · ${a.label}${images.length ? ' · selected image' : ''}` }
    atomic(path, { signature, plan }); return plan
  }
  verify(turn: SubmitTurn): RunRequest {
    const id = turn.request.basic?.planId
    if (!id) return turn.request
    if (!validId(id)) throw new Error('Invalid Basic plan.')
    const path = join(this.plans, id + '.json')
    if (!existsSync(path)) throw new Error('This Basic plan is unavailable. Prepare the prompt again.')
    const { plan } = JSON.parse(readFileSync(path, 'utf8')) as { plan: BasicPlan }
    if (canonical({ ...turn, turnId: plan.turn.turnId, request: originalRequest(turn.request) }) !== canonical(plan.turn)) throw new Error('The Basic plan changed after preparation. Prepare it again.')
    return turn.request
  }
}
