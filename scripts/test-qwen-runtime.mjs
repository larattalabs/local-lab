import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { loadImageAdapters } from './image-adapters.mjs'
const root = mkdtempSync(join(tmpdir(), 'qwen-native-contract-'))
process.env.LOCALLAB_IMAGE_MODELS_DIR = root
process.env.LOCALLAB_IMAGE_PROFILES = join(root, 'profiles.json')
process.env.LOCALLAB_RUNTIME_PROFILES = join(root, 'runtime.json')
process.env.LOCALLAB_QWEN_RUNTIME = join(root, 'native.json')
for (const dir of ['local', 'local-alternate', 'qwen-image-2.1', 'qwen-image-2.1-alternate', 'qwen-image-2.1-turbo', 'qwen-image-2.1-turbo-alternate']) {
  mkdirSync(join(root, dir, 'text_encoder'), { recursive: true })
}
const native = { python: join(root, 'python'), script: join(root, 'worker.py'), engine: join(root, 'mlx-serve') }
for (const file of [...Object.values(native), join(root, 'identity.safetensors'), join(root, 'style.safetensors')]) writeFileSync(file, '')
writeFileSync(process.env.LOCALLAB_QWEN_RUNTIME, JSON.stringify(native))
writeFileSync(process.env.LOCALLAB_RUNTIME_PROFILES, JSON.stringify({ models: { 'qwen-image-2.1': { model: join(root, 'qwen-image-2.1-alternate') } } }))
writeFileSync(process.env.LOCALLAB_IMAGE_PROFILES, JSON.stringify({
  models: [false, true].map((edit) => ({ id: 'local' + (edit ? '-edit' : ''), label: 'Local Qwen', model: 'local', base: 'qwen-image-2.1',
    command: 'mflux-generate-qwen-2.1' + (edit ? '-edit' : ''), steps: 25, qwen: true, edit, guided: true, stepReuse: !edit,
    presetLoras: [{ path: 'style.safetensors', scale: 0.7 }] })),
  encoders: { 'qwen-2.1': [{ id: 'alternate', label: 'Alternate', suffix: '-alternate' }] },
  defaultEncoders: { 'qwen-2.1': 'alternate' },
  loras: [{ id: 'identity', label: 'Identity', path: 'identity.safetensors', family: 'qwen-2.1' }],
}))
try {
  const adapters = await loadImageAdapters()
  const get = (id) => adapters.find((a) => a.id === id)
  const local = get('local'), base = get('qwen-image-2.1')
  const context = { prompt: 'A portrait.', outPath: join(root, 'output.png'), images: [], params: {
    steps: 25, guidance: 3, negative: 'blurry', seed: 123, lora: 'identity', lora_scale: 0.8,
    // Hidden values from a pre-migration chat must not change INT8 execution.
    quantize: '4', step_cache_ratio: '0.5',
  } }
  const spec = local.build(context)
  assert.equal(spec.bin, native.python)
  assert.deepEqual(spec.args.slice(0, 3), [native.script, '--engine', native.engine])
  assert.equal(spec.args[spec.args.indexOf('--model') + 1], join(root, 'local-alternate'))
  assert(!spec.args.includes('--quantize')); assert(!spec.args.includes('--step-cache-ratio'))
  assert.equal(spec.args[spec.args.indexOf('--steps') + 1], '25')
  assert.equal(spec.args[spec.args.indexOf('--guidance') + 1], '3')
  const loras = spec.args.flatMap((x,i) => x === '--lora' ? [spec.args.slice(i+1,i+3)] : [])
  assert.deepEqual(loras, [[join(root,'style.safetensors'),'0.7'],[join(root,'identity.safetensors'),'0.8']])
  assert(spec.args.includes('--no-bake-lora'))
  assert.equal(local.params.find((p) => p.key === 'image_engine').default, 'mlx-serve-int8')
  assert.deepEqual(local.params.find((p) => p.key === 'step_cache_ratio').visibleWhen, { key:'image_engine',value:'mflux' })
  const fallback = local.build({ ...context, params: { ...context.params, image_engine: 'mflux' } })
  assert(fallback.bin.endsWith('/mflux-generate-qwen-2.1'))
  assert(fallback.args.includes('--step-cache-ratio')); assert(fallback.args.includes('--quantize'))
  assert.throws(() => local.build({ ...context, params:{image_engine:'invalid'} }), /Unknown Qwen/)
  const baseRun = base.build({ ...context, params: {seed:123} })
  assert.equal(baseRun.bin,native.python)
  assert.equal(baseRun.args[baseRun.args.indexOf('--steps')+1],'40')
  assert.throws(() => base.build({ ...context,images:['source.png'] }), /matching Qwen editor/)
  assert(base.build({ ...context, images:['source.png'],params:{image_engine:'mflux'} }).args.includes('--image-path'))
  for (const id of ['local-edit','qwen-image-2.1-edit','qwen-image-2.1-turbo-edit','flux3-klein']) {
    assert(!get(id).params.some((p)=>p.key==='image_engine'),id)
  }
  assert(get('local-edit').build({...context,images:['source.png']}).bin.endsWith('/mflux-generate-qwen-2.1-edit'))
  const turbo = get('qwen-image-2.1-turbo')
  const turboRun = turbo.build({ ...context, params: { ...context.params, steps: 40, guidance: 8 } })
  assert.equal(turboRun.bin, native.python)
  assert.equal(turboRun.args[turboRun.args.indexOf('--base-model') + 1], 'qwen-image-2.1-turbo')
  assert.equal(turboRun.args[turboRun.args.indexOf('--steps') + 1], '8')
  assert(!turboRun.args.includes('--guidance')); assert(!turboRun.args.includes('--quantize'))
  assert(turboRun.args.includes(join(root, 'identity.safetensors')))
  assert(turbo.build({ ...context, params: { image_engine: 'mflux' } }).bin.endsWith('/mflux-generate-qwen-2.1'))
  // The common desktop/phone request validator drops controls inactive for the selected engine.
  const { build } = createRequire(import.meta.resolve('vite'))('esbuild')
  const out=join(root,'validation.mjs')
  await build({entryPoints:['src/main/phone/validation.ts'],outfile:out,bundle:true,platform:'node',format:'esm',logLevel:'silent'})
  const { validateTurn } = await import(pathToFileURL(out).href)
  const turn = {contextUsed:false,chat:{modality:'image',title:'Test',contextOn:false},request:{modality:'image',prompt:'Test',adapterIds:['local'],params:{local:context.params}}}
  const validated=validateTurn(turn,adapters)
  assert(!('quantize' in validated.request.params.local));assert(!('step_cache_ratio' in validated.request.params.local))
  assert.equal(validated.request.params.local.lora,'identity')
  assert.equal(turn.request.params.local.quantize,'4','Validation must not mutate the caller')
  rmSync(native.engine)
  assert.throws(()=>local.build(context),/missing/)
  assert(local.build({...context,params:{image_engine:'mflux'}}).bin.endsWith('/mflux-generate-qwen-2.1'))
  console.log('Qwen runtime: INT8 defaults, model/encoder/LoRA preservation, legacy settings, fallback, editing isolation and phone validation passed.')
} finally { rmSync(root,{recursive:true,force:true}) }
