/** Run real adapter commands sequentially; models must already be installed. */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { loadImageAdapters } from './image-adapters.mjs'

const [id, outputDir, reference, encoder = 'stock'] = process.argv.slice(2)
if (!id || !outputDir) throw new Error('Usage: node scripts/smoke-image-stack.mjs ID OUTPUT_DIR [REFERENCE] [stock|heretic]')
const adapter = (await loadImageAdapters()).find((a) => a.id === id)
if (!adapter) throw new Error('Unknown adapter ' + id)
const references = process.env.LOCALLAB_SMOKE_REFERENCES
  ? JSON.parse(process.env.LOCALLAB_SMOKE_REFERENCES) : reference ? [reference] : []
const dir = resolve(outputDir)
mkdirSync(dir, { recursive: true })
const params = Object.fromEntries(adapter.params.map((p) => [p.key, p.default]))
Object.assign(params, { aspect: '1:1', seed: 42, encoder })
if (id === 'seedvr2') params.resolution = '2x'
const prompt = process.env.LOCALLAB_SMOKE_PROMPT ?? (reference
  ? 'Keep the same subject and composition. Change the red ceramic teapot to cobalt blue. Keep the wooden table and plain background.'
  : 'A red ceramic teapot with a curved spout and a round lid on a light wooden table. Soft daylight, plain pale gray background, product photograph, no text.')
const output = join(dir, 'output.png')
const spec = adapter.build({ prompt, params, outPath: output, images: references.map((p) => resolve(p)) })
const started = Date.now()
writeFileSync(join(dir, 'request.json'), JSON.stringify({ id, prompt, params, references, spec }, null, 2))
const log = openSync(join(dir, 'run.log'), 'w')
const child = spawn(spec.bin, spec.args, { cwd: spec.cwd,
  env: { ...process.env, HF_HOME: join(homedir(), 'AI', 'huggingface'),
    HF_HUB_CACHE: join(homedir(), 'AI', 'huggingface', 'hub'), HF_HUB_OFFLINE: '1', ...spec.env },
  stdio: ['ignore', log, log] })
const result = await new Promise((res, rej) => {
  child.on('error', rej)
  child.on('close', (code, signal) => res({ code, signal }))
})
closeSync(log)
const record = { id, encoder, ...result, seconds: (Date.now() - started) / 1000, output }
writeFileSync(join(dir, 'result.json'), JSON.stringify(record, null, 2) + '\n')
console.log(JSON.stringify(record))
if (result.code !== 0) process.exit(1)
