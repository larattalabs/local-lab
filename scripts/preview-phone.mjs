// Disposable, loopback-only UI fixture. Never uses real models, chats or credentials.
// The production HTTPS/auth server runs behind a localhost test proxy so browser
// layout checks do not require installing a CA in the developer's global trust store.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import http from 'node:http'
import https from 'node:https'
import { execFileSync } from 'node:child_process'
const require = createRequire(import.meta.url)
const { build } = createRequire(import.meta.resolve('vite'))('esbuild')
const temp = mkdtempSync(join(tmpdir(), 'lab-phone-preview-'))
await build({ entryPoints: ['src/main/phone/server.ts', 'src/main/conversations.ts', 'src/main/director/service.ts', 'src/main/basic/service.ts', 'src/main/studio/service.ts', 'src/main/history-reset.ts'], outdir: temp,
  bundle: true, platform: 'node', format: 'cjs', outExtension: { '.js': '.cjs' }, logLevel: 'silent' })
const { PhoneServer } = require(join(temp, 'phone/server.cjs'))
const { Conversations } = require(join(temp, 'conversations.cjs'))
const { Director } = require(join(temp, 'director/service.cjs'))
const { BasicService } = require(join(temp, 'basic/service.cjs'))
const { HistoryReset } = require(join(temp, 'history-reset.cjs'))
const { StudioService } = require(join(temp, 'studio/service.cjs'))
const runs = join(temp, 'runs'); mkdirSync(runs)
const output = join(runs, 'sample.png'); copyFileSync('src/renderer/public/icon.png', output)
const video = join(runs, 'sample.mp4')
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x222831:s=512x512:d=1:r=24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video])
const jobs = [], listeners = new Set(), disk = new Map()
if (process.env.LOCALLAB_PREVIEW_LIBRARY === '1000') {
  for (let i=0;i<200;i++) {
    const id='project-'+i, at=Date.now()-200000+i*10
    disk.set(id,{id,projectId:id,modality:'image',title:'Sample project '+i,contextOn:true,createdAt:at,updatedAt:at,
      messages:Array.from({length:5},(_,n)=>({id:id+'-'+n,role:'gen',at:at+n,adapterId:'fixture-image',adapterLabel:'Preview image model',
        state:'done',outputPath:output,effectivePrompt:'Sample '+n}))})
  }
}
if (process.env.LOCALLAB_PREVIEW_BUSY === '1') {
  const job={id:'background-preview',adapterId:'fixture-image',adapterLabel:'Preview image model',modality:'image',state:'running',prompt:'Preview',
    params:{},log:'',queuedAt:Date.now(),startedAt:Date.now()}
  jobs.push(job)
  let step=0
  setInterval(()=>{job.progress={label:'Generating',step:++step,total:100000};for(const fn of listeners)fn(job)},150).unref()
}
const queue = { beforeGeneration: () => () => {}, list: () => jobs, get: (id) => jobs.find((j) => j.id === id),
  enqueueWork: (id, label, work) => {
    const job = { id, kind: 'director', adapterId: 'prompt-director', adapterLabel: label, modality: 'text', state: 'running', params: {}, prompt: '', log: '', queuedAt: Date.now() }; jobs.push(job)
    Promise.resolve().then(() => work(new AbortController().signal)).then(() => { job.state = 'done' }, (e) => { job.state = 'error'; job.error = String(e) }).finally(() => { for (const fn of listeners) fn(job) })
    return job
  }, onUpdate: (fn) => { listeners.add(fn); return () => listeners.delete(fn) }, enqueue: (r) => {
  const made = r.adapterIds.map((id) => ({ id: randomUUID(), adapterId: id, adapterLabel: id, modality: r.modality, prompt: r.directedPrompts?.[id] ?? r.prompt, originalPrompt: r.prompt, director: r.directorRecords?.[id],
    params: r.params[id], images: r.images, basic: r.basic, state: 'queued', queuedAt: Date.now(), log: 'UI fixture — no model invoked.' }))
  jobs.push(...made)
  for (const j of made) setTimeout(() => { j.state = 'done'; mkdirSync(join(runs,j.modality),{recursive:true}); j.outputPath = join(runs,j.modality,j.id+(j.modality === 'video' ? '.mp4' : '.png')); copyFileSync(j.modality === 'video' ? video : output,j.outputPath); j.startedAt = j.queuedAt; j.finishedAt = Date.now(); for (const fn of listeners) fn(j) }, 1500)
  return made
} }
let director, basic
const conversations = new Conversations(queue, { listChats: () => [...disk.values()], saveChat: (c) => { disk.set(c.id,c); mkdirSync(join(runs,'chats'),{recursive:true}); writeFileSync(join(runs,'chats',c.id+'.json'),JSON.stringify(c)) }, deleteChat: (id) => disk.delete(id) }, (turn) => { basic.verify(turn); return director.resolve(turn) })
const select = (key, values) => ({ key, label: key, type: 'select', default: values[0], options: values.map((value) => ({ value, label: value })) })
const params = [select('aspect', ['1:1','2:3','3:2','9:16','16:9']),{ key: 'steps', label: 'Steps', type: 'int', min: 1, max: 50, default: 8 }, { key: 'seed', label: 'Seed', type: 'seed', default: null }]
const adapters = [{ id: 'fixture-image', label: 'Preview image model', modality: 'image', outputExt: 'png', family: 'UI preview', imageEditAdapterId: 'fixture-edit', params },
  { id: 'fixture-edit', label: 'Preview image editor', modality: 'image', outputExt: 'png', family: 'UI preview', acceptsImages: true, requiresImage: true, params },
  { id: 'fixture-video', label: 'Preview video model', modality: 'video', outputExt: 'mp4', family: 'UI preview', acceptsImages: true, params: [params.at(-1), select('resolution', ['512x512','448x768','768x448']), select('frames', ['49','97','121','241']), select('stage1_steps', ['4','8']), select('decoder', ['conv']), select('compute_precision', ['float16']), { key: 'no_audio', type: 'bool', default: true }] }]
adapters.push({...adapters.at(-1),id:'fixture-video-b',label:'Preview video B',frameRate:16})
director = new Director(join(temp, 'settings'), runs, queue, {
  adapters: () => adapters, chats: () => conversations.list(), submit: (turn) => conversations.submit(turn),
  fetch: async (url, options) => {
    if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'Fixture local text model', capabilities: ['completion'] }] })
    if (url.endsWith('/api/chat')) {
      await new Promise((r) => setTimeout(r, 700))
      const body = JSON.parse(options.body), data = JSON.parse(body.messages[1].content)
      const keys = body.format.properties.prompts.required
      return Response.json({ message: { content: JSON.stringify({ prompts: Object.fromEntries(keys.map((key) => [key, data.request + ' Preserve the selected subject and composition, with soft natural lighting.'])) }) } })
    }
    return Response.json({ models: [] })
  },
})
writeFileSync(join(temp, 'basic.json'), JSON.stringify({ models: { fast: 'fixture-image', detailed: 'fixture-image', video: 'fixture-video' } }))
basic = new BasicService(join(temp, 'settings'), runs, join(temp, 'basic.json'), { adapters: () => adapters, available: () => adapters.map((a) => a.id), chats: () => conversations.list(), directorConfig: async () => (await director.info()).config })
const studio = new StudioService(join(temp, 'settings'), runs)
const history = new HistoryReset(runs, join(temp, 'settings'), {
    busy: () => jobs.some(j => ['queued', 'running'].includes(j.state)),
    trash: async path => renameSync(path, join(temp, 'trashed-history')),
    reset: () => { disk.clear(); conversations.resetHistory(); jobs.splice(0); director.resetHistory(); basic.resetHistory(); studio.resetHistory() },
  })
const backend = { access: operation => history.access(operation), adapters: () => adapters, submit: (t) => history.access(() => conversations.submit(t)),
  call: (m, arg) => m === 'historyState' ? history.info() : m === 'historyPreview' ? history.preview() : m === 'historyClear' ? history.clear(arg) : history.access(() => ({ listAdapters: () => adapters, availability: () => adapters.map((a) => ({ id: a.id, available: true })),
    studioInfo: () => studio.info(), studioUpdate: () => studio.update(arg), basicModifiers: () => basic.configureModifiers(arg), basicCatalog: () => basic.catalog(), basicPlan: () => basic.plan(arg), basicSave: () => basic.save(arg), basicDelete: () => basic.remove(arg),
    directorInfo: () => director.info(), directorConfigure: () => director.configure(arg), directorStart: () => director.start(arg), directorStatus: () => director.status(arg),
    listJobs: () => jobs, listChats: () => conversations.list(), listHistory: () => [], deleteChat: () => conversations.remove(arg),
    clearFinished: () => { jobs.splice(0, jobs.length) }, cancel: () => {} }[m]?.())),
  subscribe: (fn) => { const a = queue.onUpdate((j) => fn('job', j)), b = conversations.onChange(() => fn('chats', null)), c = studio.onChange(() => fn('studio', null)), d = basic.onChange(() => fn('basic', null)), e = history.onChange(() => fn('history-reset', null)); return () => { a(); b(); c(); d(); e() } },
}
const phone = new PhoneServer(join(temp, 'state'), resolve('out/renderer'), runs, backend,
  { address: '127.0.0.1', hostname: 'localhost', port: 19443, setupPort: 19444 })
await phone.start(); const pairing = await phone.pairing()
const ca = readFileSync(join(temp, 'state/ca.pem'))
const proxy = http.createServer((req, res) => {
  const headers = { ...req.headers, host: 'localhost:19443' }
  if (headers.origin) headers.origin = 'https://localhost:19443'
  const upstream = https.request({ host: '127.0.0.1', port: 19443, servername: 'localhost', ca, path: req.url, method: req.method, headers }, (incoming) => {
    res.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(res)
  })
  upstream.on('error', () => { res.writeHead(502); res.end() }); req.pipe(upstream); res.on('close', () => upstream.destroy())
})
await new Promise((r) => proxy.listen(18787, '127.0.0.1', r))
const approve = setInterval(() => { for (const p of phone.status().pending) phone.approve(p.id, true) }, 2000)
console.log(JSON.stringify({ url: 'http://localhost:18787', fixturePairingCode: pairing.code, temp }))
async function stop() { clearInterval(approve); proxy.closeAllConnections(); proxy.close(); await phone.stop(); rmSync(temp, { recursive: true, force: true }); process.exit() }
process.on('SIGINT', stop); process.on('SIGTERM', stop)
