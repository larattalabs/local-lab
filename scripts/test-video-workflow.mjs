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
let testStore
const acceptedTurns = new Map()
let loseNextResponse = false
let holdSubmission
const submittedTurns = []
globalThis.window = { lab: {
  async run(request) {
    if (fail) throw new Error('IPC unavailable')
    calls.push(structuredClone(request))
    return request.adapterIds.map((id) => ({ id: `job-${calls.length}-${id}`, adapterId: id,
      adapterLabel: id, modality: request.modality, prompt: request.prompt,
      params: request.params[id], state: 'queued', queuedAt: Date.now(), log: '' }))
  },
  async submitTurn(turn) {
    if (holdSubmission) await holdSubmission
    submittedTurns.push(structuredClone(turn))
    if (acceptedTurns.has(turn.turnId)) return acceptedTurns.get(turn.turnId)
    const jobs = await this.run(turn.request)
    const chat = testStore.chats.find((c) => c.id === turn.chat.id) ?? { ...turn.chat, createdAt: Date.now(), updatedAt: Date.now(), messages: [] }
    chat.messages.push({ id: crypto.randomUUID(), role: 'user', text: turn.request.prompt, images: turn.request.images })
    for (const job of jobs) chat.messages.push({ id: crypto.randomUUID(), role: 'gen', jobId: job.id, adapterId: job.adapterId, state: job.state, images: turn.request.images })
    saved.push(structuredClone(chat))
    const result = { chat, jobs }
    acceptedTurns.set(turn.turnId, result)
    if (loseNextResponse) {
      loseNextResponse = false
      chat.messages.at(-1).state = 'done'
      chat.messages.at(-1).outputPath = '/finished-during-disconnect.png'
      throw new Error('Wi-Fi response lost')
    }
    return result
  },
  async listChats() { return testStore.chats },
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
  testStore = store
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

  // Image follow-ups must change the executed adapter as well as carry the pixels.
  const gen = { id: 'picture', label: 'Picture', modality: 'image', family: 'qwen-2.1',
    outputExt: 'png', acceptsImages: false, imageEditAdapterId: 'picture-edit', params: [
      { key: 'lora', default: '' }, { key: 'encoder', default: 'alternate' },
      { key: 'lora_scale', default: 1 }, { key: 'aspect', default: '2:3' },
      { key: 'seed', default: null }, { key: 'steps', default: 25 },
      { key: 'step_cache_ratio', default: '' },
    ] }
  const edit = { ...gen, id: 'picture-edit', label: 'Picture edit', imageEditAdapterId: undefined,
    acceptsImages: true, requiresImage: true, params: gen.params.filter((p) => p.key !== 'step_cache_ratio') }
  const noEdit = { ...gen, id: 'text-only-picture', imageEditAdapterId: undefined }
  const imageChat = { id: 'image-chat', modality: 'image', title: 'Image', createdAt: 1,
    updatedAt: 1, contextOn: true, messages: [
      { role: 'user', text: 'Portrait' },
      { role: 'gen', state: 'done', outputPath: '/first.png', adapterId: gen.id },
      { role: 'gen', state: 'error', outputPath: '/failed.png', adapterId: gen.id },
    ] }
  store.adapters.push(gen, edit, noEdit)
  store.chats.push(imageChat)
  store.activeChat.image = imageChat.id
  store.selected.image = [gen.id]
  store.images.image = []
  store.params[gen.id] = { lora: 'identity-v2', lora_scale: 0.8, encoder: 'alternate',
    aspect: '2:3', steps: 20, seed: 73, step_cache_ratio: '0.5' }
  store.prompts.image = 'Change the jacket to green.'
  const preview = store.imageTurn()
  assert.deepEqual(preview.adapterIds, [edit.id])
  assert.deepEqual(preview.images, ['/first.png'])
  assert.equal(preview.error, '')
  await store.send('image')
  assert.deepEqual(calls.at(-1).adapterIds, [edit.id])
  assert.deepEqual(calls.at(-1).images, ['/first.png'])
  assert.equal(calls.at(-1).params[edit.id].lora, 'identity-v2')
  assert.equal(calls.at(-1).params[edit.id].lora_scale, 0.8)
  assert.equal(calls.at(-1).params[edit.id].encoder, 'alternate')
  assert.equal(calls.at(-1).params[edit.id].aspect, '2:3')
  assert.equal(calls.at(-1).params[edit.id].seed, 73)
  assert(!('step_cache_ratio' in calls.at(-1).params[edit.id]))
  assert.equal(imageChat.messages.at(-1).adapterId, edit.id)
  assert.deepEqual(store.selected.image, [gen.id])
  imageChat.messages.at(-1).state = 'done'
  imageChat.messages.at(-1).outputPath = '/edited.png'
  assert.deepEqual(store.imageTurn().images, ['/edited.png'])

  // Selecting an earlier result must override the newest result in the real request.
  store.images.image = ['/old-attachment.png']
  store.selectImageForEdit('/first.png')
  assert.deepEqual(store.images.image, [])
  assert.deepEqual(store.imageTurn().images, ['/first.png'])
  assert.equal(store.imageTurn().fromSelection, true)
  store.activeChat.image = null
  assert.deepEqual(store.imageTurn().images, [])
  store.activeChat.image = imageChat.id
  assert.deepEqual(store.imageTurn().images, ['/first.png'])
  imageChat.contextOn = false
  assert.deepEqual(store.imageTurn().images, ['/first.png'])
  assert.throws(() => store.selectImageForEdit('/failed.png'), /finished image/)
  assert.throws(() => store.selectImageForEdit('/not-in-this-chat.png'), /finished image/)
  store.prompts.image = 'Edit the earlier image.'
  await store.send('image')
  assert.deepEqual(calls.at(-1).images, ['/first.png'])
  assert.deepEqual(calls.at(-1).adapterIds, [edit.id])
  assert.equal(store.imageTurn().fromSelection, true)
  assert.deepEqual(store.imageTurn().images, ['/first.png'])
  const submitted = imageChat.messages.at(-1)
  assert.deepEqual(submitted.images, ['/first.png'])
  store.prompts.image = 'Typing another prompt must not change the source.'
  assert.deepEqual(store.imageTurn().images, ['/first.png'])
  store.absorbJob({ id: submitted.jobId, state: 'running', params: {} })
  assert.deepEqual(store.imageTurn().images, ['/first.png'])
  store.absorbJob({ id: submitted.jobId, state: 'done', outputPath: '/chosen-edit.png', params: {} })
  assert.equal(store.imageTurn().fromSelection, false)
  assert.deepEqual(store.imageTurn().images, [])
  assert.deepEqual(submitted.images, ['/first.png'])
  imageChat.contextOn = true
  store.selectImageForEdit('/first.png')
  store.clearImageEditSource()
  assert.deepEqual(store.imageTurn().images, ['/chosen-edit.png'])

  // Late completion must not erase a selection made after submission, even the same path.
  store.selectImageForEdit('/first.png')
  store.prompts.image = 'Another edit of the first image.'
  await store.send('image')
  const pending = imageChat.messages.at(-1)
  store.selectImageForEdit('/first.png')
  store.absorbJob({ id: pending.jobId, state: 'done', outputPath: '/another-edit.png', params: {} })
  assert.equal(store.imageTurn().fromSelection, true)
  assert.deepEqual(store.imageTurn().images, ['/first.png'])
  store.prompts.image = 'Retryable edit.'
  await store.send('image')
  const failed = imageChat.messages.at(-1)
  store.absorbJob({ id: failed.jobId, state: 'error', error: 'Test failure', params: {} })
  assert.deepEqual(store.imageTurn().images, ['/first.png'])
  store.clearImageEditSource()

  store.availability[edit.id] = { id: edit.id, available: false }
  store.prompts.image = 'Another edit'
  const sent = calls.length
  await assert.rejects(store.send('image'), /matching editor.*unavailable/)
  assert.equal(calls.length, sent)
  delete store.availability[edit.id]
  store.selected.image = [noEdit.id]
  await assert.rejects(store.send('image'), /cannot use the previous/)
  assert.equal(calls.length, sent)
  store.selected.image = [gen.id, noEdit.id]
  await assert.rejects(store.send('image'), /cannot use the previous/)
  store.selected.image = [gen.id, edit.id]
  await assert.rejects(store.send('image'), /either a generator/)
  store.selected.image = [gen.id]
  imageChat.contextOn = false
  await store.send('image')
  assert.deepEqual(calls.at(-1).adapterIds, [gen.id])
  assert.deepEqual(calls.at(-1).images, [])
  store.images.image = ['/explicit.png']
  store.prompts.image = 'Use this attached image instead.'
  await store.send('image')
  assert.deepEqual(calls.at(-1).adapterIds, [edit.id])
  assert.deepEqual(calls.at(-1).images, ['/explicit.png'])
  store.selected.image = [edit.id]
  imageChat.contextOn = true
  assert.deepEqual(store.imageTurn().adapterIds, [edit.id])
  // A lost acceptance response may be retried after its result changes automatic context.
  store.selected.image = [gen.id]
  store.images.image = []
  store.prompts.image = 'Keep this exact edit when reconnecting.'
  loseNextResponse = true
  await assert.rejects(store.send('image'), /Wi-Fi response lost/)
  const originalTurn = submittedTurns.at(-1)
  const originalCount = calls.length
  await store.send('image')
  assert.equal(submittedTurns.at(-1).turnId, originalTurn.turnId)
  assert.deepEqual(submittedTurns.at(-1).request, originalTurn.request)
  assert.equal(calls.length, originalCount, 'Retry must not create another generation')
  loseNextResponse = true
  await assert.rejects(store.generateVideoFromImage('/generated.png', 'Retry safe motion', 'video', {}), /Wi-Fi response lost/)
  const animationTurn = submittedTurns.at(-1)
  const animationCount = calls.length
  await store.generateVideoFromImage('/generated.png', 'Retry safe motion', 'video', {})
  assert.equal(submittedTurns.at(-1).turnId, animationTurn.turnId)
  assert.equal(calls.length, animationCount)

  // Moving to another chat while Wi-Fi accepts the turn must preserve that new draft.
  store.activeChat.image = imageChat.id
  store.selected.image = [gen.id]
  store.prompts.image = 'A turn accepted after switching chats.'
  let releaseSubmission
  holdSubmission = new Promise((resolve) => releaseSubmission = resolve)
  const inTransit = store.send('image')
  store.newChat('image')
  store.prompts.image = 'Keep my new draft.'
  releaseSubmission(); await inTransit; holdSubmission = undefined
  assert.equal(store.activeChat.image, null)
  assert.equal(store.prompts.image, 'Keep my new draft.')

  console.log('Image chat routing passed: real editor, latest output, explicit override, settings, fresh generation and no silent fallback.')

  process.env.LOCALLAB_RUNTIME_PROFILES = join(temp, 'runtime-profiles.json')
  writeFileSync(process.env.LOCALLAB_RUNTIME_PROFILES, JSON.stringify({ models: {
    'minimax-h3': { model: '/models/alternate h3' },
    'ltx-2.5': { model: '/models/alternate ltx' },
    'ltx-local': { encoder: '/models/alternate encoder' },
    'wan22-i2v-a14b': { script: '/scripts/wan compatibility.py' },
  } }))
  process.env.LOCALLAB_LTX_ENCODER_DIR = join(temp, 'encoder with spaces')
  process.env.LOCALLAB_WAN_PROFILES = join(temp, 'wan-profiles.json')
  writeFileSync(process.env.LOCALLAB_WAN_PROFILES, JSON.stringify({ models: [
    { id: 'wan-local', label: 'Local Wan', model: '/models/local wan', steps: 6, draftSteps: 4, guidance: 1, shift: 5 },
  ] }))
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
  assert.equal(h3spec.args[h3spec.args.indexOf('-d') + 1], '/models/alternate h3')
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
  assert.equal(nextSpec.args[nextSpec.args.indexOf('--model') + 1], '/models/alternate ltx')
  assert(nextSpec.args.includes('--distilled'))
  assert(nextSpec.args.includes('--no-audio'))
  assert.equal(nextSpec.args[nextSpec.args.indexOf('--frame-rate') + 1], '24')
  assert.equal(nextSpec.args[nextSpec.args.indexOf('--stage1-steps') + 1], '8')
  assert.equal(nextSpec.args[nextSpec.args.indexOf('--stage2-steps') + 1], '3')
  assert.deepEqual(nextSpec.args.slice(-4), ['--image', input.images[0], '0', '1.0'])
  assert(!nextSpec.args.includes('--gemma'))
  for (const file of ['connector.safetensors', 'vae_decoder_conv.safetensors',
    'vae_encoder_conv.safetensors', 'spatial_upscaler_x2_v1_0.safetensors', 'text_encoder.safetensors']) {
    assert(next.requires.some((path) => path.endsWith('/' + file)), 'Missing availability check: ' + file)
  }
  assert.equal(nextSpec.args[nextSpec.args.indexOf('--video-decoder') + 1], 'conv')
  const diffusion = next.build({ ...input, params: { decoder: 'diffusion' } })
  assert.equal(diffusion.args[diffusion.args.indexOf('--video-decoder') + 1], 'diffusion')
  assert(!next.build({ ...input, params: { no_audio: false } }).args.includes('--no-audio'))
  const localLtx = videoAdapters.find((adapter) => adapter.id === 'ltx-local').build(input)
  assert(videoAdapters.find((adapter) => adapter.id === 'ltx-local').requires
    .some((path) => path.endsWith('/spatial_upscaler_x2_v1_1.safetensors')))
  assert.equal(localLtx.args[localLtx.args.indexOf('--gemma') + 1], '/models/alternate encoder')
  assert.equal(localLtx.args[localLtx.args.indexOf('--model') + 1], '/models/ltx local')
  for (const adapter of [h3, next]) {
    for (const params of [{ frames: 50 }, { resolution: '500x500' }, { seed: -1 }, { seed: 1.5 }]) {
      assert.throws(() => adapter.build({ ...input, params }))
    }
    assert.throws(() => adapter.build({ ...input, images: ['a.png', 'b.png'] }), /one starting image/)
    assert.throws(() => adapter.build({ ...input, params: { seed: 4294967296 } }))
    const fixed = adapter.build({ ...input, params: { seed: 4294967295 } })
    assert.equal(fixed.args[fixed.args.indexOf('--seed') + 1], '4294967295')
    const randomSeeds = Array.from({ length: 4 }, () => {
      const generated = adapter.build({ ...input, params: { seed: null } })
      return Number(generated.args[generated.args.indexOf('--seed') + 1])
    })
    assert(randomSeeds.every((seed) => Number.isInteger(seed) && seed >= 0 && seed <= 4294967295))
    assert(new Set(randomSeeds).size > 1, 'An empty seed should choose fresh random seeds')
  }
  assert.throws(() => h3.build({ ...input, params: { steps: NaN } }))
  assert.throws(() => h3.build({ ...input, params: { layers: 41 } }))
  assert.throws(() => next.build({ ...input, params: { stage1_steps: 5 } }))
  assert.throws(() => next.build({ ...input, params: { decoder: 'unknown' } }))
  assert.throws(() => videoAdapters.find((adapter) => adapter.id === 'ltx-local')
    .build({ ...input, params: { decoder: 'diffusion' } }))
  for (const lightning of [false, true]) {
    const wan = videoAdapters.find((a) => a.id === 'wan22-i2v-a14b' + (lightning ? '-lightning' : ''))
    assert(wan.requiresImage)
    const command = wan.build(input)
    assert.equal(command.args[command.args.indexOf('--image') + 1], input.images[0])
    assert.equal(command.args[command.args.indexOf('--steps') + 1], lightning ? '4' : '40')
    assert.equal(command.args[command.args.indexOf('--scheduler') + 1], lightning ? 'euler' : 'unipc')
    assert.equal(command.args.includes('--lora-high'), lightning)
    assert.equal(command.args.includes('--lora-low'), lightning)
    assert.throws(() => wan.build({ ...input, images: [] }), /requires one starting image/)
    assert.throws(() => wan.build({ ...input, params: { frames: 50 } }), /4n\+1/)
    assert.throws(() => wan.build({ ...input, params: { resolution: '500x500' } }), /supported video resolution/)
  }
  const localWan = videoAdapters.find((a) => a.id === 'wan-local').build(input)
  assert.equal(localWan.args[localWan.args.indexOf('--model-dir') + 1], '/models/local wan')
  assert.equal(localWan.args[localWan.args.indexOf('--steps') + 1], '6')
  assert(!localWan.args.includes('--lora-high'))
  assert(localWan.args[1].endsWith('/resources/workers/wan_cached.py'))
  assert.equal(localWan.args[2], '/scripts/wan compatibility.py')
  assert(localWan.env.LOCALLAB_WAN_CACHE.endsWith('/wan-cache'))
  const configured = videoAdapters.find((a) => a.id === 'wan-local')
  assert(configured.params.some(p => p.key === 'wan_quality'))
  const draft = configured.build({ ...input, params: { wan_quality: 'draft' } })
  assert.equal(draft.args[draft.args.indexOf('--steps') + 1], '4')
  assert.throws(() => configured.build({ ...input, params: { wan_quality: 'bad' } }), /quality/)
  assert.throws(() => videoAdapters.find(a => a.id === 'wan22-i2v-a14b')
    .build({ ...input, params: { wan_quality: 'draft' } }), /quality/)
  assert(!localWan.args.includes('-m'))
  console.log('Video workflow passed: chat handoff, draft isolation, backend constraints, native H3/LTX commands and external profiles.')
} finally { rmSync(temp, { recursive: true, force: true }) }
