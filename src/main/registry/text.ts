import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Adapter, RunContext } from './types'

const home = homedir()
const OLLAMA = process.env.LOCALLAB_OLLAMA_BIN ?? '/usr/local/bin/ollama'
const OLLAMA_ALT = '/opt/homebrew/bin/ollama'
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? '127.0.0.1:11434'

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

/**
 * Generation goes through Ollama's HTTP API via curl, NOT `ollama run`.
 *
 * `ollama run` looks like the obvious spawn target but supports neither
 * `--system` nor a temperature flag — those are API-only options, and passing
 * them to the CLI is an immediate argparse error (found the hard way). The
 * API gives us both, plus honest token streaming. Server availability is not
 * a new failure mode: discovery already ran `ollama list`, which needs the
 * same server — if it's down, no text models are listed in the first place.
 */
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
      { key: 'num_ctx', label: 'Context length', type: 'int', default: null,
        min: 512, max: 262144, advanced: true,
        help: 'Blank uses the model default. Raise for long prompts.' },
    ],
    build({ prompt, params }: RunContext) {
      const t = params.temperature
      const options: Record<string, unknown> = {
        temperature: typeof t === 'number' && Number.isFinite(t) ? t : 0.7,
      }
      if (typeof params.num_ctx === 'number' && Number.isFinite(params.num_ctx)) {
        options.num_ctx = params.num_ctx
      }
      const body: Record<string, unknown> = { model, prompt, options, stream: true }
      if (params.system) body.system = String(params.system)
      return {
        bin: '/usr/bin/curl',
        args: ['-sN', '--fail-with-body', `http://${OLLAMA_HOST}/api/generate`,
               '-d', JSON.stringify(body)],
      }
    },
    // The API streams NDJSON, one {"response": "tok", ...} object per line.
    // Chunks can split a line anywhere, so buffer to newlines before parsing.
    makeStream() {
      let buf = ''
      return (chunk: string): string => {
        buf += chunk
        let out = ''
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          try {
            const j = JSON.parse(line) as { response?: string; error?: string }
            if (j.response) out += j.response
            if (j.error) out += `\n[ollama] ${j.error}\n`
          } catch {
            out += line // not JSON (curl error body, proxy page…) — show it raw
          }
        }
        return out
      }
    },
  }
}

export function textAdapters(): Adapter[] {
  return discoverOllamaModels().map(ollamaAdapter)
}
