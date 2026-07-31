import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Adapter, RunContext } from './types'
import type { ParamSpec } from '@shared/types'

const home = homedir()
const KREA2_DIR = process.env.LOCALLAB_KREA2_DIR ?? join(home, 'AI', 'krea2-mlx')
const KREA2_PY = join(KREA2_DIR, '.venv', 'bin', 'python')
const BIN = (name: string) => join(home, '.local', 'bin', name)

/** Dimensions must be multiples of 64 for these models. */
export const ASPECTS: Record<string, [number, number]> = {
  '1:1': [1024, 1024],
  '16:9': [1536, 832],
  '9:16': [832, 1536],
  '3:2': [1216, 832],
  '2:3': [832, 1216],
  '4:3': [1152, 896],
  '21:9': [1536, 640],
}

const aspectParam: ParamSpec = {
  key: 'aspect',
  label: 'Aspect',
  type: 'select',
  default: '16:9',
  options: Object.keys(ASPECTS).map((v) => ({ value: v, label: `${v} (${ASPECTS[v].join('×')})` })),
}

const seedParam: ParamSpec = {
  key: 'seed',
  label: 'Seed',
  type: 'seed',
  default: null,
  help: 'Blank = random each run. Fix it to compare models on equal footing.',
}

function dims(params: Record<string, unknown>): [number, number] {
  const a = String(params.aspect ?? '16:9')
  return ASPECTS[a] ?? ASPECTS['16:9']
}

function num(params: Record<string, unknown>, key: string, fallback: number): number {
  const v = params[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

// ---------------------------------------------------------------------------
// Krea 2 — its own MLX repo. Positional prompt, `--out`, and it must run with
// cwd set to the repo root (generate.py resolves weights relative to itself).
// ---------------------------------------------------------------------------

const krea2: Adapter = {
  id: 'krea2',
  label: 'Krea 2',
  modality: 'image',
  family: 'krea2',
  notes: '12.9B, aesthetic-first, 8-step distilled. Painterly and photographic both.',
  outputExt: 'png',
  approxPeakGb: 18,
  acceptsImages: true,
  requires: [KREA2_PY, join(KREA2_DIR, 'generate.py')],
  params: [
    aspectParam,
    { key: 'steps', label: 'Steps', type: 'int', default: 8, min: 1, max: 50,
      help: 'Distilled — 8 is the tuned default. More is slower, rarely sharper.' },
    seedParam,
    { key: 'precision', label: 'Precision', type: 'select', default: '8bit', advanced: true,
      options: [
        { value: '8bit', label: '8-bit (near-lossless, default)' },
        { value: 'mixed-4-8', label: 'mixed 4/8 (smaller)' },
        { value: 'bf16', label: 'bf16 (reference)' },
      ] },
    { key: 'strength', label: 'img2img strength', type: 'float', default: 0.6,
      min: 0.05, max: 1, step: 0.05, advanced: true,
      help: 'Only when an init image is attached. Higher = further from the input. ' +
            'Krea has no identity-reference mode — an init image constrains COMPOSITION.' },
  ],
  build({ prompt, params, outPath, images }: RunContext) {
    const [w, h] = dims(params)
    const args = [
      'generate.py', prompt,
      '--precision', String(params.precision ?? '8bit'),
      '--steps', String(num(params, 'steps', 8)),
      '--width', String(w), '--height', String(h),
      '--out', outPath,
    ]
    // generate.py defaults --seed to 0, so omitting it does NOT randomize —
    // it silently reproduces the same image every "random" run. Inject one.
    const seed = params.seed != null && params.seed !== ''
      ? String(params.seed)
      : String(Math.floor(Math.random() * 2 ** 31))
    args.push('--seed', seed)
    if (images.length) {
      args.push('--init-image', images[0], '--strength', String(num(params, 'strength', 0.6)))
    }
    return { bin: KREA2_PY, args, cwd: KREA2_DIR }
  },
}

// ---------------------------------------------------------------------------
// mflux — one CLI per model family, uniform flags: --prompt / --output.
// ---------------------------------------------------------------------------

interface MfluxSpec {
  id: string
  label: string
  bin: string
  baseModel?: string
  notes: string
  defaultSteps: number
  approxPeakGb?: number
  quantize?: string
  /** Uses --image-paths (variadic reference images) rather than --image-path. */
  multiImage?: boolean
  /** Uses --image-path + --image-strength (img2img / single-ref edit). */
  singleImage?: boolean
  /** CLI refuses to run without an input image (editing/variation models). */
  requiresImage?: boolean
  /** Override the image flag when a CLI invents its own (redux). */
  imageFlag?: string
  /** Override the strength flag; null = the CLI has no strength option. */
  strengthFlag?: string | null
}

const MFLUX: MfluxSpec[] = [
  { id: 'flux2-klein-4b', label: 'FLUX.2 Klein 4B', bin: 'mflux-generate-flux2',
    baseModel: 'flux2-klein-4b', notes: 'Fast 4B FLUX.2. Strong prompt adherence.',
    defaultSteps: 8, approxPeakGb: 20, quantize: '8' },
  { id: 'flux2-klein-9b', label: 'FLUX.2 Klein 9B', bin: 'mflux-generate-flux2',
    baseModel: 'flux2-klein-9b', notes: 'Larger FLUX.2 — better detail, more memory.',
    defaultSteps: 8, approxPeakGb: 36, quantize: '8' },
  { id: 'flux2-edit', label: 'FLUX.2 Klein 4B — edit', bin: 'mflux-generate-flux2-edit',
    baseModel: 'flux2-klein-4b',
    notes: 'Multi-image REFERENCE conditioning: keeps a subject across new scenes.',
    defaultSteps: 8, approxPeakGb: 20, quantize: '8', multiImage: true, requiresImage: true },
  { id: 'flux-dev', label: 'FLUX.1 dev', bin: 'mflux-generate', baseModel: 'dev',
    notes: 'The classic FLUX.1 dev. Needs ~20-25 steps.', defaultSteps: 20, approxPeakGb: 24 },
  { id: 'flux-schnell', label: 'FLUX.1 schnell', bin: 'mflux-generate', baseModel: 'schnell',
    notes: 'Distilled FLUX.1 — 2-4 steps, very fast.', defaultSteps: 4, approxPeakGb: 24 },
  { id: 'flux-krea-dev', label: 'FLUX.1 Krea dev', bin: 'mflux-generate', baseModel: 'krea-dev',
    notes: "Krea's FLUX.1 finetune — less of the default 'AI look'.",
    defaultSteps: 20, approxPeakGb: 24 },
  { id: 'kontext', label: 'FLUX.1 Kontext', bin: 'mflux-generate-kontext',
    notes: 'In-context editing from a single image + instruction.',
    defaultSteps: 20, approxPeakGb: 24, singleImage: true, requiresImage: true },
  { id: 'qwen-image', label: 'Qwen Image', bin: 'mflux-generate-qwen',
    notes: 'Strong at rendering legible text inside images.',
    defaultSteps: 20, approxPeakGb: 28 },
  // qwen-edit takes --image-paths (variadic, REQUIRED) and has no strength
  // flag — verified against the installed CLI, not assumed from its siblings.
  { id: 'qwen-image-edit', label: 'Qwen Image Edit', bin: 'mflux-generate-qwen-edit',
    notes: 'Instruction-driven editing with identity preservation.',
    defaultSteps: 20, approxPeakGb: 28, multiImage: true, requiresImage: true },
  { id: 'z-image-turbo', label: 'Z-Image Turbo', bin: 'mflux-generate-z-image-turbo',
    notes: 'Very fast turbo model.', defaultSteps: 8, approxPeakGb: 14 },
  { id: 'z-image', label: 'Z-Image', bin: 'mflux-generate-z-image',
    notes: 'Full Z-Image.', defaultSteps: 20, approxPeakGb: 16 },
  { id: 'fibo', label: 'FIBO', bin: 'mflux-generate-fibo',
    notes: 'Structured-prompt model — responds to long, detailed descriptions.',
    defaultSteps: 20, approxPeakGb: 20 },
  { id: 'fibo-edit', label: 'FIBO Edit', bin: 'mflux-generate-fibo-edit',
    notes: 'FIBO editing variant.', defaultSteps: 20, approxPeakGb: 20, singleImage: true },
  { id: 'ernie-image-turbo', label: 'ERNIE Image Turbo', bin: 'mflux-generate-ernie-image-turbo',
    notes: "Baidu's ERNIE image model, turbo variant.", defaultSteps: 8, approxPeakGb: 18 },
  { id: 'ideogram4', label: 'Ideogram 4', bin: 'mflux-generate-ideogram4',
    notes: 'Typography-focused generation.', defaultSteps: 20, approxPeakGb: 20 },
  // redux invented its own flag names: --redux-image-paths / --redux-image-strengths.
  { id: 'redux', label: 'FLUX.1 Redux', bin: 'mflux-generate-redux',
    notes: 'Image variation — riff on an input image.',
    defaultSteps: 20, approxPeakGb: 24, multiImage: true, requiresImage: true,
    imageFlag: '--redux-image-paths', strengthFlag: '--redux-image-strengths' },
]

function mfluxAdapter(spec: MfluxSpec): Adapter {
  const bin = BIN(spec.bin)
  const params: ParamSpec[] = [
    aspectParam,
    { key: 'steps', label: 'Steps', type: 'int', default: spec.defaultSteps, min: 1, max: 60 },
    seedParam,
    { key: 'guidance', label: 'Guidance', type: 'float', default: null,
      min: 0, max: 20, step: 0.5, advanced: true,
      help: 'Blank uses the model default.' },
    { key: 'quantize', label: 'Quantize', type: 'select', default: spec.quantize ?? '', advanced: true,
      options: [
        { value: '', label: 'none (full precision)' },
        { value: '8', label: '8-bit' }, { value: '6', label: '6-bit' },
        { value: '4', label: '4-bit' }, { value: '3', label: '3-bit' },
      ] },
  ]
  if ((spec.singleImage && spec.strengthFlag !== null) || spec.strengthFlag) {
    params.push({ key: 'image_strength', label: 'Image strength', type: 'float',
      default: 0.4, min: 0, max: 1, step: 0.05,
      help: 'How strongly the input image constrains the result. 0 = ignore it.' })
  }
  return {
    id: spec.id,
    label: spec.label,
    modality: 'image',
    family: 'mflux',
    notes: spec.notes,
    outputExt: 'png',
    approxPeakGb: spec.approxPeakGb,
    acceptsImages: Boolean(spec.multiImage || spec.singleImage),
    requiresImage: spec.requiresImage,
    requires: [bin],
    params,
    build({ prompt, params: p, outPath, images }: RunContext) {
      const [w, h] = dims(p)
      const args: string[] = []
      if (spec.baseModel) args.push('--base-model', spec.baseModel)
      const q = String(p.quantize ?? spec.quantize ?? '')
      if (q) args.push('-q', q)

      // Reference images must precede --prompt for the variadic form: any
      // token after `--image-paths a b c` would otherwise be swallowed as
      // another path.
      if (spec.multiImage && images.length) {
        args.push(spec.imageFlag ?? '--image-paths', ...images)
        if (spec.strengthFlag) {
          args.push(spec.strengthFlag,
            ...images.map(() => String(num(p, 'image_strength', 0.4))))
        }
      } else if (spec.singleImage && images.length) {
        args.push(spec.imageFlag ?? '--image-path', images[0])
        if (spec.strengthFlag !== null) {
          args.push(spec.strengthFlag ?? '--image-strength',
            String(num(p, 'image_strength', 0.4)))
        }
      }

      args.push('--prompt', prompt,
        '--width', String(w), '--height', String(h),
        '--steps', String(num(p, 'steps', spec.defaultSteps)),
        '--output', outPath)
      if (p.seed != null && p.seed !== '') args.push('--seed', String(p.seed))
      if (p.guidance != null && p.guidance !== '') args.push('--guidance', String(p.guidance))
      return { bin, args }
    },
  }
}

export const imageAdapters: Adapter[] = [krea2, ...MFLUX.map(mfluxAdapter)]
