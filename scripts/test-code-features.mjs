// Live test of the Code tab's session features on BOTH harnesses, through the
// real CodeService and a real local vision model:
//   thinking off → on, image attachment, a message queued mid-turn, slash
//   command listing, context meter, manual compaction, git changes.
//
//   node scripts/test-code-features.mjs        # smallest vision model in the catalog
//   CODE_TEST_MODEL=<backend>/<id> CODE_TEST_HARNESS=omp node scripts/test-code-features.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { deflateSync } from 'node:zlib'

const require = createRequire(import.meta.url)
const { build } = createRequire(import.meta.resolve('vite'))('esbuild')
const HARNESSES = (process.env.CODE_TEST_HARNESS ?? 'omp,opencode').split(',')
const TURN_MS = Number(process.env.CODE_TEST_TURN_MS ?? 400_000)

const out = realpathSync(mkdtempSync(join(tmpdir(), 'code-build-')))
const userData = realpathSync(mkdtempSync(join(tmpdir(), 'code-userdata-')))
const uploads = join(userData, 'uploads'); mkdirSync(uploads)
process.env.OPENCODE_DB = join(userData, 'opencode.db')
process.env.LOCALLAB_OMP_SESSION_DIR = join(userData, 'omp-sessions')
await build({ entryPoints: ['src/main/code/service.ts'], outdir: out, bundle: true, platform: 'node', format: 'cjs', outExtension: { '.js': '.cjs' }, logLevel: 'silent' })
const { CodeService } = require(join(out, 'service.cjs'))

// A 64×64 solid red PNG, built by hand (no image library needed).
function png(r, g, b) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]) }
  const w = 64, h = 64, ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())])))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const svc = new CodeService(userData, () => false, uploads)
const events = new Map()
svc.onPush((p) => { if (p) (events.get(p.sessionId) ?? events.set(p.sessionId, []).get(p.sessionId)).push(p.event) })
const evs = (id) => events.get(id) ?? []
const ends = (id) => evs(id).filter((e) => e.type === 'turn-end').length
async function until(id, pred, label) {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > TURN_MS) throw new Error(`timeout: ${label}; last events ${JSON.stringify(evs(id).slice(-6)).slice(0, 800)}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}
const sinceIndex = (id, i) => evs(id).slice(i)
const lastAssistant = (id) => svc.open(id).transcript.items.filter((x) => x.kind === 'assistant').at(-1)?.text ?? ''

const { models } = await svc.catalog()
const MODEL = process.env.CODE_TEST_MODEL ?? models.filter((m) => m.vision && ['omlx', 'ollama'].includes(m.backend)).sort((a, b) => a.ramGB - b.ramGB)[0]?.id
assert.ok(MODEL, 'a vision model is in the catalog')
const model = models.find((m) => m.id === MODEL)
const results = []
const projects = []
try {
  for (const harness of HARNESSES) {
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'code-feat-')))
    projects.push(project)
    execFileSync('/usr/bin/git', ['init', '-q'], { cwd: project })
    writeFileSync(join(project, 'notes.md'), '# notes\n')
    execFileSync('/usr/bin/git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'init', '--allow-empty'], { cwd: project })
    execFileSync('/usr/bin/git', ['add', '.'], { cwd: project })
    execFileSync('/usr/bin/git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'notes'], { cwd: project })
    const t0 = Date.now()
    const s = await svc.create({ cwd: project, harness, modelId: MODEL, mode: 'auto', thinking: model.thinking === 'none' ? 'default' : 'off' })
    const r = { harness, model: MODEL }

    // Slash commands are listed without loading a model.
    const cmds = await svc.commands(s.id)
    r.commands = cmds.length
    assert.ok(cmds.length > 0, `${harness}: lists slash commands`)

    // Image attachment (thinking off: no thinking events expected on toggle models).
    const red = join(uploads, 'red.png'); writeFileSync(red, png(220, 20, 20))
    let mark = evs(s.id).length
    await svc.send(s.id, 'What single color fills this image? Answer with one word.', [red])
    await until(s.id, () => ends(s.id) >= 1, `${harness} image turn`)
    r.imageAnswer = lastAssistant(s.id).trim().slice(0, 40)
    assert.match(lastAssistant(s.id), /red/i, `${harness}: saw the red image`)
    r.thinkingOffChars = sinceIndex(s.id, mark).filter((e) => e.type === 'thinking').reduce((n, e) => n + e.delta.length, 0)
    if (model.thinking === 'toggle') assert.equal(r.thinkingOffChars, 0, `${harness}: thinking off means no thinking stream`)
    assert.ok(evs(s.id).some((e) => e.type === 'context' && e.tokens > 0 && e.window > 0), `${harness}: context meter event`)
    r.context = evs(s.id).filter((e) => e.type === 'context').at(-1)

    // Thinking on.
    if (model.thinking !== 'none') {
      await svc.configure(s.id, { thinking: 'on' })
      mark = evs(s.id).length
      const before = ends(s.id)
      await svc.send(s.id, 'What is 17 * 3? Reply with just the number.')
      await until(s.id, () => ends(s.id) > before, `${harness} thinking turn`)
      r.thinkingChars = sinceIndex(s.id, mark).filter((e) => e.type === 'thinking').reduce((n, e) => n + e.delta.length, 0)
      assert.ok(r.thinkingChars > 0, `${harness}: thinking on streams thinking`)
      assert.match(lastAssistant(s.id), /51/, `${harness}: answered 51`)
      await svc.configure(s.id, { thinking: 'off' })
    }

    // Queue a message while a turn is running, and have the agent write a file (for Changes).
    const before = ends(s.id)
    await svc.send(s.id, 'Create a file named plan.md in the current directory containing a short 3-item numbered list of steps to bake bread. Use your file-writing tool.')
    await until(s.id, () => svc.list().find((x) => x.id === s.id).status.state === 'running' || ends(s.id) > before, `${harness} running`)
    await svc.send(s.id, 'After that, reply with exactly: QUEUED-OK', [], 'queue')
    await until(s.id, () => /QUEUED-OK/.test(lastAssistant(s.id)) && svc.list().find((x) => x.id === s.id).status.state === 'idle', `${harness} queued reply`)
    assert.ok(svc.open(s.id).transcript.items.some((x) => x.kind === 'user' && x.delivery === 'queue'), `${harness}: queued message recorded`)

    // Changes: the new untracked file shows up.
    const ch = await svc.changes(s.id)
    r.changes = ch.files.map((f) => `${f.status}:${f.path}`)
    assert.ok(ch.repo && ch.files.some((f) => f.path === 'plan.md' && f.additions > 0), `${harness}: changes lists plan.md`)

    // Manual compaction. omp refuses when the history is shorter than what it
    // keeps verbatim ("Nothing to compact (session too small)"); that refusal
    // must surface as an error and leave the session idle, not hang (it used to).
    mark = evs(s.id).length
    let refused = ''
    await svc.compact(s.id).catch((e) => { refused = e.message })
    if (refused) {
      assert.match(refused, /Nothing to compact|Already compacted/, `${harness}: only a too-small refusal is acceptable`)
      r.compactNotice = 'refused: ' + refused
    } else {
      await until(s.id, () => sinceIndex(s.id, mark).some((e) => e.type === 'notice' && /compact/i.test(e.text)), `${harness} compaction`)
      r.compactNotice = sinceIndex(s.id, mark).filter((e) => e.type === 'notice').map((e) => e.text).join(' | ').slice(0, 120)
    }
    await until(s.id, () => svc.list().find((x) => x.id === s.id).status.state === 'idle', `${harness} idle after compaction`)
    r.seconds = Math.round((Date.now() - t0) / 1000)
    results.push(r)
    console.log('ok', JSON.stringify(r))
  }
  console.log('PASS')
} catch (e) {
  for (const [id, list] of events) console.error(`--- ${id}\n` + list.filter((x) => !['text', 'thinking'].includes(x.type)).map((x) => JSON.stringify(x).slice(0, 240)).join('\n'))
  throw e
} finally {
  svc.shutdown()
  for (const p of [out, userData, ...projects]) rmSync(p, { recursive: true, force: true })
}
