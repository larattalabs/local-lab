import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
const require = createRequire(import.meta.url)
const { build } = createRequire(import.meta.resolve('vite'))('esbuild')
const temp = mkdtempSync(join(tmpdir(), 'local-lab-director-'))
const runs = join(temp, 'runs'); mkdirSync(runs)
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn) { for (let n = 0; n < 2200; n++) { if (fn()) return; await delay(10) } throw new Error('Timed out') }
try {
  await build({ entryPoints: ['src/main/director/service.ts', 'src/main/runner.ts', 'src/main/conversations.ts'],
    outdir: temp, bundle: true, platform: 'node', format: 'cjs', outExtension: { '.js': '.cjs' }, logLevel: 'silent',
    plugins: [{ name: 'isolated-runtime', setup(b) {
      b.onResolve({ filter: /^\.\/registry$/ }, (args) => args.importer.endsWith('/runner.ts') ? { path: 'registry', namespace: 'fixture' } : undefined)
      b.onResolve({ filter: /^\.\/env$/ }, (args) => args.importer.endsWith('/runner.ts') ? { path: 'env', namespace: 'fixture' } : undefined)
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'registry'
        ? `exports.byId = id => ({ id, label: id, outputExt: 'png', build: ({outPath}) => ({bin: process.execPath, args: ['-e', 'require("fs").writeFileSync(process.argv[1], "fixture")', outPath]}) })`
        : `exports.RUNS_DIR = ${JSON.stringify(runs)}; exports.modelEnv = e => ({...process.env,...e});`, loader: 'js' }))
    } }],
  })
  const { Director } = require(join(temp, 'director/service.cjs'))
  const { Runner } = require(join(temp, 'runner.cjs'))
  const { Conversations } = require(join(temp, 'conversations.cjs'))
  const queue = new Runner(), disk = new Map(), events = []
  let director
  const conversations = new Conversations(queue, { listChats: () => [...disk.values()], saveChat: (c) => disk.set(c.id, structuredClone(c)), deleteChat: (id) => disk.delete(id) }, (t) => director.resolve(t))
  const adapters = ['a', 'b'].map((id) => ({ id, label: id, modality: 'image', family: 'fixture', params: [] }))
  let response = { shared: 'identity-token, a blue ceramic vase on a wooden table.' }, loaded = false, requestBody, hold, unloadHold, vision = false, offline = false, tagsHold, unloadStuck = false, unloadLag = 0
  const fakeFetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined
    if (url.endsWith('/api/tags') && offline) throw new Error('Runtime stopped')
    if (url.endsWith('/api/tags') && tagsHold) await tagsHold
    if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'fixture-text', capabilities: ['completion', ...(vision ? ['vision'] : [])] }] })
    if (url.endsWith('/api/chat')) {
      events.push('rewrite'); loaded = true; requestBody = body
      if (hold) await new Promise((resolve, reject) => { hold.resolve = resolve; options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }) })
      return Response.json({ message: { content: typeof response === 'string' ? response : JSON.stringify({ prompts: response }) } })
    }
    if (url.endsWith('/api/generate')) { events.push('unload'); if (unloadHold) await unloadHold; if (!unloadStuck && !unloadLag) loaded = false; return Response.json({ done: true }) }
    if (url.endsWith('/api/ps')) { if (unloadLag > 0 && --unloadLag === 0) loaded = false; events.push('unload-confirmed'); return Response.json({ models: loaded ? [{ name: 'fixture-text' }] : [] }) }
    throw new Error(url)
  }
  const dependencies = { adapters: () => adapters, chats: () => conversations.list(), submit: (t) => conversations.submit(t), fetch: fakeFetch, image: () => 'fixture-base64' }
  director = new Director(join(temp, 'settings'), runs, queue, dependencies)
  queue.onUpdate((j) => { if (j.kind !== 'director' && j.state === 'running') { assert.equal(loaded, false, 'Generation must wait for unload'); events.push('generation') } })
  let info = await director.info()
  assert.equal(info.config.model, 'fixture-text')
  info = await director.configure({ ...info.config, keepWarm: false, protectedTerms: ['identity-token'], profiles: [{ id: 'custom', name: 'Custom', instructions: 'Use clear language.' }] })
  await assert.rejects(director.configure({ ...info.config, revision: 0 }), /another device/)
  const make = (mode = 'preview', comparison = 'same') => {
    const id = randomUUID()
    return { id, choice: { mode, comparison, preset: 'faithful', freedom: 'low' }, turn: { turnId: id,
      chat: { id: randomUUID(), modality: 'image', title: 'Director test', contextOn: true }, contextUsed: false,
      request: { modality: 'image', adapterIds: ['a', 'b'], prompt: 'identity-token, a blue vase.', params: { a: {}, b: {} }, images: [] } } }
  }
  const done = async (id) => { await until(() => ['done', 'error', 'cancelled'].includes(queue.get(id)?.state)); return director.status(id) }
  const one = make(); director.start(one); const first = await done(one.id)
  assert.equal(first.state, 'done'); assert.equal(first.preview.prompts.a, first.preview.prompts.b)
  assert.equal(queue.list().filter((j) => !j.kind).length, 0, 'Preview must not generate')
  assert.equal(requestBody.think, false); assert.equal(requestBody.keep_alive, 0)
  assert.deepEqual(events, ['rewrite', 'unload', 'unload-confirmed'])
  director.start(one); assert.equal(events.length, 3, 'Starting same rewrite is idempotent')
  const approved = { ...one.turn, request: { ...one.turn.request, director: { previewId: one.id, prompts: { a: 'identity-token, a red vase.', b: 'identity-token, a red vase.' } } } }
  const changed = structuredClone(approved); changed.request.images = ['/other.png']
  assert.throws(() => director.resolve(changed), /changed after preview/)
  const missing = structuredClone(approved); missing.request.director.prompts.a = 'A red vase.'
  assert.throws(() => director.resolve(missing), /protected text/)
  const different = structuredClone(approved); different.request.director.prompts.a = 'identity-token, green.'
  assert.throws(() => director.resolve(different), /identical prompts/)
  const result = conversations.submit(approved)
  assert.equal(conversations.submit(approved).jobs[0].id, result.jobs[0].id)
  await until(() => result.jobs.every((j) => queue.get(j.id).state === 'done'))
  for (const j of result.jobs.map((j) => queue.get(j.id))) {
    assert.equal(j.prompt, 'identity-token, a red vase.'); assert.equal(j.originalPrompt, one.turn.request.prompt)
    const record = JSON.parse(readFileSync(join(j.runDir, 'run.json'), 'utf8'))
    assert.equal(record.director.finalPrompt, j.prompt); assert.equal(record.director.generatedPrompt, response.shared)
    assert.equal(disk.get(result.chat.id).messages.find((m) => m.jobId === j.id).effectivePrompt, j.prompt)
  }
  const automatic = make('auto'); director.start(automatic); const auto = await done(automatic.id)
  assert.equal(auto.state, 'done'); assert.equal(auto.result.jobs.length, 2, 'Automatic mode submits without a client')
  await until(() => auto.result.jobs.every((j) => queue.get(j.id).state === 'done'))
  response = { a: 'identity-token, one vase.', b: 'identity-token, the same vase.' }
  const perModel = make('preview', 'per-model'); director.start(perModel)
  assert.notEqual((await done(perModel.id)).preview.prompts.a, director.status(perModel.id).preview.prompts.b)
  response = { shared: 'Missing trigger.' }; const bad = make('auto'); director.start(bad)
  assert.match((await done(bad.id)).error, /protected text/); assert.equal(director.status(bad.id).result, undefined)
  response = 'not JSON'; const invalid = make(); director.start(invalid)
  assert.match((await done(invalid.id)).error, /valid rewrite/)
  response = { shared: 'identity-token, a blue vase.' }
  // Source pixels are never claimed unless actually supplied to a capable model.
  const source = join(runs, 'source.png'); writeFileSync(source, 'fixture')
  const edit = make(); edit.turn.request.images = [source]; director.start(edit)
  const noVision = await done(edit.id); assert.equal(noVision.preview.provenance.visionUsed, false); assert.match(noVision.preview.warnings[0], /text-only/)
  assert.equal(requestBody.messages[1].images, undefined)
  vision = true; const visual = make(); visual.turn.request.images = [source]; director.start(visual)
  assert.equal((await done(visual.id)).preview.provenance.visionUsed, true); assert.deepEqual(requestBody.messages[1].images, ['fixture-base64'])
  // Cancellation holds the queue until cleanup finishes, including queued cancellation.
  hold = {}; let releaseUnload; unloadHold = new Promise((r) => { releaseUnload = r })
  const cancelled = make('auto'); director.start(cancelled); await until(() => hold.resolve)
  const queued = make(); director.start(queued); queue.cancel(queued.id); assert.equal(director.status(queued.id).state, 'cancelled')
  queue.cancel(cancelled.id)
  let nextRan = false; queue.enqueueWork('after-cancel', 'After cancel', async () => { assert.equal(loaded, false); nextRan = true; return '' })
  await delay(30); assert.equal(nextRan, false)
  releaseUnload(); await done(cancelled.id); await until(() => nextRan)
  assert.equal(director.status(cancelled.id).result, undefined)
  hold = undefined; unloadHold = undefined
  // Warm previews retain the exact model, but every generation waits for release.
  info = await director.info()
  info = await director.configure({ ...info.config, keepWarm: true })
  const warm = make(); director.start(warm); assert.equal((await done(warm.id)).state, 'done')
  assert.equal(requestBody.keep_alive, '2m'); assert.equal(loaded, true)
  const repeatWarm = make(); director.start(repeatWarm); await done(repeatWarm.id); assert.equal(loaded, true)
  let releaseGuard; unloadHold = new Promise((r) => { releaseGuard = r })
  const blockedGeneration = queue.enqueue({ modality: 'image', adapterIds: ['a'], prompt: 'A vase.', params: { a: {} } })[0]
  await delay(30); assert.equal(queue.get(blockedGeneration.id).state, 'queued')
  queue.cancel(blockedGeneration.id)
  await delay(20); assert.equal(loaded, true, 'Cancelling does not skip cleanup')
  releaseGuard(); await until(() => queue.get(blockedGeneration.id).state === 'cancelled')
  assert.equal(loaded, false); unloadHold = undefined
  const warmAgain = make(); director.start(warmAgain); await done(warmAgain.id)
  unloadLag = 3
  const nextGeneration = queue.enqueue({ modality: 'image', adapterIds: ['a'], prompt: 'A vase.', params: { a: {} } })[0]
  await until(() => queue.get(nextGeneration.id).state === 'done'); assert.equal(loaded, false)
  const stuckWarm = make(); director.start(stuckWarm); await done(stuckWarm.id)
  unloadStuck = true
  const unsafeGeneration = queue.enqueue({ modality: 'image', adapterIds: ['a'], prompt: 'A vase.', params: { a: {} } })[0]
  await until(() => queue.get(unsafeGeneration.id).state === 'error')
  assert.match(queue.get(unsafeGeneration.id).error, /still loaded/)
  assert.equal(queue.get(unsafeGeneration.id).runDir, undefined, 'Do not spawn after failed release')
  unloadStuck = false
  const retryRelease = queue.enqueue({ modality: 'image', adapterIds: ['a'], prompt: 'A vase.', params: { a: {} } })[0]
  await until(() => queue.get(retryRelease.id).state === 'done'); assert.equal(loaded, false)
  response = 'not JSON'; const badWarm = make(); director.start(badWarm)
  assert.equal((await done(badWarm.id)).state, 'error'); assert.equal(loaded, false)
  response = { shared: 'identity-token, a blue vase.' }
  const warmAuto = make('auto'); director.start(warmAuto); const warmAutoDone = await done(warmAuto.id)
  assert.equal(requestBody.keep_alive, 0); assert.equal(loaded, false)
  await until(() => warmAutoDone.result.jobs.every((j) => queue.get(j.id).state === 'done'))
  await assert.rejects(director.configure({ ...info.config, keepWarm: 'yes' }), /warm-cache/)
  // A restart remembers pending model ownership, so a fresh queue cannot bypass release.
  const restartWarm = make(); director.start(restartWarm); await done(restartWarm.id); assert.equal(loaded, true)
  const freshQueue = new Runner()
  new Director(join(temp, 'settings'), runs, freshQueue, dependencies)
  const generationAfterRestart = freshQueue.enqueue({ modality: 'image', adapterIds: ['a'], prompt: 'A vase.', params: { a: {} } })[0]
  await until(() => freshQueue.get(generationAfterRestart.id).state === 'done'); assert.equal(loaded, false)
  // Completed previews survive restart, with exact provenance and source binding.
  const restarted = new Director(join(temp, 'settings'), runs, new Runner(), dependencies)
  assert.deepEqual(restarted.status(one.id).preview, first.preview)
  assert.equal(restarted.resolve(approved).directedPrompts.a, 'identity-token, a red vase.')
  // A stale chat cannot be rewritten or approved after another device changes it.
  const stale = make(); stale.turn.chat = { ...approved.chat }; assert.throws(() => director.start(stale), /another device/)
  // The editor can override a built-in, restore it, and save while Ollama is stopped.
  info = await director.info()
  const override = { id: 'faithful', name: 'My faithful director', instructions: 'EDITOR_OVERRIDE: use precise, simple prose.' }
  info = await director.configure({ ...info.config, profiles: [...info.config.profiles, override] })
  const customized = make(); director.start(customized)
  assert.equal((await done(customized.id)).preview.provenance.preset, override.name)
  assert.match(requestBody.messages[0].content, /EDITOR_OVERRIDE/)
  await assert.rejects(director.configure({ ...info.config, profiles: [override, override] }), /Invalid custom/)
  offline = true
  info = await director.configure({ ...info.config, profiles: info.config.profiles.filter((p) => p.id !== 'faithful') })
  assert.match(info.error, /Start Ollama/)
  await assert.rejects(director.configure({ ...info.config, model: 'not-installed' }), /Runtime stopped/)
  offline = false
  const restored = make(); director.start(restored)
  assert.equal((await done(restored.id)).preview.provenance.preset, 'Faithful')
  assert.doesNotMatch(requestBody.messages[0].content, /EDITOR_OVERRIDE/)
  // Two clients passing the initial revision check must not overwrite each other after I/O.
  let releaseTags; tagsHold = new Promise((r) => { releaseTags = r })
  const saveOne = director.configure({ ...info.config, profiles: [...info.config.profiles, { id: 'first', name: 'First', instructions: 'One.' }] })
  const saveTwo = director.configure({ ...info.config, profiles: [...info.config.profiles, { id: 'second', name: 'Second', instructions: 'Two.' }] })
  releaseTags()
  const concurrent = await Promise.allSettled([saveOne, saveTwo]); tagsHold = undefined
  assert.equal(concurrent.filter((r) => r.status === 'fulfilled').length, 1)
  assert.match(concurrent.find((r) => r.status === 'rejected').reason.message, /another device/)
  const afterRestart = new Director(join(temp, 'settings'), runs, new Runner(), dependencies)
  assert((await afterRestart.info()).config.profiles.some((p) => p.id === 'first'))
  console.log('Director editor persistence passed: built-in customization and restore, duplicate rejection, offline editing, concurrent-save conflict and restart.')
  console.log('Director passed: real serial queue, unload ordering, cancellation, same/per-model prompts, editable approvals, identity terms, source binding, custom settings conflicts, text/vision capability, automatic server submission, durable provenance, restart and stale-chat checks.')
} finally { rmSync(temp, { recursive: true, force: true }) }
