import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MODELS_YML = process.env.LOCALLAB_OMP_MODELS_YML ?? join(homedir(), '.omp', 'agent', 'models.yml')

/**
 * Keep omp's declared context window for an oMLX model in step with the cap
 * oMLX enforces. omp sizes compaction from `contextWindow`, so a stale value
 * means either constant compaction (too small) or 400 "prompt too long" errors
 * (too large).
 *
 * This is a narrow line edit, not a YAML rewrite: inside the `omlx:` provider,
 * find `- id: "<model>"` and replace the first `contextWindow:` line of that
 * entry. Comments and layout elsewhere are untouched. A model omp doesn't list
 * is left alone. The first edit saves `models.yml.bak-locallab`.
 */
export function syncOmpContextWindow(model: string, contextWindow: number): boolean {
  if (!existsSync(MODELS_YML)) return false
  const lines = readFileSync(MODELS_YML, 'utf8').split('\n')
  let inOmlx = false
  let inEntry = false
  let changed = false
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const provider = l.match(/^ {2}([A-Za-z0-9_.-]+):\s*(#.*)?$/)
    if (provider) { inOmlx = provider[1] === 'omlx'; inEntry = false; continue }
    if (!inOmlx) continue
    const id = l.match(/^\s+- id:\s*"?([^"#\s]+)"?/)
    if (id) { inEntry = id[1] === model; continue }
    if (inEntry && /^\s+contextWindow:/.test(l)) {
      const indent = l.match(/^\s*/)![0]
      const next = `${indent}contextWindow: ${contextWindow}           # synced with oMLX's per-model cap by Local Lab`
      if (l !== next) { lines[i] = next; changed = true }
      inEntry = false
    }
  }
  if (!changed) return false
  const backup = MODELS_YML + '.bak-locallab'
  if (!existsSync(backup)) copyFileSync(MODELS_YML, backup)
  writeFileSync(MODELS_YML + '.tmp', lines.join('\n'))
  renameSync(MODELS_YML + '.tmp', MODELS_YML)
  return true
}
