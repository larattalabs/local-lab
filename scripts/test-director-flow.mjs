import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { compileModule } from 'svelte/compiler'
const { build, transform } = createRequire(import.meta.resolve('vite'))('esbuild')
const temp = mkdtempSync(join(tmpdir(), 'director-flow-'))
const saved = new Map(), statuses = new Map(), starts = []
globalThis.localStorage = { getItem: (k) => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v), removeItem: (k) => saved.delete(k) }
let loseResponse = false, deny = false, cancelCount = 0
const makeStatus = (input) => ({ id: input.id, state: 'done', automatic: input.choice.mode === 'auto',
  preview: { id: input.id, turn: input.turn, prompts: { a: 'identity-token rewritten.' }, warnings: [], provenance: { protectedTerms: ['identity-token'], comparison: 'same' } },
  ...(input.choice.mode === 'auto' ? { result: { chat: { id: input.turn.chat.id }, jobs: [{ id: 'only-job' }] } } : {}) })
globalThis.window = { lab: {
  directorConfigure: async (config) => ({ config, models: [] }),
  directorStart: async (input) => {
    starts.push(input)
    if (deny) throw new Error('Choose a model.')
    const status = makeStatus(input); statuses.set(input.id, status)
    if (loseResponse) { loseResponse = false; throw new Error('Response lost') }
    return status
  },
  directorStatus: async (id) => { if (!statuses.has(id)) throw new Error('This rewrite is no longer available.'); return statuses.get(id) },
  cancel: async () => { cancelCount++ },
} }
try {
  const outfile = join(temp, 'flow.mjs')
  await build({ entryPoints: ['src/renderer/lib/stores/director.svelte.ts'], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    plugins: [{ name: 'runes', setup(b) { b.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
      const js = await transform(readFileSync(path, 'utf8'), { loader: 'ts', target: 'es2022' })
      return { contents: compileModule(js.code, { filename: path, generate: 'server' }).js.code, loader: 'js' }
    }) } }],
  })
  const { DirectorFlow } = await import(pathToFileURL(outfile).href)
  const flow = new DirectorFlow()
  const turn = () => ({ turnId: crypto.randomUUID(), chat: { id: crypto.randomUUID(), modality: 'image', contextOn: true },
    request: { modality: 'image', adapterIds: ['a'], prompt: 'identity-token original.', params: { a: {} }, images: ['/chosen.png'] }, contextUsed: true })
  const settle = () => new Promise((r) => setTimeout(r, 20))
  const plain = turn(); assert.deepEqual(await flow.prepare(plain), { turn: plain }); assert.equal(starts.length, 0)
  flow.choose('image', 'mode', 'preview')
  const pending = flow.prepare(turn()); await settle()
  assert.equal(starts[0].choice.preset, 'edit', 'Reference follow-up uses precise edit recipe')
  assert.throws(() => flow.approved({ a: 'Dropped identity' }), /protected text/); assert(flow.session)
  flow.approved({ a: 'identity-token user-edited.' })
  const approved = await pending; assert.equal(approved.turn.request.director.prompts.a, 'identity-token user-edited.')
  assert.deepEqual(approved.turn.request.images, ['/chosen.png']); assert.equal(saved.has('director-pending'), false)
  flow.choose('image', 'mode', 'auto'); loseResponse = true
  const automatic = await flow.prepare(turn())
  assert.equal(automatic.result.jobs.length, 1); assert.equal(starts.length, 2, 'Lost accepted response never starts a second rewrite')
  assert.equal(flow.session, null)
  flow.choose('image', 'mode', 'preview'); deny = true
  const rejected = flow.prepare(turn()); await settle()
  assert.equal(flow.session.status.state, 'error'); assert.equal(flow.session.status.error, 'Choose a model.')
  await flow.original(); const fallback = await rejected; assert.equal(fallback.turn.request.director, undefined)
  deny = false
  const cancelled = flow.prepare(turn()); await settle(); await flow.cancel(); assert.equal(await cancelled, null)
  flow.choose('image', 'preset', 'deleted-director')
  flow.choose('video', 'preset', 'motion')
  const modeBefore = flow.choices.image.mode
  await flow.configure(flow.info.config)
  assert.equal(flow.choices.image.preset, 'faithful', 'Deleted profiles fall back to an existing default')
  assert.equal(flow.choices.video.preset, 'motion')
  assert.equal(flow.choices.image.mode, modeBefore, 'Editing profiles does not change mode preferences')
  console.log('Director flow passed: preview editing, protected terms, reference routing, original fallback, cancel, automatic response-loss recovery without duplicates and pending-state cleanup.')
} finally { rmSync(temp, { recursive: true, force: true }) }
