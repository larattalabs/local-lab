// Live integration test for the Code tab: drives BOTH harnesses (omp and
// opencode) through the real CodeService against a real local model, in a
// throwaway folder. Needs the model's server to be startable on this Mac.
//
//   node scripts/test-code-harness.mjs                      # smallest model in the catalog
//   CODE_TEST_MODEL=omlx/<model id> node scripts/test-code-harness.mjs
//   CODE_TEST_HARNESS=omp node scripts/test-code-harness.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { build } = createRequire(import.meta.resolve('vite'))('esbuild')
let MODEL = process.env.CODE_TEST_MODEL
const HARNESSES = (process.env.CODE_TEST_HARNESS ?? 'omp,opencode').split(',')
const TURN_MS = Number(process.env.CODE_TEST_TURN_MS ?? 300_000)

const out = realpathSync(mkdtempSync(join(tmpdir(), 'code-build-')))
const project = realpathSync(mkdtempSync(join(tmpdir(), 'code-project-')))
const userData = realpathSync(mkdtempSync(join(tmpdir(), 'code-userdata-')))
// Keep test sessions out of the user's opencode database and omp history.
process.env.OPENCODE_DB = join(userData, 'opencode.db')
process.env.LOCALLAB_OMP_SESSION_DIR = join(userData, 'omp-sessions')
await build({ entryPoints: ['src/main/code/service.ts', 'src/shared/code.ts'], outdir: out, bundle: true, platform: 'node', format: 'cjs', outExtension: { '.js': '.cjs' }, logLevel: 'silent' })
const { CodeService } = require(join(out, 'main/code/service.cjs'))
const { reduceCode } = require(join(out, 'shared/code.cjs'))

const svc = new CodeService(userData, () => false)
const events = new Map()
svc.onPush((p) => { if (p) (events.get(p.sessionId) ?? events.set(p.sessionId, []).get(p.sessionId)).push(p.event) })

function waitFor(id, pred, label) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = setInterval(() => {
      const evs = events.get(id) ?? []
      const hit = evs.find(pred)
      if (hit) { clearInterval(tick); resolve(hit) }
      else if (Date.now() - t0 > TURN_MS) { clearInterval(tick); reject(new Error(`timeout waiting for ${label}; last events: ${JSON.stringify(evs.slice(-8))}`)) }
    }, 200)
  })
}
const turnEnds = (id) => (events.get(id) ?? []).filter((e) => e.type === 'turn-end').length

const { models, harnesses } = await svc.catalog()
// Default: the smallest always-installed-server model (fast, and keeps model names out of this file).
MODEL ??= models.filter((m) => ['omlx', 'ollama'].includes(m.backend) && m.ramGB > 0).sort((a, b) => a.ramGB - b.ramGB)[0]?.id
assert.ok(models.find((m) => m.id === MODEL), `catalog has ${MODEL} (have: ${models.map((m) => m.id).join(', ')})`)
const results = []
try {
  for (const harness of HARNESSES) {
    assert.ok(harnesses[harness], `${harness} is installed`)
    const t0 = Date.now()

    // 1. Full-auto: the agent writes a file with a tool and the turn ends cleanly.
    const s = await svc.create({ cwd: project, harness, modelId: MODEL, mode: 'auto' })
    const file = join(project, `hello-${harness}.txt`)
    await svc.send(s.id, `Use your file-writing tool to create the file hello-${harness}.txt in the current directory containing exactly: hi from ${harness}. Then reply with the single word DONE.`)
    await waitFor(s.id, (e) => e.type === 'turn-end', `${harness} auto turn`)
    const evs = events.get(s.id)
    assert.ok(evs.some((e) => e.type === 'tool-start'), `${harness}: saw tool-start`)
    assert.ok(evs.some((e) => e.type === 'tool-end' && !e.error), `${harness}: saw successful tool-end`)
    assert.ok(evs.some((e) => e.type === 'text'), `${harness}: saw streamed text`)
    assert.ok(existsSync(file), `${harness}: ${file} exists`)
    assert.match(readFileSync(file, 'utf8'), new RegExp(`hi from ${harness}`))
    // Main-side reduction matches a fresh reduction of the same events.
    const replay = evs.reduce(reduceCode, { items: [] })
    assert.deepEqual(svc.open(s.id).transcript.items.map((i) => i.kind), replay.items.map((i) => i.kind))
    assert.ok(svc.list().find((x) => x.id === s.id).harnessRef, `${harness}: resume handle recorded`)

    // 2. Ask mode: an edit must wait for approval, and approving lets it land.
    await svc.configure(s.id, { mode: 'ask' })
    const before = turnEnds(s.id)
    const file2 = join(project, `approved-${harness}.txt`)
    await svc.send(s.id, `Now create approved-${harness}.txt containing exactly: ok. Use the file-writing tool.`)
    const ask = await waitFor(s.id, (e) => e.type === 'approval', `${harness} approval request`)
    assert.ok(!existsSync(file2), `${harness}: nothing written before approval`)
    await svc.answer(s.id, ask.id, true)
    await waitFor(s.id, (e, i, all) => e.type === 'turn-end' && turnEnds(s.id) > before, `${harness} ask turn`)
    assert.ok(existsSync(file2), `${harness}: approved write landed`)
    assert.ok(events.get(s.id).some((e) => e.type === 'approval-resolved' && e.id === ask.id && e.approved), `${harness}: approval resolved`)

    // 3. The session resumes after the driver is dropped (same harness session).
    await svc.configure(s.id, { mode: 'auto' })
    const before3 = turnEnds(s.id)
    await svc.send(s.id, 'What was the name of the first file you created in this conversation? Answer with just the file name.')
    await waitFor(s.id, () => turnEnds(s.id) > before3, `${harness} resumed turn`)
    const answer = svc.open(s.id).transcript.items.filter((i) => i.kind === 'assistant').at(-1)?.text ?? ''
    results.push({ harness, seconds: Math.round((Date.now() - t0) / 1000), resumedAnswer: answer.trim().slice(0, 80) })
    assert.match(answer, new RegExp(`hello-${harness}`), `${harness}: remembered earlier turn after restart`)
  }
  console.log('PASS', JSON.stringify(results))
} catch (e) {
  for (const [id, evs] of events) console.error(`--- events for ${id}\n` + evs.map((x) => JSON.stringify(x).slice(0, 300)).join('\n'))
  throw e
} finally {
  svc.shutdown()
  rmSync(out, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
}
