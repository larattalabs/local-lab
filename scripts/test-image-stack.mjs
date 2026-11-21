import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadImageAdapters } from './image-adapters.mjs'

const root = mkdtempSync(join(tmpdir(), 'local-lab-image-contract-'))
process.env.LOCALLAB_IMAGE_MODELS_DIR = root
process.env.LOCALLAB_RUNTIME_PROFILES = join(root, 'runtime-profiles.json')
process.env.LOCALLAB_QWEN_RUNTIME = join(root, 'no-native-runtime.json')
writeFileSync(process.env.LOCALLAB_RUNTIME_PROFILES, JSON.stringify({ models: {
  'qwen-image-2.1': { model: join(root, 'qwen-image-2.1-alternate') },
  'minimax-h3-image': { script: join(root, 'h3-runtime.py') },
} }))
for (const name of ['qwen-image-2.1-turbo', 'qwen-image-2.1', 'flux3-image-klein', 'qwen-local']) {
  mkdirSync(join(root, name, 'text_encoder'), { recursive: true })
}
mkdirSync(join(root, 'qwen-image-2.1-turbo-alternate', 'text_encoder'), { recursive: true })
writeFileSync(join(root, 'photo.safetensors'), '')
writeFileSync(join(root, 'identity.safetensors'), '')
writeFileSync(join(root, 'h3-identity.safetensors'), '')
writeFileSync(join(root, 'profile.safetensors'), '')
writeFileSync(join(root, 'profiles.json'), JSON.stringify({
  models: [false, true].map((edit) => ({ id: 'qwen-local' + (edit ? '-edit' : ''), label: 'Local Qwen',
    model: 'qwen-local', base: 'qwen-image-2.1', command: 'mflux-generate-qwen-2.1' + (edit ? '-edit' : ''),
    steps: 25, qwen: true, edit, stepReuse: !edit, presetLoras: [{ path: 'profile.safetensors', scale: 0.7 }] })),
  encoders: { 'qwen-2.1': [{ id: 'alternate', label: 'Alternate', suffix: '-alternate' }] },
  loras: [{ id: 'photo', label: 'Photo style', path: 'photo.safetensors', scale: 0.75 },
    { id: 'identity', label: 'Character', path: 'identity.safetensors', family: 'qwen-2.1' },
    { id: 'z-subject', label: 'Subject', family: 'z-image-turbo', role: 'identity', path: 'identity.safetensors', trigger: 'example_id' },
    { id: 'z-style', label: 'Style', family: 'z-image-turbo', role: 'style', path: 'photo.safetensors' },
    { id: 'h3-identity', label: 'H3 character', path: 'h3-identity.safetensors', family: 'h3-image' }],
}))
try {
  const adapters = await loadImageAdapters()
  const get = (id) => { const a = adapters.find((x) => x.id === id); assert(a, id); return a }
  for (const [gen, editor] of [
    ['qwen-image-2.1-turbo', 'qwen-image-2.1-turbo-edit'],
    ['qwen-local', 'qwen-local-edit'], ['flux3-klein', 'flux3-klein-edit'],
    ['qwen-image-2.1', 'qwen-image-2.1-edit'],
  ]) {
    assert.equal(get(gen).imageEditAdapterId, editor)
    assert(get(editor).acceptsImages)
    assert(!get(editor).imageEditAdapterId)
  }
  const context = { prompt: 'A sign reading OPEN', images: [], params: {}, outPath: join(root, 'out.png') }
  const z = get('z-image-turbo')
  assert.deepEqual(z.params.find(p => p.key === 'lora').options.map(o => o.value), ['', 'z-subject'])
  assert.deepEqual(z.params.find(p => p.key === 'visual_style').options.map(o => o.value), ['', 'z-style'])
  assert(!z.build(context).args.includes('--lora'))
  const paired = { lora: 'z-subject', visual_style: 'z-style', visual_style_scale: 0.7 }
  const combined = z.build({ ...context, params: paired }).args
  assert.deepEqual(combined.slice(combined.indexOf('--lora'), combined.indexOf('--prompt')),
    ['--lora', join(root, 'identity.safetensors'), '1', '--lora', join(root, 'photo.safetensors'), '0.7'])
  assert.equal(combined[combined.indexOf('--prompt') + 1], 'example_id, ' + context.prompt)
  const alreadyTagged = z.build({ ...context, params: paired, prompt: 'EXAMPLE_ID near a window' }).args
  assert.equal(alreadyTagged[alreadyTagged.indexOf('--prompt') + 1], 'EXAMPLE_ID near a window')
  const styleOnly = z.build({ ...context, params: { ...paired, lora_scale: 0 } }).args
  assert.equal(styleOnly.filter(arg => arg === '--lora').length, 1)
  assert.equal(styleOnly[styleOnly.indexOf('--prompt') + 1], context.prompt)
  assert.throws(() => z.build({ ...context, params: { visual_style: 'z-subject' } }), /Unknown visual style/)
  assert.throws(() => z.build({ ...context, params: { ...paired, lora_scale: 3 } }), /strength/)
  let spec = get('qwen-image-2.1-turbo').build(context)
  assert.equal(spec.args[spec.args.indexOf('--steps') + 1], '8')
  assert.equal(spec.args[spec.args.indexOf('--base-model') + 1], 'qwen-image-2.1-turbo')
  spec = get('qwen-image-2.1-turbo').build({ ...context, params: { encoder: 'alternate' } })
  assert.equal(spec.args[1], join(root, 'qwen-image-2.1-turbo-alternate'))
  assert.throws(() => get('qwen-image-2.1-edit').build({ ...context,
    images: ['a.png'], params: { encoder: 'alternate' } }), /Selected text encoder is not installed/)
  for (const id of ['qwen-image-2.1-turbo-edit', 'qwen-image-2.1-edit', 'flux3-klein-edit']) {
    assert.throws(() => get(id).build(context), /between one and ten/)
    assert.throws(() => get(id).build({ ...context, images: Array(11).fill('a.png') }), /between one and ten/)
    spec = get(id).build({ ...context, images: ['photo with spaces.png', 'second.png'] })
    const at = spec.args.indexOf('--image-paths')
    assert.deepEqual(spec.args.slice(at + 1, at + 3), ['photo with spaces.png', 'second.png'])
  }
  spec = get('flux3-klein').build({ ...context, params: { lora: 'photo' } })
  assert.deepEqual(spec.args.slice(spec.args.indexOf('--lora') + 1, spec.args.indexOf('--lora') + 3),
    [join(root, 'photo.safetensors'), '0.75'])
  assert.throws(() => get('flux3-klein').build({ ...context, params: { lora: 'missing' } }), /Unknown image adapter/)
  assert.throws(() => get('flux3-klein').build({ ...context, params: { lora: 'identity' } }), /Unknown image adapter/)
  for (const id of ['qwen-image-2.1-edit', 'qwen-local', 'qwen-local-edit']) {
    const input = { ...context, images: id.endsWith('-edit') ? ['reference.png'] : [] }
    assert.throws(() => get(id).build({ ...input, params: { lora: 'photo' } }), /Unknown image adapter/)
    const choices = get(id).params.find((p) => p.key === 'lora').options.map((o) => o.value)
    assert.deepEqual(choices, ['', 'identity'])
    spec = get(id).build({ ...input, params: { lora: 'identity', lora_scale: 0.8 } })
    const at = spec.args.lastIndexOf('--lora')
    assert.deepEqual(spec.args.slice(at + 1, at + 3), [join(root, 'identity.safetensors'), '0.8'])
    assert(spec.args.includes('--no-bake-lora'))
    for (const strength of [-1, 3, 'bad', Infinity]) {
      assert.throws(() => get(id).build({ ...input, params: { lora: 'identity', lora_scale: strength } }),
        /Adapter strength must be between/)
    }
  }
  spec = get('flux3-klein').build({ ...context, params: { lora: 'photo', lora_scale: 0.8 } })
  assert.equal(Number(spec.args[spec.args.indexOf('--lora') + 2]), 0.75 * 0.8)
  assert(!spec.args.includes('--no-bake-lora'))
  assert.throws(() => get('qwen-image-2.1-turbo').build({ ...context, params: { encoder: 'missing' } }), /Unknown text encoder/)
  const upscale = get('seedvr2')
  assert.equal(upscale.promptOptional, true)
  assert.throws(() => upscale.build(context), /exactly one/)
  spec = upscale.build({ ...context, prompt: '', images: ['source.png'], params: { resolution: '2x' } })
  assert(!spec.args.includes('--prompt'))
  assert(!spec.args.includes('--width'))
  assert.equal(spec.args[spec.args.indexOf('--resolution') + 1], '2x')
  assert.throws(() => upscale.build({ ...context, images: ['a.png'], params: { resolution: 'bad' } }), /supported output size/)
  const h3 = get('minimax-h3-image')
  spec = h3.build({ ...context, images: ['portrait with spaces.png'], params: { aspect: '2:3', seed: 73 } })
  assert(spec.args.includes('--task'))
  assert.equal(spec.args[spec.args.indexOf('--task') + 1], 'edit')
  assert.equal(spec.args[spec.args.indexOf('--size') + 1], '1664x2496')
  assert.deepEqual(JSON.parse(spec.args[spec.args.indexOf('--gen-kwargs') + 1]), { upsample_prompt: false })
  assert.throws(() => h3.build({ ...context, images: Array(17).fill('ref.png') }), /up to sixteen/)
  assert.throws(() => h3.build({ ...context, params: { seed: -1 } }), /unsigned 32-bit/)
  const h3Choices = h3.params.find((p) => p.key === 'lora').options.map((o) => o.value)
  assert.deepEqual(h3Choices, ['', 'h3-identity'])
  spec = h3.build({ ...context, images: ['face reference.png'], params: { lora: 'h3-identity', lora_scale: 0.7 } })
  assert.equal(spec.args[0], join(root, 'h3-runtime.py'))
  assert.equal(spec.args[spec.args.indexOf('--lora') + 1], join(root, 'h3-identity.safetensors'))
  assert.equal(spec.args[spec.args.indexOf('--lora-scale') + 1], '0.7')
  assert(spec.args.includes('face reference.png'))
  assert.throws(() => h3.build({ ...context, params: { lora: 'identity' } }), /Unknown H3 Image adapter/)
  for (const strength of [-1, 3, 'bad', Infinity]) {
    assert.throws(() => h3.build({ ...context, params: { lora: 'h3-identity', lora_scale: strength } }), /Adapter strength/)
  }
  const profile = get('qwen-local')
  spec = profile.build({ ...context, params: { lora: 'identity', lora_scale: 0.8 } })
  const flags = spec.args.flatMap((v, i) => v === '--lora' ? [i] : [])
  assert.equal(flags.length, 2)
  assert.deepEqual(spec.args.slice(flags[0] + 1, flags[0] + 3), [join(root, 'profile.safetensors'), '0.7'])
  assert.deepEqual(spec.args.slice(flags[1] + 1, flags[1] + 3), [join(root, 'identity.safetensors'), '0.8'])
  assert(!profile.build(context).args.includes('--step-cache-ratio'))
  spec = profile.build({ ...context, params: { step_cache_ratio: '0.5' } })
  assert.equal(spec.args[spec.args.indexOf('--step-cache-ratio') + 1], '0.5')
  assert.throws(() => profile.build({ ...context, params: { step_cache_ratio: 'bad' } }), /supported step reuse/)
  assert(!get('qwen-local-edit').params.some((p) => p.key === 'step_cache_ratio'))
  assert.equal(new Set(adapters.map((a) => a.id)).size, adapters.length)
  const profiles = JSON.parse(readFileSync(join(root, 'profiles.json'), 'utf8'))
  profiles.defaultEncoders = { 'qwen-2.1': 'alternate' }
  writeFileSync(join(root, 'profiles.json'), JSON.stringify(profiles))
  const preferred = await loadImageAdapters()
  const turbo = preferred.find((a) => a.id === 'qwen-image-2.1-turbo')
  assert.equal(turbo.params.find((p) => p.key === 'encoder').default, 'alternate')
  assert.equal(turbo.build(context).args[1], join(root, 'qwen-image-2.1-turbo-alternate'))
  assert.equal(turbo.build({ ...context, params: { encoder: 'stock' } }).args[1], join(root, 'qwen-image-2.1-turbo'))
  const legacy = preferred.find((a) => a.id === 'qwen-image-2.1').build(context)
  assert.equal(legacy.args[legacy.args.indexOf('--model') + 1], join(root, 'qwen-image-2.1-alternate'))
  profiles.defaultEncoders = { 'qwen-2.1': 'missing' }
  writeFileSync(join(root, 'profiles.json'), JSON.stringify(profiles))
  const isolated = await loadImageAdapters()
  assert.throws(()=>isolated.find(a=>a.id==='qwen-image-2.1-turbo').build(context),/Unknown default text encoder/)
  assert(isolated.find(a=>a.id==='flux3-klein').build(context).bin)
  console.log('Image adapter contracts passed: Turbo, optional encoders, references, upscale, opt-in local profile step reuse and registry IDs.')
} finally { rmSync(root, { recursive: true }) }
