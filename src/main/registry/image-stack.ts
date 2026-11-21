import { readProfile, profileIssues, unavailable } from './profile-config'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AI_ROOT } from '../env'
import type { ParamSpec } from '@shared/types'
import type { Adapter } from './types'
import { nativeQwenConfigured, qwenEngineParam, mfluxOnly, usesNativeQwen, qwenSpawn } from './qwen-runtime'

const BIN = (name: string) => join(homedir(), '.local', 'bin', name)
const MODELS = process.env.LOCALLAB_IMAGE_MODELS_DIR ?? join(AI_ROOT, 'image-stack')
const SEEDVR2 = process.env.LOCALLAB_SEEDVR2_DIR ?? join(homedir(), 'ComfyUI-Shared', 'models', 'SEEDVR2')

const sizes = {
  '1:1': [1024, 1024], '16:9': [1536, 832], '9:16': [832, 1536],
  '3:2': [1216, 832], '2:3': [832, 1216], '4:3': [1152, 896],
} as const

const aspect: ParamSpec = {
  key: 'aspect', label: 'Aspect', type: 'select', default: '1:1',
  options: Object.entries(sizes).map(([value, size]) => ({ value, label: `${value} (${size.join('×')})` })),
}
const seed: ParamSpec = { key: 'seed', label: 'Seed', type: 'seed', default: null }
const quantize: ParamSpec = {
  key: 'quantize', label: 'Precision', type: 'select', default: '', advanced: true,
  options: [{ value: '', label: 'Full precision' }, { value: '8', label: '8-bit' },
    { value: '6', label: '6-bit' }, { value: '4', label: '4-bit' }],
}
interface ImageModel {
  id: string
  label: string
  model: string
  base: string
  command: string
  steps: number
  edit?: boolean
  qwen?: boolean
  turbo?: boolean
  notes?: string
  guided?: boolean
  expandedInt8?: boolean
  stepReuse?: boolean
  presetLoras?: { path: string; scale?: number }[]
}

interface LocalChoice { id: string; label: string; suffix: string }
type LoraFamily = 'qwen-2.1' | 'flux-3' | 'h3-image' | 'z-image-turbo'
interface LocalLora {
  id: string; label: string; path: string; scale?: number; family?: LoraFamily
  role?: 'identity' | 'style'; trigger?: string
}
interface LocalProfiles {
  models?: ImageModel[]
  encoders?: Record<string, LocalChoice[]>
  defaultEncoders?: Record<string, string>
  loras?: LocalLora[]
}
const configPath = process.env.LOCALLAB_IMAGE_PROFILES ?? join(MODELS, 'profiles.json')
const local: LocalProfiles = readProfile(configPath, {}, 'image-profiles')
const commands = new Set(['mflux-generate-qwen-2.1', 'mflux-generate-qwen-2.1-edit',
  'mflux-generate-flux3', 'mflux-generate-flux3-edit'])
export function localImageLoras(family: LoraFamily): LocalLora[] {
  return (Array.isArray(local.loras) ? local.loras : []).filter((lora) => lora && typeof lora.path === 'string' && (lora.family ?? 'flux-3') === family)
}
export function localImageLoraFile(path: string): string { return join(MODELS, path) }

function imageModel(spec: ImageModel): Adapter {
  const model = join(MODELS, spec.model)
  const bin = BIN(spec.command)
  const native = Boolean(spec.qwen && !spec.edit && nativeQwenConfigured)
  const family = spec.qwen ? 'qwen-2.1' : 'flux-3'
  const encoders = local.encoders?.[family] ?? []
  const defaultEncoder = local.defaultEncoders?.[family] ?? 'stock'
  if (defaultEncoder !== 'stock' && !encoders.some((e) => e.id === defaultEncoder)) {
    throw new Error(`Unknown default text encoder for ${family} in ${configPath}`)
  }
  const defaultModelPath = defaultEncoder === 'stock' ? model
    : model + encoders.find((e) => e.id === defaultEncoder)!.suffix
  // Existing unscoped profiles are FLUX 3 adapters. LoRAs are architecture-specific.
  const loras = localImageLoras(family)
  const encoder: ParamSpec = {
    key: 'encoder', label: 'Text encoder', type: 'select', default: defaultEncoder,
    options: [{ value: 'stock', label: 'Stock' }, ...encoders.map((e) => ({ value: e.id, label: e.label }))],
    help: 'Changes prompt encoding while retaining the image transformer and VAE.',
  }
  const precision: ParamSpec = spec.expandedInt8 ? { ...quantize,
    options: quantize.options?.map((option) => option.value === ''
      ? { ...option, label: 'BF16 (expanded INT8)' } : option),
    help: 'Retains the source INT8 approximation. Lower precision quantizes these expanded weights again.',
  } : quantize
  return {
    id: spec.id, label: spec.label, family, modality: 'image',
    notes: spec.notes ?? (spec.edit ? 'Instruction-based editing with up to ten reference images.'
      : `${spec.steps}-step generation. Local MLX on Apple Silicon.`),
    outputExt: 'png', acceptsImages: Boolean(spec.edit), requiresImage: Boolean(spec.edit),
    requires: [bin, join(model, 'transformer'), join(defaultModelPath, 'text_encoder'), join(model, 'vae'),
      ...(spec.presetLoras ?? []).map((lora) => join(MODELS, lora.path))],
    approxPeakGb: spec.qwen ? 46 : 32,
    params: [aspect, ...(native ? [qwenEngineParam] : []), ...(encoders.length ? [encoder] : []),
      ...(loras.length ? [{ key: 'lora', label: 'Image adapter', type: 'select', default: '',
        options: [{ value: '', label: 'Off' }, ...loras.map((l) => ({ value: l.id, label: l.label }))],
      } satisfies ParamSpec, { key: 'lora_scale', label: 'Adapter strength', type: 'float',
        default: 1, min: 0, max: 2, step: 0.05, advanced: true,
        help: 'Adjust the selected image adapter. Lower values give the prompt more freedom.',
      } satisfies ParamSpec] : []),
      ...(!spec.turbo ? [{ key: 'steps', label: 'Steps', type: 'int', default: spec.steps,
        min: 1, max: 60 } satisfies ParamSpec] : []), seed, ...(native ? [mfluxOnly(precision)] : [precision]),
      ...(spec.qwen && !spec.turbo ? [
        { key: 'guidance', label: 'Guidance', type: 'float', default: spec.guided ? 3 : 1,
          min: 1, max: 10, step: 0.5, advanced: true,
          help: 'Above 1 with a negative prompt adds a second pass per step.' } satisfies ParamSpec,
        { key: 'negative', label: 'Negative prompt', type: 'string',
          default: spec.guided ? 'blurry, low quality, artifacts' : '', advanced: true } satisfies ParamSpec,
      ] : []),
      ...(spec.stepReuse ? [{ key: 'step_cache_ratio', label: 'Step reuse', type: 'select',
        ...(native ? { visibleWhen: { key: 'image_engine', value: 'mflux' } } : {}),
        default: '', advanced: true, options: [{ value: '', label: 'Off' },
          { value: '0.25', label: '25% of steps' }, { value: '0.5', label: '50% of steps' }],
        help: 'Reuse previous predictions to speed generation. May reduce detail or change composition.',
      } satisfies ParamSpec] : []),
    ],
    build({ prompt, params, images, outPath }) {
      const useNative = native && usesNativeQwen(params)
      if (spec.edit && (!images.length || images.length > 10)) {
        throw new Error(`${spec.label} needs between one and ten reference images.`)
      }
      const selectedEncoder = params.encoder || defaultEncoder
      const choice = selectedEncoder !== 'stock'
        ? encoders.find((e) => e.id === selectedEncoder) : undefined
      if (selectedEncoder !== 'stock' && !choice) throw new Error('Unknown text encoder choice.')
      const path = choice ? model + choice.suffix : model
      if (!existsSync(join(path, 'text_encoder'))) {
        throw new Error(`Selected text encoder is not installed at ${path}. See the image setup instructions.`)
      }
      const [w, h] = sizes[String(params.aspect) as keyof typeof sizes] ?? sizes['1:1']
      const args = ['--model', path, '--base-model', spec.base]
      for (const lora of spec.presetLoras ?? []) {
        const file = join(MODELS, lora.path)
        if (!existsSync(file) || !Number.isFinite(lora.scale ?? 1)) {
          throw new Error('A profile image adapter is missing or invalid.')
        }
        args.push('--lora', file, String(lora.scale ?? 1))
      }
      if (spec.qwen && spec.presetLoras?.length) args.push('--no-bake-lora')
      if (params.lora) {
        const lora = loras.find((l) => l.id === params.lora)
        if (!lora) throw new Error('Unknown image adapter choice.')
        const file = join(MODELS, lora.path)
        if (!existsSync(file)) throw new Error('Selected image adapter is not installed.')
        if (!Number.isFinite(lora.scale ?? 1)) throw new Error('Invalid image adapter scale.')
        const strength = Number(params.lora_scale ?? 1)
        if (!Number.isFinite(strength) || strength < 0 || strength > 2) {
          throw new Error('Adapter strength must be between 0 and 2.')
        }
        args.push('--lora', file, String((lora.scale ?? 1) * strength))
        // Keep small identity updates intact rather than rounding them into BF16 weights.
        if (spec.qwen) args.push('--no-bake-lora')
      }
      if (spec.edit) args.push('--image-paths', ...images)
      args.push('--prompt', prompt, '--width', String(w), '--height', String(h),
        '--steps', String(spec.turbo ? 8 : params.steps ?? spec.steps), '--output', outPath)
      if (params.seed != null && params.seed !== '') args.push('--seed', String(params.seed))
      if (!useNative && params.quantize) args.push('--quantize', String(params.quantize))
      if (spec.qwen && !spec.turbo) {
        if (params.guidance != null) args.push('--guidance', String(params.guidance))
        if (params.negative) args.push('--negative-prompt', String(params.negative))
      }
      if (!useNative && spec.stepReuse && params.step_cache_ratio) {
        const ratio = String(params.step_cache_ratio)
        if (!['0.25', '0.5'].includes(ratio)) throw new Error('Choose a supported step reuse amount.')
        args.push('--step-cache-ratio', ratio)
      }
      return native ? qwenSpawn({ bin, args }, params) : { bin, args }
    },
  }
}

const seedvr2: Adapter = {
  id: 'seedvr2', label: 'SeedVR2 — upscale', family: 'upscale', modality: 'image',
  notes: 'Restore fine detail and enlarge an attached image. No prompt needed.',
  outputExt: 'png', acceptsImages: true, requiresImage: true, promptOptional: true,
  requires: [BIN('mflux-upscale-seedvr2'), join(SEEDVR2, 'seedvr2_ema_3b_fp16.safetensors'),
    join(SEEDVR2, 'ema_vae_fp16.safetensors')],
  params: [
    { key: 'resolution', label: 'Output size', type: 'select', default: '2x', options: [
      { value: '2x', label: '2× larger' }, { value: '3x', label: '3× larger' },
      { value: '1080', label: '1080 px shortest edge' }, { value: '2160', label: '2160 px shortest edge' },
    ] },
    { key: 'softness', label: 'Softness', type: 'float', default: 0, min: 0, max: 1, step: 0.05,
      help: '0 preserves the input most closely. Higher values soften before reconstruction.' }, seed,
  ],
  build({ params, images, outPath }) {
    if (images.length !== 1) throw new Error('SeedVR2 needs exactly one input image.')
    const resolution = String(params.resolution ?? '2x')
    if (!['2x', '3x', '1080', '2160'].includes(resolution)) throw new Error('Choose a supported output size.')
    const args = ['--model', SEEDVR2, '--image-path', images[0], '--resolution', resolution,
      '--softness', String(params.softness ?? 0), '--output', outPath]
    if (params.seed != null && params.seed !== '') args.push('--seed', String(params.seed))
    return { bin: BIN('mflux-upscale-seedvr2'), args }
  },
}

const stackSpecs: ImageModel[] = [
  { id: 'qwen-image-2.1-turbo', label: 'Qwen Image 2.1 Turbo', model: 'qwen-image-2.1-turbo',
    base: 'qwen-image-2.1-turbo', command: 'mflux-generate-qwen-2.1', steps: 8, turbo: true, qwen: true },
  { id: 'qwen-image-2.1-turbo-edit', label: 'Qwen Image 2.1 Turbo — edit', model: 'qwen-image-2.1-turbo',
    base: 'qwen-image-2.1-turbo', command: 'mflux-generate-qwen-2.1-edit', steps: 8, turbo: true, qwen: true, edit: true },
  { id: 'qwen-image-2.1-edit', label: 'Qwen Image 2.1 — edit', model: 'qwen-image-2.1',
    base: 'qwen-image-2.1', command: 'mflux-generate-qwen-2.1-edit', steps: 40, qwen: true, edit: true },
  { id: 'flux3-klein', label: 'FLUX 3 Image Klein', model: 'flux3-image-klein',
    base: 'flux3-image-klein', command: 'mflux-generate-flux3', steps: 16 },
  { id: 'flux3-klein-edit', label: 'FLUX 3 Image Klein — edit', model: 'flux3-image-klein',
    base: 'flux3-image-klein', command: 'mflux-generate-flux3-edit', steps: 16, edit: true },

]

const ids = new Set(stackSpecs.map(spec=>spec.id))
const invalid: Adapter[] = []
for (const spec of Array.isArray(local.models) ? local.models : []) {
  const id = spec?.id || 'unnamed-image-profile'
  if (ids.has(id)) { profileIssues.set('image-profiles','Duplicate image profile ID: '+id); continue }
  ids.add(id)
  if (!spec?.id || !spec.label || !spec.model || !commands.has(spec.command) || !spec.base ||
      !Number.isInteger(spec.steps) || spec.steps < 1 || spec.steps > 60) {
    invalid.push(unavailable(id,'image','Invalid image profile in '+configPath))
  } else stackSpecs.push(spec)
}
if (local.models && !Array.isArray(local.models)) profileIssues.set('image-profiles','Expected an array of image models.')
if (profileIssues.has('image-profiles')) invalid.push(unavailable('image-profiles','image',profileIssues.get('image-profiles')!))
export const imageStackAdapters: Adapter[] = [...stackSpecs.map((spec) => {
  try {
  const adapter = imageModel(spec)
  const edit = stackSpecs.find((candidate) => candidate.id === spec.id + '-edit'
    && candidate.edit && candidate.model === spec.model && candidate.base === spec.base
    && Boolean(candidate.qwen) === Boolean(spec.qwen)
    && JSON.stringify(candidate.presetLoras ?? []) === JSON.stringify(spec.presetLoras ?? []))
  if (!spec.edit && edit) adapter.imageEditAdapterId = edit.id
  return adapter
  } catch (error) { return unavailable(spec.id,'image',String(error)) }
}), seedvr2, ...invalid]
