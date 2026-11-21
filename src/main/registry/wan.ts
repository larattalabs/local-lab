import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { workerPath } from '../paths'
import type { ParamSpec } from '@shared/types'
import { AI_ROOT, RUNS_DIR } from '../env'
import { runtimeProfile } from './local-runtime'
import type { Adapter } from './types'

const runtime = runtimeProfile('wan22-i2v-a14b')
const root = runtime.model ?? join(AI_ROOT, 'video-stack', 'wan22-i2v-a14b-q8')
const python = join(AI_ROOT, 'venvs', 'ltx-av', 'bin', 'python')
const resolutions = ['512x512', '320x512', '512x320', '768x448', '448x768']
interface WanProfile { id: string; label: string; model: string; steps: number; guidance: number; shift?: number; draftSteps?: number }
const profilePath = process.env.LOCALLAB_WAN_PROFILES ?? join(AI_ROOT, 'video-stack', 'wan-profiles.json')
const profiles: { models?: WanProfile[] } = existsSync(profilePath) ? JSON.parse(readFileSync(profilePath, 'utf8')) : {}
function wan(lightning: boolean, profile?: WanProfile): Adapter {
  if (profile && (!profile.id || !profile.label || !isAbsolute(profile.model)
    || !Number.isInteger(profile.steps) || profile.steps < 1 || profile.steps > 50
    || (profile.draftSteps !== undefined && (!Number.isInteger(profile.draftSteps) || profile.draftSteps < 1 || profile.draftSteps >= profile.steps))
    || !Number.isFinite(profile.guidance) || profile.guidance < 1 || profile.guidance > 10
    || !Number.isFinite(profile.shift ?? 5) || (profile.shift ?? 5) <= 0)) {
    throw new Error(`Invalid local Wan profile in ${profilePath}`)
  }
  const model = profile?.model ?? root
  const worker = workerPath('wan_cached.py')
  const draftOptions: ParamSpec[] = profile?.draftSteps ? [{
    key: 'wan_quality', label: 'Render quality', type: 'select', default: 'standard',
    options: [{ value: 'standard', label: `Standard · ${profile.steps} steps` },
      { value: 'draft', label: `Draft · ${profile.draftSteps} steps` }],
  }] : []
  return {
    id: profile?.id ?? 'wan22-i2v-a14b' + (lightning ? '-lightning' : ''),
    label: profile?.label ?? 'Wan 2.2 A14B' + (lightning ? ' — Lightning' : ''), family: 'wan-mlx', modality: 'video',
    frameRate: 16, outputExt: 'mp4', acceptsImages: true, requiresImage: true, approxPeakGb: 90,
    notes: profile ? 'Local dual-expert image-to-video profile. Silent video at 16 FPS.' : lightning ? 'Four-step image-to-video with matching high/low-noise Lightning adapters. Silent video at 16 FPS.'
      : 'Dual-expert image-to-video. Forty steps; silent video at 16 FPS.',
    requires: [python, worker, ...(runtime.script ? [runtime.script] : []), join(model, 'local-lab-ready.json'), ...['config.json', 'high_noise_model.safetensors',
      'low_noise_model.safetensors', 't5_encoder.safetensors', 'vae.safetensors',
      ...(lightning ? ['lightning_high.safetensors', 'lightning_low.safetensors'] : [])].map((p) => join(model, p))],
    params: [...draftOptions, { key: 'resolution', label: 'Resolution', type: 'select', default: '512x512',
      options: resolutions.map((value) => ({ value, label: value.replace('x', '×') })) },
      { key: 'frames', label: 'Frames', type: 'select', default: '33',
        options: [17, 33, 49, 81].map((n) => ({ value: String(n), label: `${n} (~${(n / 16).toFixed(1)}s)` })),
        help: 'Wan uses 4n+1 frames at 16 FPS.' },
      { key: 'seed', label: 'Seed', type: 'seed', default: 42 }],
    build({ prompt, images, params, outPath }) {
      if (images.length !== 1) throw new Error('Wan A14B requires one starting image.')
      const resolution = String(params.resolution ?? '512x512')
      if (!resolutions.includes(resolution)) throw new Error('Choose a supported video resolution.')
      const [w, h] = resolution.split('x')
      const frames = Number(params.frames ?? 33)
      if (!Number.isInteger(frames) || frames < 17 || frames > 81 || (frames - 1) % 4) throw new Error('Wan requires 4n+1 frames from 17 to 81.')
      const quality = params.wan_quality ?? 'standard'
      if (quality !== 'standard' && !(quality === 'draft' && profile?.draftSteps)) {
        throw new Error('Unsupported Wan render quality.')
      }
      const steps = quality === 'draft' ? profile!.draftSteps! : profile?.steps ?? (lightning ? 4 : 40)
      const args = ['-u', worker, runtime.script ?? '-', '--model-dir', model, '--image', images[0],
        '--prompt', prompt, '--width', w, '--height', h, '--num-frames', String(frames),
        '--steps', String(steps), '--guide-scale', profile ? String(profile.guidance) : lightning ? '1' : '3.5,3.5',
        '--shift', String(profile?.shift ?? 5), '--scheduler', lightning || profile ? 'euler' : 'unipc', '--tiling', 'auto', '--output-path', outPath]
      if (lightning) args.push('--lora-high', join(model, 'lightning_high.safetensors'), '1',
        '--lora-low', join(model, 'lightning_low.safetensors'), '1')
      if (params.seed != null && params.seed !== '') {
        const seed = Number(params.seed)
        if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) throw new Error('Seed must be an unsigned 32-bit integer.')
        args.push('--seed', String(seed))
      }
      return { bin: python, args, env: { LOCALLAB_WAN_CACHE: join(RUNS_DIR, 'wan-cache') } }
    },
  }
}
export const wanAdapters = [wan(false), wan(true), ...(profiles.models ?? []).map((p) => wan(false, p))]
if (new Set(wanAdapters.map((a) => a.id)).size !== wanAdapters.length) throw new Error('Duplicate Wan profile IDs.')
