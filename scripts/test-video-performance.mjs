import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
const { build } = createRequire(import.meta.resolve('vite'))('esbuild')

const dir = mkdtempSync(join(tmpdir(), 'local-lab-video-performance-'))
try {
  process.env.LOCALLAB_VIDEO_PROFILES = join(dir, 'profiles.json')
  process.env.LOCALLAB_RUNTIME_PROFILES = join(dir, 'runtime.json')
  writeFileSync(process.env.LOCALLAB_VIDEO_PROFILES, JSON.stringify({ models: [{
    id: 'legacy-local', label: 'Legacy', engine: 'ltx-mlx', model: '/models/legacy', encoder: '/models/gemma3',
  }] }))
  writeFileSync(process.env.LOCALLAB_RUNTIME_PROFILES, JSON.stringify({ models: {
    'ltx-2.5': { model: '/models/ltx25-alternate' },
  } }))
  const file = join(dir, 'video.mjs')
  await build({ entryPoints: ['src/main/registry/video-stack.ts'], outfile: file,
    bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const { videoStackAdapters } = await import(pathToFileURL(file).href)
  const model = videoStackAdapters.find((a) => a.id === 'ltx-2.5')
  const ctx = { prompt: 'A scarf moving in the wind.', params: {}, images: ['/source.png'], outPath: '/output.mp4' }
  const fast = model.build(ctx)
  assert.deepEqual(fast.env, { LTX2_COMPUTE_DTYPE: 'float16', LTX2_SOL_TAU: 'off' })
  assert.equal(fast.args[fast.args.indexOf('--model') + 1], '/models/ltx25-alternate')
  assert.equal(fast.args[fast.args.indexOf('--stage1-steps') + 1], '8')
  assert.equal(fast.args[fast.args.indexOf('--stage2-steps') + 1], '3')
  assert.deepEqual(fast.args.slice(-4), ['--image', '/source.png', '0', '1.0'])
  assert(!fast.args.includes('--gemma'))
  const reference = model.build({ ...ctx, params: { compute_precision: 'float32' } })
  assert.deepEqual(reference.args, fast.args)
  assert.equal(reference.env.LTX2_COMPUTE_DTYPE, 'float32')
  for (const compute_precision of ['bfloat16', 'invalid', {}, 16]) {
    assert.throws(() => model.build({ ...ctx, params: { compute_precision } }), /precision/)
  }
  for (const id of ['minimax-h3', 'legacy-local']) {
    const other = videoStackAdapters.find((a) => a.id === id)
    assert(!other.params.some((p) => p.key === 'compute_precision'))
    assert.equal(other.build(ctx).env, undefined)
  }
  console.log('Video performance: precision switch, alternate encoder, original schedule and isolation passed.')
} finally { rmSync(dir, { recursive: true, force: true }) }
