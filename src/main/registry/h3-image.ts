import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { AI_ROOT } from '../env'
import type { ParamSpec } from '@shared/types'
import { localImageLoras, localImageLoraFile } from './image-stack'
import { runtimeProfile } from './local-runtime'
import type { Adapter } from './types'

const runtime = runtimeProfile('minimax-h3-image')
const model = runtime.model ?? join(AI_ROOT, 'image-stack', 'h3-image')
const python = join(AI_ROOT, 'venvs', 'h3-image', 'bin', 'python')
const loras = runtime.script ? localImageLoras('h3-image') : []
const sizes: Record<string, [number, number]> = {
  '1:1': [2048, 2048], '3:4': [1824, 2432], '2:3': [1664, 2496], '3:2': [2496, 1664],
  '9:16': [1536, 2720], '16:9': [2720, 1536],
}

/** Dedicated image adapters and native reference conditioning can be combined. */
export const h3ImageAdapters: Adapter[] = [{
  id: 'minimax-h3-image', label: 'MiniMax H3 Image', family: 'h3-image', modality: 'image',
  outputExt: 'png', acceptsImages: true, approxPeakGb: 100,
  notes: 'Six-step generation or editing with up to sixteen references. Supply a full scene caption. Automatic prompt expansion is disabled.',
  requires: [python, join(model, 'model_index.json'), join(model, 'transformer', 'config.json'),
    join(model, 'vae', 'config.json'), join(model, 'text_encoder', 'config.json'), join(model, 'local-lab-ready.json'),
    ...(runtime.script ? [runtime.script] : [])],
  params: [{ key: 'aspect', label: 'Aspect', type: 'select', default: '1:1',
    options: Object.entries(sizes).map(([value, size]) => ({ value, label: `${value} (${size.join('×')})` })) },
    ...(loras.length ? [{ key: 'lora', label: 'Image adapter', type: 'select', default: '',
      options: [{ value: '', label: 'Off' }, ...loras.map((l) => ({ value: l.id, label: l.label }))],
    } satisfies ParamSpec, { key: 'lora_scale', label: 'Adapter strength', type: 'float',
      default: 1, min: 0, max: 2, step: 0.05, advanced: true,
      help: 'Adjust the selected image adapter. References can also be attached.',
    } satisfies ParamSpec] : []),
    { key: 'seed', label: 'Seed', type: 'seed', default: 42 }],
  build({ prompt, images, params, outPath }) {
    if (images.length > 16) throw new Error('H3 Image accepts up to sixteen reference images.')
    const size = sizes[String(params.aspect ?? '1:1')]
    if (!size) throw new Error('Choose a supported image aspect.')
    const args = runtime.script ? [runtime.script] : ['-m', 'mlx_vlm.generate']
    args.push('--output-modality', 'image', '--model', model,
      '--prompt', prompt, '--size', size.join('x'), '--output', outPath,
      '--gen-kwargs', JSON.stringify({ upsample_prompt: false }))
    if (params.lora) {
      const selected = loras.find((l) => l.id === params.lora)
      if (!selected) throw new Error('Unknown H3 Image adapter choice.')
      const file = localImageLoraFile(selected.path)
      if (!existsSync(file)) throw new Error('Selected image adapter is not installed.')
      const strength = Number(params.lora_scale ?? 1)
      const scale = selected.scale ?? 1
      if (!Number.isFinite(strength) || strength < 0 || strength > 2 || !Number.isFinite(scale)) {
        throw new Error('Adapter strength must be between 0 and 2.')
      }
      args.push('--lora', file, '--lora-scale', String(strength * scale))
    }
    if (images.length) args.push('--task', 'edit', '--image', ...images)
    if (params.seed != null && params.seed !== '') {
      const seed = Number(params.seed)
      if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) throw new Error('Seed must be an unsigned 32-bit integer.')
      args.push('--seed', String(seed))
    }
    return { bin: python, args }
  },
}]
