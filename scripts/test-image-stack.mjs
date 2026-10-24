import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadImageAdapters } from './image-adapters.mjs'

const root = mkdtempSync(join(tmpdir(), 'local-lab-image-contract-'))
process.env.LOCALLAB_IMAGE_MODELS_DIR = root
for (const name of ['qwen-image-2.1-turbo', 'qwen-image-2.1', 'flux3-image-klein', 'noct-q-v4']) {
  mkdirSync(join(root, name, 'text_encoder'), { recursive: true })
}
mkdirSync(join(root, 'qwen-image-2.1-turbo-heretic', 'text_encoder'), { recursive: true })
try {
  const adapters = await loadImageAdapters()
  const get = (id) => { const a = adapters.find((x) => x.id === id); assert(a, id); return a }
  const context = { prompt: 'A sign reading OPEN', images: [], params: {}, outPath: join(root, 'out.png') }
  let spec = get('qwen-image-2.1-turbo').build(context)
  assert.equal(spec.args[spec.args.indexOf('--steps') + 1], '8')
  assert.equal(spec.args[spec.args.indexOf('--base-model') + 1], 'qwen-image-2.1-turbo')
  spec = get('qwen-image-2.1-turbo').build({ ...context, params: { encoder: 'heretic' } })
  assert.equal(spec.args[1], join(root, 'qwen-image-2.1-turbo-heretic'))
  assert.throws(() => get('qwen-image-2.1-edit').build({ ...context,
    images: ['a.png'], params: { encoder: 'heretic' } }), /Heretic encoder is not installed/)
  for (const id of ['qwen-image-2.1-turbo-edit', 'qwen-image-2.1-edit', 'flux3-klein-edit']) {
    assert.throws(() => get(id).build(context), /between one and ten/)
    assert.throws(() => get(id).build({ ...context, images: Array(11).fill('a.png') }), /between one and ten/)
    spec = get(id).build({ ...context, images: ['photo with spaces.png', 'second.png'] })
    const at = spec.args.indexOf('--image-paths')
    assert.deepEqual(spec.args.slice(at + 1, at + 3), ['photo with spaces.png', 'second.png'])
  }
  const upscale = get('seedvr2')
  assert.equal(upscale.promptOptional, true)
  assert.throws(() => upscale.build(context), /exactly one/)
  spec = upscale.build({ ...context, prompt: '', images: ['source.png'], params: { resolution: '2x' } })
  assert(!spec.args.includes('--prompt'))
  assert(!spec.args.includes('--width'))
  assert.equal(spec.args[spec.args.indexOf('--resolution') + 1], '2x')
  assert.throws(() => upscale.build({ ...context, images: ['a.png'], params: { resolution: 'bad' } }), /supported output size/)
  const noct = get('noct-q-v4')
  assert(!noct.build(context).args.includes('--step-cache-ratio'))
  spec = noct.build({ ...context, params: { step_cache_ratio: '0.5' } })
  assert.equal(spec.args[spec.args.indexOf('--step-cache-ratio') + 1], '0.5')
  assert.throws(() => noct.build({ ...context, params: { step_cache_ratio: 'bad' } }), /supported step reuse/)
  assert(!get('noct-q-v4-edit').params.some((p) => p.key === 'step_cache_ratio'))
  assert.equal(new Set(adapters.map((a) => a.id)).size, adapters.length)
  console.log('Image adapter contracts passed: Turbo, Heretic, references, upscale, opt-in Noct step reuse and registry IDs.')
} finally { rmSync(root, { recursive: true }) }
