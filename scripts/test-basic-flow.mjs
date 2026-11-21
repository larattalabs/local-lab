import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { compileModule } from 'svelte/compiler'
const { build, transform } = createRequire(import.meta.resolve('vite'))('esbuild')
const root = mkdtempSync(join(tmpdir(), 'basic-flow-')), saved = new Map(), plans = [], accepted = new Map()
globalThis.localStorage = { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: (key) => saved.delete(key) }
let loseResponse = false, basic, store
const catalog = { presets: [], subjects: [], models: { fast: 'a', detailed: 'a', video: 'v' }, available: ['a','v'] }
globalThis.window = { lab: {
  basicCatalog: async () => catalog,
  basicPlan: async (input) => { plans.push(structuredClone(input)); return { choice: { mode: 'off' }, turn: { turnId: input.id, chat: input.chat ?? { id: 'generated-chat', modality: 'image', title: 'Test', contextOn: false }, contextUsed: false, request: { modality: 'image', prompt: input.prompt, adapterIds: ['a'], params: { a: { seed: 42 } }, images: input.sourceImage ? [input.sourceImage] : [] } } } },
  submitTurn: async (turn) => {
    if (accepted.has(turn.turnId)) return accepted.get(turn.turnId)
    const result = { chat: { ...turn.chat, revision: 1, messages: [{ id: 'message', role: 'user', text: turn.request.prompt }] }, jobs: [] }
    accepted.set(turn.turnId, result)
    if (loseResponse) { loseResponse = false; throw new Error('Lost response') }
    return result
  },
} }
try {
  const outfile = join(root, 'stores.mjs')
  await build({ stdin: { contents: "export { basicFlow } from './src/renderer/lib/stores/basic.svelte.ts'; export { store } from './src/renderer/lib/stores/lab.svelte.ts'", resolveDir: process.cwd() }, outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'runes', setup(b) { b.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => { const js = await transform(readFileSync(path, 'utf8'), { loader: 'ts', target: 'es2022' }); return { contents: compileModule(js.code, { filename: path, generate: 'server' }).js.code, loader: 'js' } }) } }] })
  const mod = await import(pathToFileURL(outfile).href); basic = mod.basicFlow; store = mod.store
  await basic.init(); store.params = { a: { steps: 25 } }; store.prompts.image = 'Advanced draft'; store.selected.image = ['a']
  assert.equal(basic.draft('image').intensity,'low')
  catalog.presets.push({id:'adult-preset',workflow:'create',params:{steps:8},director:'adult',mood:'swimwear',intensity:'high'})
  basic.usePreset('image','adult-preset');assert.equal(basic.draft('image').mood,'swimwear');assert.equal(basic.draft('image').intensity,'high')
  basic.usePreset('image','natural')
  basic.setMode('basic'); basic.update('image', { prompt: 'Basic draft', assistance: 'off' }); basic.source('image', '/chosen.png', 'edit')
  basic.setMode('advanced'); assert.equal(store.prompts.image, 'Advanced draft'); assert.equal(store.params.a.steps, 25)
  basic.setMode('basic'); assert.equal(basic.draft('image').sourceImage, '/chosen.png')
  store.activeChat.image = 'other'; assert.equal(basic.draft('image').prompt, ''); basic.update('image', { prompt: 'Other draft' }); store.activeChat.image = null
  loseResponse = true; await basic.send('image'); assert.match(basic.error, /Lost response/); assert.equal(accepted.size, 1)
  await basic.send('image'); assert.equal(accepted.size, 1); assert.equal(plans.length, 1); assert.equal(basic.error, ''); assert.equal(basic.draft('image').prompt, ''); assert.equal(basic.draft('image').sourceImage, '/chosen.png')
  assert.equal(store.params.a.steps, 25); assert.equal(store.prompts.image, 'Advanced draft')
  store.activeChat.image = 'other'; assert.equal(basic.draft('image').prompt, 'Other draft')
  basic.animate('/animation.png'); assert.equal(basic.draft('video').sourceImage, '/animation.png'); assert.equal(basic.draft('video').workflow, 'animate'); assert.equal(basic.draft('image').prompt, 'Other draft')
  basic.advanced({ requestSnapshot: { modality: 'image', adapterIds: ['editor'], prompt: 'Exact approved prompt', params: { editor: { steps: 17 } }, images: ['/earlier.png'] } }); assert.equal(basic.mode, 'advanced'); assert.equal(store.prompts.image, 'Exact approved prompt'); assert.deepEqual(store.images.image, ['/earlier.png']); assert.equal(store.params.editor.steps, 17)
  store.newChat('video'); basic.source('video','/prior.png','animate'); basic.resetDraft('video'); assert.equal(basic.draft('video').sourceImage,undefined)
  console.log('Basic UI store passed: mode/draft isolation, pinned source, lost-response retry without duplicate generation, animation handoff and exact Advanced settings restoration.')
} finally { rmSync(root, { recursive: true, force: true }) }
