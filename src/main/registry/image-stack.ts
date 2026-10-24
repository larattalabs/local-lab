import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AI_ROOT } from '../env'
import type { ParamSpec } from '@shared/types'
import type { Adapter } from './types'

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
const encoder: ParamSpec = {
  key: 'encoder', label: 'Text encoder', type: 'select', default: 'stock',
  options: [{ value: 'stock', label: 'Stock' }, { value: 'heretic', label: 'Heretic (abliterated)' }],
  help: 'Changes prompt encoding. The image model and VAE stay the same.',
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
}

function imageModel(spec: ImageModel): Adapter {
  const model = join(MODELS, spec.model)
  const bin = BIN(spec.command)
  const precision: ParamSpec = spec.expandedInt8 ? { ...quantize,
    options: quantize.options?.map((option) => option.value === ''
      ? { ...option, label: 'BF16 (expanded INT8)' } : option),
    help: 'Retains the source INT8 approximation. Lower precision quantizes these expanded weights again.',
  } : quantize
  return {
    id: spec.id, label: spec.label, family: spec.qwen ? 'qwen-2.1' : 'flux-3', modality: 'image',
    notes: spec.notes ?? (spec.edit ? 'Instruction-based editing with up to ten reference images.'
      : `${spec.steps}-step generation. Local MLX on Apple Silicon.`),
    outputExt: 'png', acceptsImages: Boolean(spec.edit), requiresImage: Boolean(spec.edit),
    requires: [bin, join(model, 'transformer'), join(model, 'text_encoder'), join(model, 'vae')],
    approxPeakGb: spec.qwen ? 46 : 32,
    params: [aspect, ...(spec.qwen ? [encoder] : []),
      ...(!spec.turbo ? [{ key: 'steps', label: 'Steps', type: 'int', default: spec.steps,
        min: 1, max: 60 } satisfies ParamSpec] : []), seed, precision,
      ...(spec.qwen && !spec.turbo ? [
        { key: 'guidance', label: 'Guidance', type: 'float', default: spec.guided ? 3 : 1,
          min: 1, max: 10, step: 0.5, advanced: true,
          help: 'Above 1 with a negative prompt adds a second pass per step.' } satisfies ParamSpec,
        { key: 'negative', label: 'Negative prompt', type: 'string',
          default: spec.guided ? 'blurry, low quality, artifacts' : '', advanced: true } satisfies ParamSpec,
      ] : []),
      ...(spec.stepReuse ? [{ key: 'step_cache_ratio', label: 'Step reuse', type: 'select',
        default: '', advanced: true, options: [{ value: '', label: 'Off' },
          { value: '0.25', label: '25% of steps' }, { value: '0.5', label: '50% of steps' }],
        help: 'Reuse previous predictions to speed generation. May reduce detail or change composition.',
      } satisfies ParamSpec] : []),
    ],
    build({ prompt, params, images, outPath }) {
      if (spec.edit && (!images.length || images.length > 10)) {
        throw new Error(`${spec.label} needs between one and ten reference images.`)
      }
      const heretic = spec.qwen && params.encoder === 'heretic'
      const path = heretic ? `${model}-heretic` : model
      if (!existsSync(join(path, 'text_encoder'))) {
        throw new Error(`${heretic ? 'Heretic encoder' : spec.label} is not installed at ${path}. See the image setup instructions.`)
      }
      const [w, h] = sizes[String(params.aspect) as keyof typeof sizes] ?? sizes['1:1']
      const args = ['--model', path, '--base-model', spec.base]
      if (spec.edit) args.push('--image-paths', ...images)
      args.push('--prompt', prompt, '--width', String(w), '--height', String(h),
        '--steps', String(spec.turbo ? 8 : params.steps ?? spec.steps), '--output', outPath)
      if (params.seed != null && params.seed !== '') args.push('--seed', String(params.seed))
      if (params.quantize) args.push('--quantize', String(params.quantize))
      if (spec.qwen && !spec.turbo) {
        if (params.guidance != null) args.push('--guidance', String(params.guidance))
        if (params.negative) args.push('--negative-prompt', String(params.negative))
      }
      if (spec.stepReuse && params.step_cache_ratio) {
        const ratio = String(params.step_cache_ratio)
        if (!['0.25', '0.5'].includes(ratio)) throw new Error('Choose a supported step reuse amount.')
        args.push('--step-cache-ratio', ratio)
      }
      return { bin, args }
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

export const imageStackAdapters: Adapter[] = [
  imageModel({ id: 'qwen-image-2.1-turbo', label: 'Qwen Image 2.1 Turbo', model: 'qwen-image-2.1-turbo',
    base: 'qwen-image-2.1-turbo', command: 'mflux-generate-qwen-2.1', steps: 8, turbo: true, qwen: true }),
  imageModel({ id: 'qwen-image-2.1-turbo-edit', label: 'Qwen Image 2.1 Turbo — edit', model: 'qwen-image-2.1-turbo',
    base: 'qwen-image-2.1-turbo', command: 'mflux-generate-qwen-2.1-edit', steps: 8, turbo: true, qwen: true, edit: true }),
  imageModel({ id: 'qwen-image-2.1-edit', label: 'Qwen Image 2.1 — edit', model: 'qwen-image-2.1',
    base: 'qwen-image-2.1', command: 'mflux-generate-qwen-2.1-edit', steps: 40, qwen: true, edit: true }),
  imageModel({ id: 'noct-q-v4', label: 'Noct Q V4', model: 'noct-q-v4',
    base: 'qwen-image-2.1', command: 'mflux-generate-qwen-2.1', steps: 25, qwen: true, guided: true, expandedInt8: true, stepReuse: true,
    notes: 'Noctaluna’s Qwen 2.1 realism finetune. Published INT8 weights expanded to BF16. 25 steps.' }),
  imageModel({ id: 'noct-q-v4-edit', label: 'Noct Q V4 — edit', model: 'noct-q-v4',
    base: 'qwen-image-2.1', command: 'mflux-generate-qwen-2.1-edit', steps: 25, qwen: true, edit: true, guided: true, expandedInt8: true,
    notes: 'Noct Q reference editing. Published INT8 weights expanded to BF16. One to ten images.' }),
  imageModel({ id: 'flux3-klein', label: 'FLUX 3 Image Klein', model: 'flux3-image-klein',
    base: 'flux3-image-klein', command: 'mflux-generate-flux3', steps: 16 }),
  imageModel({ id: 'flux3-klein-edit', label: 'FLUX 3 Image Klein — edit', model: 'flux3-image-klein',
    base: 'flux3-image-klein', command: 'mflux-generate-flux3-edit', steps: 16, edit: true }),
  seedvr2,
]
