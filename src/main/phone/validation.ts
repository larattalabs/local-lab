import type { AdapterInfo, SubmitTurn } from '@shared/types'
import { extname } from 'node:path'
import type { Assets } from './assets'

export function validateTurn(input: unknown, adapters: AdapterInfo[], assets?: Assets): SubmitTurn {
  const t = input as SubmitTurn
  const r = t?.request, c = t?.chat
  if (!r || !c || !['image', 'video'].includes(r.modality) || c.modality !== r.modality || typeof c.title !== 'string'
    || typeof c.contextOn !== 'boolean' || typeof t.contextUsed !== 'boolean'
    || typeof r.prompt !== 'string' || r.prompt.length > 16000 || !r.prompt.trim()
    || !Array.isArray(r.adapterIds) || !r.adapterIds.length || r.adapterIds.length > 4
    || new Set(r.adapterIds).size !== r.adapterIds.length || !r.params || typeof r.params !== 'object'
    || (c.revision != null && (!Number.isSafeInteger(c.revision) || c.revision < 0))) throw new Error('Invalid generation request.')
  if (c.projectId !== undefined && (typeof c.projectId !== 'string' || !/^[a-z0-9-]{1,100}$/i.test(c.projectId))) throw new Error('Invalid project.')
  const activeParams: SubmitTurn['request']['params'] = {}
  for (const id of r.adapterIds) {
    const a = adapters.find((a) => a.id === id && a.modality === r.modality)
    if (!a) throw new Error('Unknown model.')
    const params = r.params[id] ?? {}
    if (typeof params !== 'object' || Array.isArray(params) || params === null) throw new Error('Invalid model settings.')
    for (const [key, value] of Object.entries(params)) {
      const p = a.params.find((p) => p.key === key)
      if (!p) throw new Error(`Unknown setting: ${key}`)
      if (value === null && p.default == null) continue
      if (p.type === 'select' && !p.options?.some((o) => o.value === value)) throw new Error(`Invalid ${p.label}.`)
      if (p.type === 'bool' && typeof value !== 'boolean') throw new Error(`Invalid ${p.label}.`)
      if (p.type === 'string' && (typeof value !== 'string' || value.length > 16000)) throw new Error(`Invalid ${p.label}.`)
      if (['int', 'float', 'seed'].includes(p.type)) {
        if (p.type === 'seed' && (value === '' || value == null)) continue
        const n = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : NaN
        if (!Number.isFinite(n) || (p.type !== 'float' && !Number.isSafeInteger(n))
          || n < (p.min ?? (p.type === 'seed' ? -1 : -1e9)) || n > (p.max ?? (p.type === 'seed' ? 4294967295 : 1e9))) throw new Error(`Invalid ${p.label}.`)
      }
    }
    activeParams[id] = Object.fromEntries(Object.entries(params).filter(([key]) => {
      const rule = a.params.find((p) => p.key === key)?.visibleWhen
      return !rule || (params[rule.key] ?? a.params.find((p) => p.key === rule.key)?.default) === rule.value
    }))
  }
  if (r.history?.length) throw new Error('Text history is not supported by phone image/video generation.')
  if (r.images && (!Array.isArray(r.images) || r.images.length > 16 || r.images.some((p) => typeof p !== 'string'))) throw new Error('Choose up to 16 images.')
  const decode = (p: string) => {
    const path = assets ? assets.path(p) : p
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extname(path).toLowerCase())) throw new Error('Choose an image file.')
    return path
  }
  if (r.basic && (typeof r.basic !== 'object' || typeof r.basic.planId !== 'string' || !/^[a-z0-9-]{1,100}$/i.test(r.basic.planId))) throw new Error('Invalid Basic plan.')
  const approval = r.director
  if (approval && (typeof approval.previewId !== 'string' || !/^[a-z0-9-]{1,100}$/i.test(approval.previewId)
    || !approval.prompts || typeof approval.prompts !== 'object' || Array.isArray(approval.prompts)
    || Object.keys(approval.prompts).length > 4 || Object.values(approval.prompts).some((v) => typeof v !== 'string' || v.length > 16000))) throw new Error('Invalid director approval.')
  return { turnId: t.turnId, contextUsed: t.contextUsed, chat: { id: c.id, modality: c.modality,
    projectId: c.projectId, title: c.title.slice(0, 100), contextOn: c.contextOn, revision: c.revision,
    sourceImage: c.sourceImage ? decode(c.sourceImage) : undefined },
    request: { modality: r.modality, prompt: r.prompt, adapterIds: r.adapterIds, params: activeParams, director: approval, basic: r.basic, images: (r.images ?? []).map(decode) } }
}
