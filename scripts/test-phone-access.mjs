import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import https from 'node:https'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
const require = createRequire(import.meta.url)
const { build } = createRequire(import.meta.resolve('vite'))('esbuild')
const temp = mkdtempSync(join(tmpdir(), 'local-lab-phone-'))
let server
try {
  await build({ entryPoints: ['src/main/phone/server.ts', 'src/main/conversations.ts', 'src/main/director/service.ts', 'src/main/basic/service.ts', 'src/main/studio/service.ts', 'src/main/history-reset.ts'], outdir: temp,
    bundle: true, platform: 'node', format: 'cjs', outExtension: { '.js': '.cjs' }, logLevel: 'silent' })
  const { PhoneServer } = require(join(temp, 'phone/server.cjs'))
  const { Conversations } = require(join(temp, 'conversations.cjs'))
  const { Director } = require(join(temp, 'director/service.cjs'))
  const { BasicService } = require(join(temp, 'basic/service.cjs'))
const { HistoryReset } = require(join(temp, 'history-reset.cjs'))
const { StudioService } = require(join(temp, 'studio/service.cjs'))
  const jobs = [], listeners = new Set(), disk = new Map()
  const queue = { list: () => jobs, get: (id) => jobs.find((j) => j.id === id),
    enqueueWork: (id, label, work) => {
      const job = { id, kind: 'director', state: 'running' }; jobs.push(job)
      Promise.resolve().then(() => work(new AbortController().signal)).then(() => { job.state = 'done' }, (e) => { job.state = 'error'; job.error = String(e) }).finally(() => { for (const fn of listeners) fn(job) })
      return job
    }, beforeGeneration: () => () => {}, onUpdate: (fn) => { listeners.add(fn); return () => listeners.delete(fn) }, enqueue: (r) => {
    const created = r.adapterIds.map((id) => ({ id: randomUUID(), adapterId: id, adapterLabel: 'Test model', modality: r.modality,
      prompt: r.directedPrompts?.[id] ?? r.prompt, director: r.directorRecords?.[id], params: r.params[id], images: r.images, basic: r.basic, state: 'queued', queuedAt: Date.now(), log: '' }))
    jobs.push(...created); for (const j of created) for (const fn of listeners) fn(j); return created
  } }
  let director, basic
  const conversations = new Conversations(queue, { listChats: () => [...disk.values()], saveChat: (c) => disk.set(c.id, structuredClone(c)), deleteChat: (id) => disk.delete(id) }, (turn) => { basic.verify(turn); return director.resolve(turn) })
  const runs = join(temp, 'runs'), web = join(temp, 'web'), state = join(temp, 'state')
  mkdirSync(runs); mkdirSync(web); writeFileSync(join(web, 'index.html'), '<title>Test app</title><script type="module" src="/assets/first.js"></script>')
  const adapters = [{ id: 'test-image', label: 'Test image', modality: 'image', outputExt: 'png', family: 'test', acceptsImages: true,
    params: [{ key: 'steps', label: 'Steps', type: 'int', min: 1, max: 20, default: 8 }, { key: 'style', type: 'select', label: 'Style', options: [{ value: 'normal', label: 'Normal' }] }] }]
  director = new Director(join(temp, 'director-settings'), runs, queue, { adapters: () => adapters, chats: () => conversations.list(), submit: (turn) => conversations.submit(turn),
    fetch: async (url) => Response.json(url.endsWith('/api/tags') ? { models: [{ name: 'fixture-text', capabilities: ['completion'] }] }
      : url.endsWith('/api/chat') ? { message: { content: JSON.stringify({ prompts: { shared: 'A blue vase in soft light.' } }) } } : { models: [] }) })
  writeFileSync(join(temp, 'basic.json'), JSON.stringify({ models: { fast: 'test-image', detailed: 'test-image', video: 'test-image' } }))
  basic = new BasicService(join(temp, 'settings'), runs, join(temp, 'basic.json'), { adapters: () => adapters, available: () => adapters.map((a) => a.id), chats: () => conversations.list(), directorConfig: async () => (await director.info()).config })
  const studio = new StudioService(join(temp, 'settings'), runs)
const history = new HistoryReset(runs, join(temp, 'settings'), {
    busy: () => jobs.some(j => ['queued', 'running'].includes(j.state)),
    trash: async path => renameSync(path, join(temp, 'trashed-history')),
    reset: () => { disk.clear(); conversations.resetHistory(); jobs.splice(0); director.resetHistory(); basic.resetHistory(); studio.resetHistory() },
  })
const backend = { access: operation => history.access(operation),
    adapters: () => adapters, submit: (t) => history.access(() => conversations.submit(t)),
    call: (method, arg) => method === 'historyState' ? history.info() : method === 'historyPreview' ? history.preview() : method === 'historyClear' ? history.clear(arg) : history.access(() => ({ listAdapters: () => adapters, listJobs: () => jobs, listChats: () => conversations.list(), listHistory: () => [],
      studioInfo: () => studio.info(), studioUpdate: () => studio.update(arg), basicModifiers: () => basic.configureModifiers(arg), basicCatalog: () => basic.catalog(), basicPlan: () => basic.plan(arg), basicSave: () => basic.save(arg), basicDelete: () => basic.remove(arg),
      directorInfo: () => director.info(), directorConfigure: () => director.configure(arg), directorStart: () => director.start(arg), directorStatus: () => director.status(arg),
      deleteChat: () => conversations.remove(arg), cancel: () => { const j = jobs.find((j) => j.id === arg); if (j) j.state = 'cancelled' }, clearFinished: () => {} }[method]?.())),
    subscribe: (fn) => { const a = queue.onUpdate((j) => fn('job', j)), b = conversations.onChange(() => fn('chats', null)), c = studio.onChange(() => fn('studio', null)), d = basic.onChange(() => fn('basic', null)), e = history.onChange(() => fn('history-reset', null)); return () => { a(); b(); c(); d(); e() } },
  }
  server = new PhoneServer(state, web, runs, backend, { address: '127.0.0.1', hostname: 'localhost', port: 18443, setupPort: 18444 })
  assert.equal(server.status().enabled, false)
  await server.start()
  const ca = readFileSync(join(state, 'ca.pem'))
  let session = ''
  function req(path, data, extra = {}, method = data === undefined ? 'GET' : 'POST') {
    return new Promise((resolve, reject) => {
      const raw = data === undefined ? undefined : Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data))
      const r = https.request({ host: '127.0.0.1', port: 18443, servername: 'localhost', ca, path, method,
        headers: { Host: 'localhost:18443', ...(session ? { Cookie: session } : {}),
          ...(raw ? { Origin: 'https://localhost:18443', 'X-Lab-Request': '1', 'Content-Type': 'application/json', 'Content-Length': raw.length } : {}), ...extra } }, (res) => {
          const parts = []; res.on('data', (p) => parts.push(p)); res.on('end', () => { const body = Buffer.concat(parts); let value; try { value = JSON.parse(body.toString()) } catch {} resolve({ status: res.statusCode, headers: res.headers, body, value }) })
        })
      r.on('error', reject); r.end(raw)
    })
  }
  assert.equal((await req('/')).status, 200)
  assert.equal((await req('/api/session')).status, 401)
  assert.equal((await req('/api/version')).status, 401)
  assert.equal((await req('/api/rpc', { method: 'listChats' })).status, 401)
  assert.equal((await req('/', undefined, { Host: 'attacker.invalid:18443' })).status, 403)
  assert.equal((await req('/api/pair', { code: 'wrong' })).status, 403)
  await server.pairing()
  const expiredCode = server.status().code
  const now = Date.now
  Date.now = () => now() + 6 * 60000
  try { assert.equal((await req('/api/pair', { code: expiredCode })).status, 403) }
  finally { Date.now = now }
  const pairing = await server.pairing()
  assert.match(pairing.code, /^\d{6}$/)
  assert.match(pairing.qr, /^data:image\/png;base64,/)
  const setup = await new Promise((resolve, reject) => http.get('http://127.0.0.1:18444/local-lab.cer', (r) => { const parts = []; r.on('data', (p) => parts.push(p)); r.on('end', () => resolve({ status: r.statusCode, data: Buffer.concat(parts) })) }).on('error', reject))
  assert.equal(setup.status, 200); assert(setup.data.length > 1000)
  const denied = await new Promise((resolve) => http.get('http://127.0.0.1:18444/api/rpc', (r) => { r.resume(); resolve(r.statusCode) }))
  assert.equal(denied, 404)
  assert.equal((await req('/api/pair', { code: pairing.code }, { Origin: 'https://evil.example' })).status, 403)
  const pending = await req('/api/pair', { code: pairing.code, name: 'Test phone' })
  assert.equal(pending.status, 200)
  session = pending.headers['set-cookie'][0].split(';')[0]
  assert.equal((await req('/api/session')).status, 401)
  assert.equal((await req('/api/pair')).value.pending, true)
  server.approve(pending.value.id, true)
  const accepted = await req('/api/pair')
  assert.equal(accepted.value.paired, true)
  assert(accepted.headers['set-cookie'][0].includes('Secure; HttpOnly; SameSite=Strict'))
  session = accepted.headers['set-cookie'][0].split(';')[0]
  assert.equal((await req('/api/session')).status, 200)
  assert.equal((await req('/api/rpc', { method: 'phoneApprove' })).status, 404)
  assert.equal((await req('/api/rpc', { method: 'listChats' }, { 'X-Lab-Request': '' })).status, 403)
  assert.equal((await req('/api/rpc', { method: 'listChats' }, { Origin: 'https://evil.example' })).status, 403)
  const png = readFileSync('src/renderer/public/icon.png')
  const uploaded = await req('/api/upload', png)
  assert.equal(uploaded.status, 200); assert(uploaded.value.path.endsWith('.png'))
  const media = uploaded.value.path
  assert.equal((await req(media)).body.length, png.length)
  const range = await req(media, undefined, { Range: 'bytes=5-15' })
  assert.equal(range.status, 206); assert.deepEqual(range.body, png.subarray(5, 16))
  assert.equal((await req(media, undefined, { Range: 'bytes=999999999-' })).status, 416)
  assert.equal((await req(media, undefined, { Range: 'bytes=-0' })).status, 416)
  assert.equal((await req(media, undefined, { Range: 'bytes=nonsense' })).status, 416)
  assert.equal((await req(media, undefined, {}, 'HEAD')).body.length, 0)
  assert((await req(media + '?download=1')).headers['content-disposition'].startsWith('attachment'))
  assert.equal((await req(media.replace(/assets\//, 'assets/X'))).status, 400)
  const secretFile = join(runs, 'chats.json'); writeFileSync(secretFile, '{"private":true}')
  assert.equal((await req(server.assets.token(secretFile))).status, 404)
  const link = join(runs, 'escape.png'); writeFileSync(link, png)
  const linkToken = server.assets.token(link); rmSync(link); symlinkSync(join(state, 'ca.key'), link)
  assert.equal((await req(linkToken)).status, 400)
  assert.equal((await req('/api/upload', Buffer.from('<svg>bad</svg>'))).status, 400)
  const turn = { turnId: randomUUID(), chat: { id: randomUUID(), modality: 'image', title: 'Test shared chat', contextOn: true }, contextUsed: false,
    request: { modality: 'image', adapterIds: ['test-image'], prompt: 'A blue vase.', params: { 'test-image': { steps: 8 } }, images: [media] } }
  const rpc = (method, arg) => req('/api/rpc', { method, arg })
  const firstVersion = await req('/api/version')
  assert.equal(firstVersion.status, 200); assert.equal(firstVersion.value.bundle, '/assets/first.js')
  assert.match(firstVersion.headers['cache-control'], /no-store/)
  writeFileSync(join(web, 'index.html'), '<script type="module" src="/assets/second.js"></script>')
  assert.notEqual((await req('/api/version')).value.version, firstVersion.value.version)
  assert.equal((await req('/api/version')).value.bundle, '/assets/second.js')
  assert.deepEqual((await rpc('studioInfo')).value.favorites, [])
  assert.equal((await rpc('studioUpdate', {kind:'favorite',path:media,value:true})).status,200)
  assert.deepEqual((await rpc('studioInfo')).value.favorites,[media])
  assert.equal(studio.info().favorites[0],server.assets.path(media))
  assert.equal((await rpc('studioUpdate', {kind:'subjectImage',id:'subject',thumbnail:media})).status,200)
  assert.equal((await rpc('studioInfo')).value.subjectImages[0].thumbnail,media)
  assert.equal((await rpc('studioUpdate', {kind:'favorite',path:'/etc/passwd',value:true})).status,400)
  assert.equal((await rpc('studioUpdate', {kind:'subjectImage',id:'subject',thumbnail:'/etc/passwd'})).status,400)
  assert.equal((await rpc('studioUpdate', {kind:'title',id:turn.chat.id,title:'My project'})).status,200)
  const modifierConfig=(await rpc('basicCatalog')).value.modifiers
  assert.equal((await rpc('basicModifiers',{...modifierConfig,moods:[]})).status,400)
  modifierConfig.intensities[1].instructions='Use confident editorial posing.'
  const modifierSave=await rpc('basicModifiers',modifierConfig);assert.equal(modifierSave.status,200)
  assert.equal(modifierSave.value.modifiers.intensities[1].instructions,'Use confident editorial posing.')
  assert.equal((await rpc('basicModifiers',modifierConfig)).status,400)
  const first = await rpc('submitTurn', turn)
  assert.equal(first.status, 200); assert.equal(jobs.length, 1)
  assert.equal(first.value.chat.messages.length, 2)
  assert.equal(first.value.chat.messages[1].images[0], media)
  assert.equal((await rpc('submitTurn', turn)).status, 200); assert.equal(jobs.length, 1, 'Retry must be idempotent')
  const stale = { ...turn, turnId: randomUUID() }
  assert.match((await rpc('submitTurn', stale)).value.error, /changed on another device/)
  const invalid = structuredClone(turn); invalid.turnId = randomUUID(); invalid.chat.revision = 1; invalid.request.params['test-image'].steps = 1e9
  assert.equal((await rpc('submitTurn', invalid)).status, 400)
  invalid.request.params['test-image'] = { style: '/tmp/arbitrary-model' }
  assert.equal((await rpc('submitTurn', invalid)).status, 400)
  invalid.request.params['test-image'] = {}; invalid.request.images = ['/etc/passwd']
  assert.equal((await rpc('submitTurn', invalid)).status, 400)
  // Completing a job with no client window must update durable chat state.
  jobs[0].state = 'done'; jobs[0].outputPath = server.assets.path(media); jobs[0].startedAt = Date.now() - 10; jobs[0].finishedAt = Date.now()
  for (const fn of listeners) fn(jobs[0])
  assert.equal(disk.get(turn.chat.id).messages[1].state, 'done')
  assert.equal((await rpc('listChats')).value[0].messages[1].outputPath, media)
  assert.equal(conversations.list()[0].messages[1].outputPath, server.assets.path(media), 'Wire transformation must not mutate desktop state')
  // Director routes retain the same authentication, source-token validation and provenance.
  assert.equal((await rpc('directorInfo')).value.models[0].vision, false)
  const rewriteTurn = structuredClone(turn); rewriteTurn.turnId = randomUUID(); rewriteTurn.chat.id = randomUUID()
  const rewriteInput = { id: rewriteTurn.turnId, turn: rewriteTurn, choice: { mode: 'preview', preset: 'edit', freedom: 'low', comparison: 'same' } }
  assert.equal((await rpc('directorStart', rewriteInput)).status, 200)
  let rewrite
  for (let n = 0; n < 20; n++) { rewrite = (await rpc('directorStatus', rewriteInput.id)).value; if (rewrite.state === 'done') break; await new Promise((r) => setTimeout(r, 5)) }
  assert.equal(rewrite.state, 'done'); assert.equal(rewrite.preview.turn.request.images[0], media)
  const approval = rewrite.preview.turn
  approval.request.director = { previewId: rewriteInput.id, prompts: { 'test-image': 'A blue vase, with one white flower.' } }
  const generated = await rpc('submitTurn', approval)
  assert.equal(generated.status, 200); assert.equal(generated.value.jobs[0].prompt, 'A blue vase, with one white flower.')
  assert.equal(generated.value.jobs[0].director.originalPrompt, turn.request.prompt)
  assert.equal(generated.value.jobs[0].images[0], media)
  const escaped = structuredClone(rewriteInput); escaped.id = escaped.turn.turnId = randomUUID(); escaped.turn.request.images = ['/etc/passwd']
  assert.equal((await rpc('directorStart', escaped)).status, 400)
  assert.equal((await rpc('directorStatus', '../escape')).status, 400)
  // Basic recipes and preset thumbnails use the same authenticated asset boundary.
  assert.equal((await rpc('basicCatalog')).status, 200)
  const savedPreset = await rpc('basicSave', { id: '', version: 0, name: 'Phone edit', workflow: 'edit', adapterId: 'test-image', params: { steps: 8 }, exposed: ['steps'], director: 'adult', thumbnail: media })
  assert.equal(savedPreset.status, 200); const preset = savedPreset.value.presets[0]; assert.equal(preset.thumbnail, media)
  const basicInput = { id: randomUUID(), workflow: 'edit', presetId: preset.id, prompt: 'Change the vase to red.', sourceImage: media, subject: '', quality: 'fast', aspect: '1:1', duration: '97', assistance: 'off', mood: 'glamour', values: { steps: 10 } }
  const basicPlan = await rpc('basicPlan', basicInput); assert.equal(basicPlan.status, 200); assert.equal(basicPlan.value.turn.request.images[0], media)
  const basicResult = await rpc('submitTurn', basicPlan.value.turn); assert.equal(basicResult.status, 200); assert.equal(basicResult.value.chat.messages[1].requestSnapshot.images[0], media); assert.equal(basicResult.value.jobs[0].basic.adult, true)
  assert.deepEqual((await rpc('basicPlan', basicInput)).value, basicPlan.value)
  assert.equal((await rpc('basicPlan', { ...basicInput, id: randomUUID(), sourceImage: '/etc/passwd' })).status, 400)
  assert.equal((await rpc('basicDelete', { id: preset.id, version: preset.version })).status, 200)
  // Stopping and restoring the service retains device sessions and media identifiers.
  await server.stop(false)
  server = new PhoneServer(state, web, runs, backend, { address: '127.0.0.1', hostname: 'localhost', port: 18443, setupPort: 18444 })
  await server.restore()
  assert.equal((await req('/api/session')).status, 200)
  assert.equal((await req(media)).status, 200)
  // SSE sends a reconnect signal and receives live transitions.
  let stream
  const opened = new Promise((resolve, reject) => {
    stream = https.get({ host: '127.0.0.1', port: 18443, servername: 'localhost', ca, path: '/api/events', headers: { Host: 'localhost:18443', Cookie: session } }, (res) => {
      res.once('data', (d) => { assert.match(d.toString(), /event: sync/); resolve(res) })
    }); stream.on('error', reject)
  })
  const sse = await opened
  const update = new Promise((resolve) => sse.once('data', (d) => { assert.match(d.toString(), /event: job/); resolve() }))
  for (const fn of listeners) fn(jobs[0]); await update
  const studioEvent = new Promise((resolve) => sse.once('data', (d) => { assert.match(d.toString(), /event: studio/); resolve() }))
  await rpc('studioUpdate', {kind:'favorite',path:media,value:false}); await studioEvent
  assert.deepEqual((await rpc('studioInfo')).value.favorites,[])
  const modifierEvent = new Promise((resolve) => sse.once('data', (d) => { assert.match(d.toString(), /event: basic/); resolve() }))
  const freshModifiers=(await rpc('basicCatalog')).value.modifiers
  freshModifiers.moods[0].description='Synced from the paired client.'
  assert.equal((await rpc('basicModifiers',freshModifiers)).status,200);await modifierEvent
  // Reset is authenticated, rejects active work, synchronizes clients, and preserves configuration.
  assert.equal((await rpc('historyState')).value.resetId, 'initial')
  let resetPreview=(await rpc('historyPreview')).value
  assert(resetPreview.busy)
  assert.equal((await rpc('historyClear',{token:resetPreview.token,confirmation:'CLEAR'})).status,400)
  for(const j of jobs)j.state='done'
  const savedAgain=await rpc('basicSave',{id:'',version:0,name:'Keep this preset',workflow:'edit',adapterId:'test-image',params:{steps:8},exposed:['steps'],director:'adult',thumbnail:media})
  assert.equal(savedAgain.status,200)
  const preservedModifiers=(await rpc('basicCatalog')).value.modifiers
  const resetEvents=[];sse.on('data',d=>resetEvents.push(d.toString()))
  resetPreview=(await rpc('historyPreview')).value
  assert.equal((await rpc('historyClear',{token:resetPreview.token,confirmation:'wrong'})).status,400)
  const resetResult=await rpc('historyClear',{token:resetPreview.token,confirmation:'CLEAR'})
  assert.equal(resetResult.status,200);assert.notEqual(resetResult.value.resetId,'initial')
  assert.deepEqual((await rpc('listChats')).value,[]);assert.deepEqual((await rpc('listJobs')).value,[])
  assert.deepEqual((await rpc('studioInfo')).value.subjectImages,[])
  assert.equal((await req('/api/session')).status,200)
  assert.notEqual((await req(media)).status,200)
  const afterReset=(await rpc('basicCatalog')).value
  assert.equal(afterReset.presets[0].name,'Keep this preset');assert.equal(afterReset.presets[0].thumbnail,undefined)
  assert.deepEqual(afterReset.modifiers,preservedModifiers)
  assert(resetEvents.join('').includes('event: history-reset'))
  const oldChat={...turn,turnId:randomUUID(),chat:{...turn.chat,revision:1},request:{...turn.request,images:[]}}
  assert.match((await rpc('submitTurn',oldChat)).value.error,/no longer available/)
  const newTurn={...oldChat,turnId:randomUUID(),chat:{...turn.chat,id:randomUUID()}}
  assert.equal((await rpc('submitTurn',newTurn)).status,200)
  server.revoke(pending.value.id)
  assert.equal((await req('/api/session')).status, 401)
  assert.equal((await req(media)).status, 401)
  stream.destroy()
  await server.stop()
  assert.equal(server.status().enabled, false)
  console.log('Phone access passed: verified TLS, bootstrap isolation, pairing approval, CSRF/Host checks, auth, uploads, signed assets, symlink escape, byte ranges, parameter validation, shared durable chats, idempotency, conflicts, director preview/approval/source binding, SSE, authenticated reset with busy protection, cleared media/chats, preserved pairing/presets/modifiers, post-reset generation and immediate revocation.')
} finally {
  await server?.stop()
  rmSync(temp, { recursive: true, force: true })
}
