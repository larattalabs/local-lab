import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Adapter, RunContext } from './types'

const home = homedir()
const OLLAMA = process.env.LOCALLAB_OLLAMA_BIN ?? '/usr/local/bin/ollama'
const OLLAMA_ALT = '/opt/homebrew/bin/ollama'

function ollamaBin(): string {
  for (const c of [OLLAMA, OLLAMA_ALT, join(home, '.local', 'bin', 'ollama')]) {
    try { execFileSync('/bin/test', ['-x', c]); return c } catch { /* next */ }
  }
  return OLLAMA
}

/**
 * Ollama models are discovered at startup rather than hardcoded — the whole
 * point is that the user pulls new ones and they show up. `ollama list` is
 * cheap enough to run on every registry build.
 */
export function discoverOllamaModels(): string[] {
  try {
    const out = execFileSync(ollamaBin(), ['list'], { encoding: 'utf8', timeout: 5000 })
    return out.split('\n').slice(1)
      .map((l) => l.trim().split(/\s+/)[0])
      .filter((n) => n && n !== 'NAME')
  } catch {
    return []
  }
}

function ollamaAdapter(model: string): Adapter {
  return {
    id: `ollama:${model}`,
    label: model,
    modality: 'text',
    family: 'ollama',
    notes: 'Local LLM via Ollama. Streams tokens as they arrive.',
    outputExt: '',
    streams: true,
    requires: [],
    params: [
      { key: 'temperature', label: 'Temperature', type: 'float', default: 0.7,
        min: 0, max: 2, step: 0.05 },
      { key: 'system', label: 'System prompt', type: 'string', default: '', advanced: true },
    ],
    build({ prompt, params }: RunContext) {
      const args = ['run', model]
      if (params.system) args.push('--system', String(params.system))
      args.push(prompt)
      return { bin: ollamaBin(), args }
    },
  }
}

export function textAdapters(): Adapter[] {
  return discoverOllamaModels().map(ollamaAdapter)
}
