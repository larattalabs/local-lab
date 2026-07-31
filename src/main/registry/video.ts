import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Adapter, RunContext } from './types'

const home = homedir()
const LTX_VENV = process.env.LOCALLAB_LTX_VENV ?? join(home, 'AI', 'venvs', 'ltx-av')
const LTX_PY = join(LTX_VENV, 'bin', 'python')
// mlx_video's DEFAULT repo is the older ltx2-mlx-av; the weights cached on this
// machine (and what VideoStuff runs daily) are the 2.3 repo. Omitting the flag
// therefore fails under offline mode even though the model is fully present.
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
  notes: 'Text-to-video or image-to-video, generates a matching audio track.',
  outputExt: 'mp4',
  approxPeakGb: 41,
  acceptsImages: true,
  requires: [LTX_PY],
  params: [
    { key: 'resolution', label: 'Resolution', type: 'select', default: '768x448',
      options: [
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
      help: 'Must be 8n+1 — the list is pre-filtered to valid values.' },
    { key: 'steps', label: 'Steps', type: 'int', default: 30, min: 4, max: 60 },
    { key: 'fps', label: 'FPS', type: 'int', default: 24, min: 8, max: 30, advanced: true },
    { key: 'seed', label: 'Seed', type: 'seed', default: 42 },
    { key: 'cfg', label: 'CFG scale', type: 'float', default: null, min: 0, max: 15, step: 0.5,
      advanced: true, help: 'Blank uses the model default.' },
    { key: 'negative', label: 'Negative prompt', type: 'string', default: '', advanced: true },
    { key: 'no_audio', label: 'Video only (skip audio)', type: 'bool', default: false,
      advanced: true, help: 'Faster — skips the audio VAE, vocoder and mux.' },
    { key: 'image_strength', label: 'Init image strength', type: 'float', default: null,
      min: 0, max: 1, step: 0.05, advanced: true,
      help: 'Only used when an image is attached.' },
  ],
  build({ prompt, params: p, outPath, images }: RunContext) {
    const [w, h] = String(p.resolution ?? '768x448').split('x').map(Number)
    const args = [
      '-m', 'mlx_video.generate_av',
      '--model-repo', LTX_MODEL_REPO,
      '--prompt', prompt,
      '--width', String(w), '--height', String(h),
      '--num-frames', String(p.frames ?? 97),
      '--steps', String(num(p, 'steps', 30)),
      '--fps', String(num(p, 'fps', 24)),
      '--output-path', outPath,
    ]
    if (p.seed != null && p.seed !== '') args.push('--seed', String(p.seed))
    if (p.cfg != null && p.cfg !== '') args.push('--cfg-scale', String(p.cfg))
    if (p.negative) args.push('--negative-prompt', String(p.negative))
    if (p.no_audio) args.push('--no-audio')
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
