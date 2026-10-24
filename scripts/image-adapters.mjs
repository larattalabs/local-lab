/** Bundle the real registry for Node-side contract and live model checks. */
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function loadImageAdapters() {
  const require = createRequire(import.meta.resolve('vite'))
  const { build } = require('esbuild')
  const dir = mkdtempSync(join(tmpdir(), 'local-lab-image-adapters-'))
  try {
    const out = join(dir, 'registry.mjs')
    await build({ entryPoints: ['src/main/registry/image.ts'], outfile: out,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    return (await import(pathToFileURL(out).href)).imageAdapters
  } finally { rmSync(dir, { recursive: true }) }
}
