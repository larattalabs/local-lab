/** Run one real video adapter with reproducible inputs and inspect the result. */
import { spawn, execFileSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
const { build } = createRequire(import.meta.resolve('vite'))('esbuild')

const [id, outputDir, reference] = process.argv.slice(2)
if (!id || !outputDir) throw new Error('Usage: node scripts/smoke-video-stack.mjs ID OUTPUT_DIR [REFERENCE_IMAGE]')
const temp = mkdtempSync(join(tmpdir(), 'local-lab-video-smoke-'))
try {
  const module = join(temp, 'video.mjs')
  await build({ stdin: { contents: "export { videoAdapters } from './src/main/registry/video'; export { modelEnv } from './src/main/env'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' },
    outfile: module, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const { videoAdapters, modelEnv } = await import(pathToFileURL(module).href)
  const adapter = videoAdapters.find((a) => a.id === id)
  if (!adapter) throw new Error('Unknown video adapter: ' + id)
  const missing = adapter.requires.filter((path) => !existsSync(path))
  if (missing.length) throw new Error('Missing local requirements: ' + missing.join(', '))
  const dir = resolve(outputDir)
  mkdirSync(dir, { recursive: true })
  const params = Object.fromEntries(adapter.params.map((p) => [p.key, p.default]))
  Object.assign(params, { resolution: '512x512', frames: adapter.family === 'h3-native' ? '56' : '49', seed: 42 },
    JSON.parse(process.env.LOCALLAB_SMOKE_PARAMS ?? '{}'))
  const prompt = process.env.LOCALLAB_SMOKE_PROMPT ?? 'A gentle breeze moves the subject slightly. Natural motion, static camera, soft daylight. Preserve the original subject and scene.'
  const output = join(dir, 'output.mp4')
  const images = reference ? [resolve(reference)] : []
  const spec = adapter.build({ prompt, params, images, outPath: output })
  writeFileSync(join(dir, 'request.json'), JSON.stringify({ id, prompt, params, images, spec }, null, 2) + '\n')
  const log = openSync(join(dir, 'run.log'), 'w')
  const timePath = join(dir, 'time.txt')
  const timed = process.platform === 'darwin'
  const started = Date.now()
  let result
  try {
    const child = spawn(timed ? '/usr/bin/time' : spec.bin,
      timed ? ['-l', '-o', timePath, spec.bin, ...spec.args] : spec.args,
      { cwd: spec.cwd, env: modelEnv(spec.env), stdio: ['ignore', log, log] })
    result = await new Promise((res, rej) => {
      child.once('error', rej)
      child.once('close', (code, signal) => res({ code, signal }))
    })
  } finally { closeSync(log) }
  const seconds = (Date.now() - started) / 1000
  const time = timed && existsSync(timePath) ? readFileSync(timePath, 'utf8') : ''
  const rssBytes = Number(time.match(/(\d+)\s+maximum resident set size/)?.[1]) || null
  let probe = null
  let validationError = null
  if (result.code === 0) {
    try {
      probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], { encoding: 'utf8' }))
      const video = probe.streams.find((stream) => stream.codec_type === 'video')
      const [width, height] = String(params.resolution).split('x').map(Number)
      if (!video || video.width !== width || video.height !== height || Number(video.nb_frames) !== Number(params.frames)) {
        throw new Error('Output dimensions or frame count do not match the request.')
      }
      // Decode every frame, not just the container header.
      execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', output, '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (error) { validationError = error.message }
  }
  const record = { id, ...result, seconds, maxResidentGiB: rssBytes ? rssBytes / 1024 ** 3 : null,
    output, params, images, probe, validationError }
  writeFileSync(join(dir, 'result.json'), JSON.stringify(record, null, 2) + '\n')
  console.log(JSON.stringify({ id, ...result, seconds, maxResidentGiB: record.maxResidentGiB, output, validationError }))
  if (result.code !== 0 || validationError) process.exitCode = 1
} finally { rmSync(temp, { recursive: true, force: true }) }
