import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
const { build, transform } = createRequire(import.meta.resolve('vite'))('esbuild')
import { compileModule } from 'svelte/compiler'

const temp = mkdtempSync(join(tmpdir(), 'local-lab-video-'))
let fail = false
const calls = []
const saved = []
globalThis.window = { lab: {
  async run(request) {
    if (fail) throw new Error('IPC unavailable')
    calls.push(structuredClone(request))
    return request.adapterIds.map((id) => ({ id: `job-${calls.length}-${id}`, adapterId: id,
      adapterLabel: id, modality: request.modality, prompt: request.prompt,
      params: request.params[id], state: 'queued', queuedAt: Date.now(), log: '' }))
  },
  async saveChat(chat) { saved.push(structuredClone(chat)) },
} }
try {
  const storeFile = join(temp, 'store.mjs')
  await build({ entryPoints: ['src/renderer/lib/stores/lab.svelte.ts'], outfile: storeFile,
    bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    plugins: [{ name: 'runes', setup(b) {
      b.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
        const js = await transform(readFileSync(path, 'utf8'), { loader: 'ts', target: 'es2022' })
        return { contents: compileModule(js.code, { filename: path, generate: 'server' }).js.code, loader: 'js' }
      })
    } }],
  })
  const { store } = await import(pathToFileURL(storeFile).href)
  const video = { id: 'video', label: 'Video', modality: 'video', family: 'test', acceptsImages: true,
    outputExt: 'mp4', params: [{ key: 'frames', label: 'Frames', type: 'int', default: 97 }] }
  store.adapters = [video, { ...video, id: 'offline' }, { ...video, id: 'image', modality: 'image' }]
  store.availability = { offline: { id: 'offline', available: false } }
  const old = { id: 'existing', modality: 'video', title: 'Existing video', createdAt: 1,
    updatedAt: 1, contextOn: true, messages: [] }
  store.chats = [old]
  store.activeChat.video = old.id
  store.prompts.image = 'unfinished image prompt'
  store.prompts.video = 'previous video draft'
  store.images.image = ['/image-draft.png']
  store.images.video = ['/previous-video-input.png']
  store.selected.image = ['image']
  const chat = await store.generateVideoFromImage('/generated.png', '  The subject waves.  ', 'video', { frames: 49 })
  assert.notEqual(chat.id, old.id)
  assert.equal(store.currentChat('video').id, chat.id)
  assert.equal(chat.sourceImage, '/generated.png')
  assert.equal(calls[0].prompt, 'The subject waves.')
  assert.deepEqual(calls[0].images, ['/generated.png'])
  assert.deepEqual(calls[0].adapterIds, ['video'])
  assert.equal(calls[0].params.video.frames, 49)
  assert.deepEqual(store.selected.video, ['video'])
  assert.deepEqual(store.images.video, [])
  assert.equal(store.prompts.video, '')
  assert.equal(store.prompts.image, 'unfinished image prompt')
  assert.deepEqual(store.images.image, ['/image-draft.png'])
  assert.deepEqual(store.selected.image, ['image'])
  assert.equal(old.messages.length, 0)
  assert.equal(saved.at(-1).sourceImage, '/generated.png')
  const before = store.chats.length
  for (const id of ['offline', 'image', 'missing']) {
    await assert.rejects(store.generateVideoFromImage('/generated.png', 'Motion', id, {}), /installed image-to-video/)
  }
  fail = true
  await assert.rejects(store.generateVideoFromImage('/generated.png', 'Motion', 'video', {}), /IPC unavailable/)
  assert.equal(store.chats.length, before)
  assert.equal(store.activeChat.video, chat.id)
  fail = false
  store.prompts.video = 'Now turn to the left.'
  await store.send('video')
  assert.deepEqual(calls.at(-1).images, ['/generated.png'])
  assert.equal(store.currentChat('video').id, chat.id)
  assert.deepEqual(store.images.image, ['/image-draft.png'])

  process.env.LOCALLAB_LTX_ENCODER_DIR = join(temp, 'encoder with spaces')
  process.env.LOCALLAB_VIDEO_PROFILES = join(temp, 'video-profiles.json')
  writeFileSync(process.env.LOCALLAB_VIDEO_PROFILES, JSON.stringify({ models: [
    { id: 'h3-local', label: 'H3 local profile', engine: 'h3-native', model: '/models/h3 local',
      binary: '/engines/curve engine/h3', steps: 8, allowApproximation: false },
    { id: 'ltx-local', label: 'LTX local profile', engine: 'ltx-mlx', model: '/models/ltx local',
      encoder: '/models/stock encoder' },
  ] }))
  const registry = join(temp, 'video.mjs')
  await build({ entryPoints: ['src/main/registry/video.ts'], outfile: registry,
    bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const { videoAdapters } = await import(pathToFileURL(registry).href)
  const a = videoAdapters[0]
  const input = { prompt: 'Motion', params: {}, images: ['/frame with spaces.png'], outPath: '/clip.mp4' }
  const spec = a.build(input)
  assert(spec.args.includes('--no-audio'))
  assert.equal(spec.args[spec.args.indexOf('--text-encoder-repo') + 1], process.env.LOCALLAB_LTX_ENCODER_DIR)
  assert(a.requires.includes(join(process.env.LOCALLAB_LTX_ENCODER_DIR, 'config.json')))
  assert.equal(spec.args[spec.args.indexOf('--image') + 1], input.images[0])
  assert(!spec.args.includes('--steps'))
  assert(!a.params.some((p) => ['steps', 'cfg', 'negative'].includes(p.key)))
  assert(!a.build({ ...input, params: { no_audio: false } }).args.includes('--no-audio'))
  for (const params of [{ frames: 50 }, { resolution: '500x500' }, { fps: 100 }, { image_strength: 2 }]) {
    assert.throws(() => a.build({ ...input, params }))
  }
  assert.throws(() => a.build({ ...input, images: ['a.png', 'b.png'] }), /one starting image/)
  const h3 = videoAdapters.find((adapter) => adapter.id === 'minimax-h3')
  const h3spec = h3.build(input)
  assert.equal(h3spec.args[h3spec.args.indexOf('--first-frame') + 1], input.images[0])
  assert.equal(h3spec.args[h3spec.args.indexOf('--frames') + 1], '56')
  assert.equal(h3spec.args[h3spec.args.indexOf('--layers') + 1], '45')
  assert.equal(h3spec.args[h3spec.args.indexOf('--reuse') + 1], '2')
  assert(h3.requires.some((path) => path.endsWith('h3_shaders.metal')))
  assert(!h3.build({ ...input, images: [] }).args.includes('--first-frame'))
  const personalH3 = videoAdapters.find((adapter) => adapter.id === 'h3-local')
  const personalSpec = personalH3.build({ ...input, params: { reuse: 3, layers: 40 } })
  assert.equal(personalSpec.bin, '/engines/curve engine/h3')
  assert.equal(personalSpec.cwd, '/engines/curve engine')
  assert.equal(personalSpec.args[personalSpec.args.indexOf('--steps') + 1], '8')
  assert.equal(personalSpec.args[personalSpec.args.indexOf('--reuse') + 1], '1')
  assert.equal(personalSpec.args[personalSpec.args.indexOf('--layers') + 1], '50')
  assert(!personalH3.params.some((p) => ['layers', 'reuse'].includes(p.key)))
  const next = videoAdapters.find((adapter) => adapter.id === 'ltx-2.5')
  const nextSpec = next.build(input)
  assert(nextSpec.args.includes('--distilled'))
  assert(nextSpec.args.includes('--no-audio'))
  assert.equal(nextSpec.args[nextSpec.args.indexOf('--frame-rate') + 1], '24')
  assert.equal(nextSpec.args[nextSpec.args.indexOf('--stage1-steps') + 1], '8')
  assert.equal(nextSpec.args[nextSpec.args.indexOf('--stage2-steps') + 1], '3')
  assert.deepEqual(nextSpec.args.slice(-4), ['--image', input.images[0], '0', '1.0'])
  assert(!nextSpec.args.includes('--gemma'))
  assert.equal(nextSpec.args[nextSpec.args.indexOf('--video-decoder') + 1], 'conv')
  const diffusion = next.build({ ...input, params: { decoder: 'diffusion' } })
  assert.equal(diffusion.args[diffusion.args.indexOf('--video-decoder') + 1], 'diffusion')
  assert(!next.build({ ...input, params: { no_audio: false } }).args.includes('--no-audio'))
  const localLtx = videoAdapters.find((adapter) => adapter.id === 'ltx-local').build(input)
  assert.equal(localLtx.args[localLtx.args.indexOf('--gemma') + 1], '/models/stock encoder')
  assert.equal(localLtx.args[localLtx.args.indexOf('--model') + 1], '/models/ltx local')
  for (const adapter of [h3, next]) {
    for (const params of [{ frames: 50 }, { resolution: '500x500' }, { seed: -1 }, { seed: 1.5 }]) {
      assert.throws(() => adapter.build({ ...input, params }))
    }
    assert.throws(() => adapter.build({ ...input, images: ['a.png', 'b.png'] }), /one starting image/)
  }
  assert.throws(() => h3.build({ ...input, params: { steps: NaN } }))
  assert.throws(() => h3.build({ ...input, params: { layers: 41 } }))
  assert.throws(() => next.build({ ...input, params: { stage1_steps: 5 } }))
  assert.throws(() => next.build({ ...input, params: { decoder: 'unknown' } }))
  assert.throws(() => videoAdapters.find((adapter) => adapter.id === 'ltx-local')
    .build({ ...input, params: { decoder: 'diffusion' } }))
  console.log('Video workflow passed: chat handoff, draft isolation, backend constraints, native H3/LTX commands and external profiles.')
} finally { rmSync(temp, { recursive: true, force: true }) }
