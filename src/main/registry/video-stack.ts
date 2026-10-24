import { existsSync, readFileSync } from 'node:fs'
import { randomInt } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { AI_ROOT } from '../env'
import type { ParamSpec } from '@shared/types'
import type { Adapter } from './types'

const ROOT = process.env.LOCALLAB_VIDEO_MODELS_DIR ?? join(AI_ROOT, 'video-stack')
const H3_BIN = process.env.LOCALLAB_H3_BIN ?? join(homedir(), 'Developer', 'labs', 'h3.c', 'h3')
const LTX_BIN = process.env.LOCALLAB_LTX_NEXT_BIN ?? join(AI_ROOT, 'venvs', 'ltx-next', 'bin', 'ltx-2-mlx')
const configPath = process.env.LOCALLAB_VIDEO_PROFILES ?? join(ROOT, 'profiles.json')

interface VideoProfile {
  id: string
  label: string
  engine: 'h3-native' | 'ltx-mlx'
  model: string
  binary?: string
  encoder?: string
  notes?: string
  steps?: number
  allowApproximation?: boolean
  diffusionDecoder?: boolean
  ltxVersion?: '2.3' | '2.5'
}

const local: { models?: VideoProfile[] } = existsSync(configPath)
  ? JSON.parse(readFileSync(configPath, 'utf8')) : {}
const pathFor = (path: string) => isAbsolute(path) ? path : join(ROOT, path)
const seed: ParamSpec = { key: 'seed', label: 'Seed', type: 'seed', default: 42 }
const resolution: ParamSpec = {
  key: 'resolution', label: 'Resolution', type: 'select', default: '768x448',
  options: ['512x320', '512x512', '320x512', '768x448', '448x768', '768x768', '1024x576', '576x1024']
    .map((value) => ({ value, label: value.replace('x', '×') })),
}

function integer(value: unknown, fallback: number, min: number, max: number, label: string): number {
  const n = Number(value ?? fallback)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be an integer from ${min} to ${max}.`)
  return n
}

function videoModel(spec: VideoProfile): Adapter {
  if (!spec.id || !spec.label || !spec.model || !['h3-native', 'ltx-mlx'].includes(spec.engine)
    || (spec.steps != null && (!Number.isInteger(spec.steps) || spec.steps < 1 || spec.steps > 50))) {
    throw new Error(`Invalid local video profile in ${configPath}`)
  }
  const h3 = spec.engine === 'h3-native'
  const model = pathFor(spec.model)
  const bin = spec.binary ? pathFor(spec.binary) : h3 ? H3_BIN : LTX_BIN
  const encoder = spec.encoder ? pathFor(spec.encoder) : undefined
  const ltx25 = spec.ltxVersion === '2.5'
  if ((!h3 && !ltx25 && !encoder) || (spec.ltxVersion && !['2.3', '2.5'].includes(spec.ltxVersion))
    || (spec.diffusionDecoder && (h3 || !ltx25)) || (ltx25 && encoder)) {
    throw new Error(`Invalid video encoder or version in ${configPath}`)
  }
  const ltxFiles = ['transformer-distilled.safetensors', 'connector.safetensors',
    'audio_vae.safetensors', 'vocoder.safetensors',
    ...(ltx25 ? ['vae_encoder_conv.safetensors', 'vae_decoder_conv.safetensors',
      'spatial_upscaler_x2_v1_0.safetensors', 'text_encoder.safetensors', 'text_encoder_config.json', 'tokenizer.json']
      : ['vae_encoder.safetensors', 'vae_decoder.safetensors', 'spatial_upscaler_x2_v1_1.safetensors']),
    ...(spec.diffusionDecoder ? ['vae_decoder_av.safetensors'] : []),
  ]
  const approximate = h3 && spec.allowApproximation !== false
  const frames = h3 ? [22, 56, 124, 243] : [49, 97, 121, 161, 241]
  return {
    id: spec.id, label: spec.label, modality: 'video', family: spec.engine,
    outputExt: 'mp4', acceptsImages: true, approxPeakGb: h3 ? 80 : 45,
    notes: spec.notes ?? (h3
      ? 'Native Metal. Generates sound at 24 FPS; layer thinning and prediction reuse trade fidelity for speed.'
      : 'Native MLX, distilled two-stage generation. Video only is the faster default.'),
    requires: [bin, join(model, 'local-lab-ready.json'),
      ...(h3 ? [join(dirname(bin), 'h3_shaders.metal'), join(model, 'FL2VA', 'transformer', 'config.json')]
        : [...ltxFiles.map((file) => join(model, file)), ...(encoder ? [join(encoder, 'config.json')] : [])])],
    params: [resolution,
      { key: 'frames', label: 'Frames', type: 'select', default: h3 ? '56' : '97',
        options: frames.map((n) => ({ value: String(n), label: `${n} (~${(n / 24).toFixed(1)}s)` })),
        help: h3 ? 'H3 uses 17n+5 frames at 24 FPS.' : 'LTX uses 8n+1 frames at 24 FPS.' },
      ...(h3 ? [{ key: 'steps', label: 'Steps', type: 'int', default: spec.steps ?? 20,
        min: 1, max: 50 } satisfies ParamSpec] : [
        { key: 'stage1_steps', label: 'First-stage steps', type: 'select', default: '8',
          options: [{ value: '8', label: '8 (quality)' }, { value: '6', label: '6' }, { value: '4', label: '4 (draft)' }],
          help: 'Fewer evaluations of the distilled schedule. Refinement uses three steps.' } satisfies ParamSpec,
        { key: 'no_audio', label: 'Video only (skip audio)', type: 'bool', default: true,
          help: 'Skips audio decoding and muxing; joint denoising still runs.' } satisfies ParamSpec,
      ]), seed,
      ...(spec.diffusionDecoder ? [
        { key: 'decoder', label: 'Video decoder', type: 'select', default: 'conv', advanced: true,
          options: [{ value: 'conv', label: 'Convolutional (fast)' },
            { value: 'diffusion', label: 'Diffusion (experimental)' }],
          help: 'The diffusion decoder can improve detail at extra time and memory cost.' } satisfies ParamSpec,
      ] : []),
      ...(approximate ? [
        { key: 'layers', label: 'Transformer layers', type: 'select', default: '45', advanced: true,
          options: [{ value: '50', label: '50 (all)' }, { value: '45', label: '45 (balanced)' }, { value: '40', label: '40 (draft)' }] } satisfies ParamSpec,
        { key: 'reuse', label: 'Prediction reuse', type: 'select', default: '2', advanced: true,
          options: [{ value: '1', label: 'Off' }, { value: '2', label: '2 (balanced)' }, { value: '3', label: '3 (draft)' }] } satisfies ParamSpec,
      ] : []),
    ],
    build({ prompt, params, images, outPath }) {
      if (images.length > 1) throw new Error('This video model accepts one starting image.')
      const size = String(params.resolution ?? resolution.default)
      if (!resolution.options?.some((o) => o.value === size)) throw new Error('Choose a supported video resolution.')
      const [w, h] = size.split('x')
      const count = integer(params.frames, h3 ? 56 : 97, h3 ? 22 : 9, h3 ? 243 : 241, 'Frames')
      if ((count - (h3 ? 5 : 1)) % (h3 ? 17 : 8) !== 0) {
        throw new Error(h3 ? 'H3 requires 17n+5 frames.' : 'LTX requires 8n+1 frames.')
      }
      const chosenSeed = params.seed === null || params.seed === '' ? randomInt(0, 4294967296)
        : integer(params.seed, 42, 0, 4294967295, 'Seed')
      if (h3) {
        const steps = integer(params.steps, spec.steps ?? 20, 1, 50, 'Steps')
        const layers = approximate ? integer(params.layers, 45, 40, 50, 'Layers') : 50
        const reuse = approximate ? integer(params.reuse, 2, 1, 3, 'Prediction reuse') : 1
        if (![40, 45, 50].includes(layers)) throw new Error('Choose 40, 45 or 50 transformer layers.')
        const args = ['-d', model, '-p', prompt, '--width', w, '--height', h, '--frames', String(count),
          '--steps', String(steps), '--layers', String(layers), '--reuse', String(reuse),
          '--seed', String(chosenSeed), '--profile', '-o', outPath]
        if (images.length) args.push('--first-frame', images[0])
        return { bin, args, cwd: dirname(bin) }
      }
      const steps = integer(params.stage1_steps, 8, 4, 8, 'First-stage steps')
      if (![4, 6, 8].includes(steps)) throw new Error('Choose 4, 6 or 8 first-stage steps.')
      const args = ['generate', '--model', model, '--prompt', prompt, '--distilled', '--width', w,
        '--height', h, '--frames', String(count), '--frame-rate', '24', '--seed', String(chosenSeed),
        '--stage1-steps', String(steps), '--stage2-steps', '3', '--output', outPath]
      if (encoder) args.push('--gemma', encoder)
      const decoder = String(params.decoder ?? 'conv')
      if (decoder !== 'conv' && (decoder !== 'diffusion' || !spec.diffusionDecoder)) {
        throw new Error('Choose a video decoder supported by this model.')
      }
      if (spec.diffusionDecoder) args.push('--video-decoder', decoder)
      if (params.no_audio !== false) args.push('--no-audio')
      if (images.length) args.push('--image', images[0], '0', '1.0')
      return { bin, args }
    },
  }
}

export const videoStackAdapters: Adapter[] = [
  videoModel({ id: 'minimax-h3', label: 'MiniMax H3', engine: 'h3-native', model: 'h3-stock' }),
  videoModel({ id: 'ltx-2.5', label: 'LTX-2.5', engine: 'ltx-mlx', model: 'ltx-2.5', ltxVersion: '2.5', diffusionDecoder: true }),
  ...(local.models ?? []).map(videoModel),
]
if (new Set(videoStackAdapters.map((a) => a.id)).size !== videoStackAdapters.length) {
  throw new Error(`Duplicate video profile IDs in ${configPath}`)
}
