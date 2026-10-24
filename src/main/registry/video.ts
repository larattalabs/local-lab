import { homedir } from 'node:os'
import { join } from 'node:path'
import { AI_ROOT } from '../env'
import type { Adapter, RunContext } from './types'

const home = homedir()
const LTX_VENV = process.env.LOCALLAB_LTX_VENV ?? join(home, 'AI', 'venvs', 'ltx-av')
const LTX_PY = join(LTX_VENV, 'bin', 'python')
// mlx_video's DEFAULT repo is the older ltx2-mlx-av; the weights cached on this
// machine (and what VideoStuff runs daily) are the 2.3 repo. Omitting the flag
// therefore fails under offline mode even though the model is fully present.
const LTX_ENCODER = process.env.LOCALLAB_LTX_ENCODER_DIR ?? join(AI_ROOT, 'video-stack', 'ltx-text-encoder')
const LTX_MODEL_REPO = process.env.LOCALLAB_LTX_MODEL_REPO ?? 'notapalindrome/ltx23-mlx-av'

function num(p: Record<string, unknown>, k: string, d: number): number {
  const v = p[k]
  return typeof v === 'number' && Number.isFinite(v) ? v : d
}

/**
 * LTX-2.3 audio+video, via `python -m mlx_video.generate_av`.
 *
 * Two hard constraints from the model, enforced in the param specs rather than
 * left to fail deep inside the sampler:
 *   - frame count must be 8n+1 (97, 121, 161, …)
 *   - width and height must both be multiples of 64
 */
const ltx: Adapter = {
  id: 'ltx-2.3',
  label: 'LTX-2.3 (audio + video)',
  modality: 'video',
  family: 'mlx-video',
  notes: 'Animate a starting image or generate from text. Video only is the faster default.',
  outputExt: 'mp4',
  approxPeakGb: 41,
  acceptsImages: true,
  requires: [LTX_PY, join(LTX_ENCODER, 'config.json')],
  params: [
    { key: 'resolution', label: 'Resolution', type: 'select', default: '768x448',
      options: [
        { value: '512x320', label: '512×320 (draft)' },
        { value: '512x512', label: '512×512 (square draft)' },
        { value: '768x768', label: '768×768 (square)' },
        { value: '320x512', label: '320×512 (portrait draft)' },
        { value: '768x448', label: '768×448 (fast)' },
        { value: '1024x576', label: '1024×576' },
        { value: '1216x704', label: '1216×704 (slow)' },
        { value: '448x768', label: '448×768 (portrait)' },
        { value: '576x1024', label: '576×1024 (portrait)' },
      ] },
    { key: 'frames', label: 'Frames', type: 'select', default: '97',
      options: [
        { value: '49', label: '49 (~2s)' }, { value: '97', label: '97 (~4s)' },
        { value: '121', label: '121 (~5s)' }, { value: '161', label: '161 (~6.7s)' },
        { value: '241', label: '241 (~10s)' },
      ],
      help: 'Approximate durations assume 24 FPS.' },
    { key: 'fps', label: 'FPS', type: 'int', default: 24, min: 8, max: 30, advanced: true },
    { key: 'seed', label: 'Seed', type: 'seed', default: 42 },
    { key: 'no_audio', label: 'Video only (skip audio)', type: 'bool', default: true,
      help: 'Skips audio decoding and muxing. Audio/video denoising still runs.' },
    { key: 'image_strength', label: 'Init image strength', type: 'float', default: null,
      min: 0, max: 1, step: 0.05, advanced: true,
      help: 'Only used when an image is attached.' },
  ],
  build({ prompt, params: p, outPath, images }: RunContext) {
    if (images.length > 1) throw new Error('This video model accepts one starting image.')
    const [w, h] = String(p.resolution ?? '768x448').split('x').map(Number)
    const frames = Number(p.frames ?? 97)
    const fps = num(p, 'fps', 24)
    if (![w, h].every((n) => Number.isInteger(n) && n >= 256 && n <= 1920 && n % 64 === 0)) {
      throw new Error('Choose dimensions from 256 to 1920, in multiples of 64.')
    }
    if (!Number.isInteger(frames) || frames < 9 || frames > 241 || (frames - 1) % 8 !== 0) {
      throw new Error('Choose a frame count of 8n+1, up to 241.')
    }
    if (fps < 8 || fps > 30) throw new Error('Choose FPS between 8 and 30.')
    if (p.image_strength != null && p.image_strength !== '' &&
      (!Number.isFinite(Number(p.image_strength)) || Number(p.image_strength) < 0 || Number(p.image_strength) > 1)) {
      throw new Error('Image strength must be between 0 and 1.')
    }
    const args = [
      '-m', 'mlx_video.generate_av',
      '--model-repo', LTX_MODEL_REPO,
      '--text-encoder-repo', LTX_ENCODER,
      '--prompt', prompt,
      '--width', String(w), '--height', String(h),
      '--num-frames', String(frames),
      '--fps', String(fps),
      '--output-path', outPath,
    ]
    if (p.seed != null && p.seed !== '') args.push('--seed', String(p.seed))
    if (p.no_audio !== false) args.push('--no-audio')
    if (images.length) {
      args.push('--image', images[0])
      if (p.image_strength != null && p.image_strength !== '') {
        args.push('--image-strength', String(p.image_strength))
      }
    }
    return { bin: LTX_PY, args }
  },
}

export const videoAdapters: Adapter[] = [ltx]
