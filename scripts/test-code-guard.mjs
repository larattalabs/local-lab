// Deterministic test of the Code tab's folder guard on BOTH harnesses.
//
// A fake OpenAI-compatible server takes oMLX's port (:8080) and answers every
// prompt "WRITE <path>" with a write tool call to <path>, then "DONE". So the
// test controls exactly where the "model" writes and checks:
//   - auto-accept edits: a write INSIDE the folder runs without asking
//   - auto-accept edits: a write OUTSIDE the folder asks; deny → nothing written
//   - auto-accept edits: outside + approve → written
//   - full auto: outside runs without asking
// Stop oMLX first (port 8080 must be free); no real model is loaded.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { build } = createRequire(import.meta.resolve('vite'))('esbuild')
const HARNESSES = (process.env.CODE_TEST_HARNESS ?? 'omp,opencode').split(',')

const fake = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ data: [{ id: MODEL_ID, max_model_len: 131072 }] }))
    }
    const j = JSON.parse(body || '{}')
    const msgs = j.messages ?? []
    const last = msgs.at(-1)
    const userText = [...msgs].reverse().find((m) => m.role === 'user')
    const text = typeof userText?.content === 'string' ? userText.content : (userText?.content ?? []).map((p) => p.text ?? '').join(' ')
    const target = text.match(/(?:WRITE|EDITOMP) (\S+)/)?.[1]
    const ompEdit = /EDITOMP /.test(text)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = (delta, finish = null) => res.write('data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: MODEL_ID, choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n')
    if (last?.role !== 'tool' && target && j.tools?.length) {
      // omp's hashline edit names the file only inside its `input` blob.
      const [name, args] = ompEdit
        ? ['edit', JSON.stringify({ input: `[${target}#0000]\n1:=guard-test` })]
        : ['write', JSON.stringify({ path: target, content: 'guard-test' })]
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + Math.random().toString(36).slice(2, 8), type: 'function', function: { name, arguments: args } }] })
      chunk({}, 'tool_calls')
    } else {
      chunk({ role: 'assistant', content: 'DONE' })
      chunk({}, 'stop')
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
let MODEL_ID = ''
await new Promise((resolve, reject) => { fake.once('error', reject); fake.listen(8080, '127.0.0.1', resolve) })
  .catch(() => { console.error('Port 8080 is busy: stop oMLX first (Code tab → Model servers → stop).'); process.exit(2) })

const out = realpathSync(mkdtempSync(join(tmpdir(), 'guard-build-')))
const userData = realpathSync(mkdtempSync(join(tmpdir(), 'guard-ud-')))
process.env.OPENCODE_DB = join(userData, 'opencode.db')
process.env.LOCALLAB_OMP_SESSION_DIR = join(userData, 'omp-sessions')
process.env.LOCALLAB_CODE_IDLE_UNLOAD_MS = '0'
await build({ entryPoints: ['src/main/code/service.ts'], outdir: out, bundle: true, platform: 'node', format: 'cjs', outExtension: { '.js': '.cjs' }, logLevel: 'silent' })
const { CodeService } = require(join(out, 'service.cjs'))
const svc = new CodeService(userData, () => false, join(userData, 'uploads'))
const { models } = await svc.catalog()
const model = models.find((m) => m.backend === 'omlx' && !m.reasoning) ?? models.find((m) => m.backend === 'omlx')
assert.ok(model, 'an oMLX model is in the catalog (the fake server stands in for it)')
MODEL_ID = model.model

const events = new Map()
svc.onPush((p) => { if (p) (events.get(p.sessionId) ?? events.set(p.sessionId, []).get(p.sessionId)).push(p.event) })
const evs = (id) => events.get(id) ?? []
async function turn(id, text, onApproval) {
  const start = evs(id).length
  const ends = () => evs(id).slice(start).filter((e) => e.type === 'turn-end').length
  const answered = new Set()
  await svc.send(id, text)
  for (let t0 = Date.now(); !ends(); ) {
    if (Date.now() - t0 > 120_000) throw new Error('turn timed out: ' + JSON.stringify(evs(id).slice(-6)))
    for (const e of evs(id).slice(start)) {
      if (e.type === 'approval' && !answered.has(e.id)) { answered.add(e.id); await svc.answer(id, e.id, onApproval(e)) }
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return evs(id).slice(start).filter((e) => e.type === 'approval')
}

const scratch = []
try {
  for (const harness of HARNESSES) {
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'guard-proj-')))
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'guard-outside-')))
    scratch.push(project, outside)
    const s = await svc.create({ cwd: project, harness, modelId: model.id, mode: 'edit' })

    let asks = await turn(s.id, 'WRITE inside.txt', () => true)
    assert.equal(asks.length, 0, `${harness}: inside write needs no approval in auto-accept edits`)
    assert.ok(existsSync(join(project, 'inside.txt')), `${harness}: inside write landed`)

    asks = await turn(s.id, `WRITE ${join(outside, 'denied.txt')}`, () => false)
    assert.ok(asks.length >= 1, `${harness}: outside write asked (${asks.map((a) => a.title).join(' | ')})`)
    assert.ok(!existsSync(join(outside, 'denied.txt')), `${harness}: denied outside write did not land`)

    asks = await turn(s.id, `WRITE ${join(outside, 'approved.txt')}`, () => true)
    assert.ok(asks.length >= 1, `${harness}: outside write asked again`)
    assert.ok(existsSync(join(outside, 'approved.txt')), `${harness}: approved outside write landed`)

    if (harness === 'omp') {
      asks = await turn(s.id, `EDITOMP ${join(outside, 'edited.txt')}`, () => false)
      assert.ok(asks.length >= 1, `omp: outside hashline edit asked (${asks.map((a) => a.title).join(' | ')})`)
      assert.ok(!existsSync(join(outside, 'edited.txt')), 'omp: denied outside edit did not land')
    }

    await svc.configure(s.id, { mode: 'auto' })
    asks = await turn(s.id, `WRITE ${join(outside, 'auto.txt')}`, () => false)
    assert.equal(asks.length, 0, `${harness}: full auto does not ask`)
    assert.ok(existsSync(join(outside, 'auto.txt')), `${harness}: full auto wrote outside`)
    console.log('ok', harness)
  }
  console.log('PASS')
} finally {
  svc.shutdown()
  fake.close()
  for (const p of [out, userData, ...scratch]) rmSync(p, { recursive: true, force: true })
}
