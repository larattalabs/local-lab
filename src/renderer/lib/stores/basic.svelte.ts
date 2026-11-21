import { defaultModifiers, type ModifierConfig } from '@shared/modifiers'
import { basicDefaults, type BasicCatalog, type BasicInput, type BasicPlan, type BasicPreset, type BasicWorkflow } from '@shared/basic'
import type { ChatMessage, Modality, SubmitTurn } from '@shared/types'
import { lab, isWeb } from '../api'
import { studio } from './studio.svelte'
import { store } from './lab.svelte'
import { directorFlow } from './director.svelte'
type Draft = ReturnType<typeof basicDefaults>
class BasicFlow {
  mode = $state<'basic' | 'advanced'>(isWeb ? 'basic' : 'advanced')
  catalog = $state<BasicCatalog>({ modifiers: defaultModifiers(), presets: [], subjects: [], models: { fast: '', detailed: '', video: '' }, available: [] })
  drafts = $state<Record<string, Draft>>({})
  busy = $state(false)
  error = $state('')
  private retries = new Map<string, { intent: string; input: BasicInput; turn?: SubmitTurn }>()
  private initialized = false
  private reloadSequence = 0
  async init() {
    try {
      const mode = localStorage.getItem('lab-experience'); if (mode === 'basic' || mode === 'advanced') this.mode = mode
      this.drafts = JSON.parse(localStorage.getItem('lab-basic-drafts') ?? '{}')
    } catch { this.drafts = {} }
    await this.reload()
    if (!this.initialized) {
      this.initialized = true
      const reload = () => { void this.reload().catch((e) => this.error = String(e)) }
      lab.onBasicUpdate?.(reload); lab.onSync?.(reload)
    }
  }
  async reload() { const sequence = ++this.reloadSequence; const catalog = await lab.basicCatalog(); if (sequence === this.reloadSequence) this.catalog = { ...catalog, modifiers: catalog.modifiers ?? defaultModifiers() } }
  async configureModifiers(config: ModifierConfig) { await lab.basicModifiers($state.snapshot(config)); await this.reload() }
  private key(m: Modality) { return m + ':' + (store.activeChat[m] ?? 'draft') }
  draft(m: Modality): Draft { return { ...basicDefaults(m === 'video' ? 'animate' : 'create'), ...this.drafts[this.key(m)] } }
  update(m: Modality, patch: Partial<Draft>) {
    this.drafts[this.key(m)] = { ...this.draft(m), ...patch }; this.error = ''
    localStorage.setItem('lab-basic-drafts', JSON.stringify($state.snapshot(this.drafts)))
  }
  resetDraft(m: Modality) {
    this.retries.delete(this.key(m))
    this.drafts[this.key(m)] = basicDefaults(m === 'video' ? 'animate' : 'create')
    localStorage.setItem('lab-basic-drafts', JSON.stringify($state.snapshot(this.drafts)))
  }
  setMode(mode: 'basic' | 'advanced') { this.mode = mode; localStorage.setItem('lab-experience', mode); if (mode === 'basic') void this.reload().catch((e) => this.error = String(e)) }
  workflow(m: Modality, workflow: BasicWorkflow) { this.update(m, { workflow, presetId: 'natural', values: {} }) }
  usePreset(m: Modality, presetId: string) {
    const p = this.catalog.presets.find((p) => p.id === presetId)
    this.update(m, { presetId, ...(p ? { workflow: p.workflow, values: { ...p.params }, ...(p.director === 'adult' ? { mood: p.mood ?? 'glamour', intensity: p.intensity ?? 'low' } : {}) } : { values: {} }) })
  }
  source(m: Modality, sourceImage: string, workflow: BasicWorkflow) {
    this.update(m, { sourceImage, workflow, sourceRatio:undefined, ...(this.catalog.presets.some((p) => p.id === this.draft(m).presetId && p.workflow !== workflow) ? { presetId: 'natural' } : {}) })
  }
  animate(path: string, projectId?: string) {
    store.newChat('video'); this.update('video', { ...basicDefaults('animate'), sourceImage: path, projectId, matchSource:true, sourceRatio:undefined })
  }
  advanced(message: ChatMessage) {
    const r = message.requestSnapshot
    if (!r) { this.error = 'This older result has no saved settings.'; return }
    store.selected[r.modality] = [...r.adapterIds]
    for (const id of r.adapterIds) store.params[id] = { ...r.params[id] }
    store.prompts[r.modality] = message.effectivePrompt ?? r.prompt
    store.images[r.modality] = [...(r.images ?? [])]
    const chat = store.currentChat(r.modality)
    if (chat) chat.contextOn = false
    if (r.modality === 'image') store.clearImageEditSource()
    this.setMode('advanced')
  }
  async send(m: Modality, review = false, repeat?: ChatMessage, exactSeed = false) {
    if (this.busy) return
    this.busy = true; this.error = ''
    const key = this.key(m), draft = $state.snapshot(this.draft(m))
    try {
      const chat = store.currentChat(m)
      const data = { ...draft, assistance: review ? 'preview' as const : draft.assistance,
        chat: chat ? { id: chat.id, modality: chat.modality, title: chat.title, contextOn: chat.contextOn, revision: chat.revision, projectId:chat.projectId, sourceImage: chat.sourceImage } : undefined,
        repeatMessageId: repeat?.id, exactSeed }
      // Custom controls send only the deliberately exposed overrides.
      const preset = this.catalog.presets.find((p) => p.id === draft.presetId)
      if (preset) data.values = Object.fromEntries(Object.entries(data.values ?? {}).filter(([k]) => preset.exposed.includes(k)))
      const intent = JSON.stringify(data)
      let retry = this.retries.get(key)
      if (!retry || retry.intent !== intent) { retry = { intent, input: { ...data, id: crypto.randomUUID() } }; this.retries.set(key, retry) }
      let plan: BasicPlan | undefined
      if (!retry.turn) plan = await lab.basicPlan(retry.input)
      const directed = retry.turn ? { turn: retry.turn } : await directorFlow.prepare(plan!.turn, plan!.choice)
      if (!directed) { this.retries.delete(key); return }
      retry.turn = directed.turn
      const result = 'result' in directed ? directed.result : await lab.submitTurn(directed.turn)
      this.retries.delete(key)
      store.acceptResult(result)
      studio.selected = null
      // Sending a snapshot never discards edits made while it was preparing.
      const current = this.drafts[key] ?? draft
      this.drafts[this.key(m)] = { ...current, prompt: current.prompt === draft.prompt && !repeat ? '' : current.prompt }
      localStorage.setItem('lab-basic-drafts', JSON.stringify($state.snapshot(this.drafts)))
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
      if (this.error.includes('changed on another device')) { this.retries.delete(key); await store.refreshChats().catch(() => {}) }
    } finally { this.busy = false }
  }
  async save(preset: BasicPreset) { await lab.basicSave($state.snapshot(preset)); await this.reload() }
  async remove(preset: BasicPreset) { await lab.basicDelete({ id: preset.id, version: preset.version }); await this.reload() }
}
export const basicFlow = new BasicFlow()
