import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Adapter, RunContext } from './types'
import { workerPath } from '../paths'

const home = homedir()
const OMLX_HOST = process.env.LOCALLAB_OMLX_HOST ?? '127.0.0.1:8080'
const OMLX_BIN = process.env.LOCALLAB_OMLX_BIN ?? '/opt/homebrew/bin/omlx'
const OMLX_MODEL_DIR = process.env.LOCALLAB_OMLX_MODEL_DIR ?? join(home, 'AI', 'laguna-omlx')
/** Separates streamed chain-of-thought from the answer, in both directions. */
const THINK_RULE = '\n───\n'

/**
 * oMLX serves several large local models behind one OpenAI-compatible server
 * (see ~/AI/laguna/serve-laguna.sh). Unlike Ollama, it is NOT expected to be
 * running all the time — it holds 20-70GB resident per loaded model — so
 * discovery has to work in both states:
 *
 *   server up   -> ask it what it has loaded/loadable (authoritative)
 *   server down -> scan the model directory, so the models still appear in the
 *                  picker and a run can lazily start the server on demand
 *
 * Without the fallback the whole Text tab would look empty whenever the server
 * happened to be stopped, which is its normal resting state.
 */
function fromServer(): string[] {
  try {
    const out = execFileSync(
      '/usr/bin/curl',
      ['-s', '--max-time', '2', `http://${OMLX_HOST}/v1/models`],
      { encoding: 'utf8', timeout: 4000 }
    )
    const j = JSON.parse(out) as { data?: { id: string }[] }
    return (j.data ?? []).map((m) => m.id).filter(Boolean)
  } catch {
    return []
  }
}

function fromDisk(): string[] {
  try {
    return readdirSync(OMLX_MODEL_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(OMLX_MODEL_DIR, e.name, 'config.json')))
      .map((e) => e.name)
  } catch {
    return []
  }
}

/** A model is vision-capable when its config declares a vision tower. */
function hasVision(id: string): boolean {
  const cfg = join(OMLX_MODEL_DIR, id, 'config.json')
  try {
    return readFileSync(cfg, 'utf8').includes('"vision_config"')
  } catch {
    return false
  }
}

export function discoverOmlxModels(): string[] {
  const ids = fromServer()
  return ids.length ? ids : fromDisk()
}

function omlxAdapter(model: string): Adapter {
  const vision = hasVision(model)
  const dir = join(OMLX_MODEL_DIR, model)
  return {
    id: `omlx:${model}`,
    label: model,
    modality: 'text',
    family: 'omlx',
    notes: vision
      ? 'Local model via oMLX. Multi-turn context, vision, MTP speculative decoding.'
      : 'Local model via oMLX. Multi-turn context.',
    outputExt: '',
    streams: true,
    acceptsImages: vision,
    requires: existsSync(dir) ? [OMLX_BIN, dir] : [OMLX_BIN],
    params: [
      // Qwen3.8's own recommended sampler; oMLX applies these per request.
      { key: 'temperature', label: 'Temperature', type: 'float', default: 1.0, min: 0, max: 2, step: 0.05 },
      { key: 'reasoning_effort', label: 'Reasoning', type: 'select', default: 'medium',
        options: [
          { value: 'low', label: 'low' }, { value: 'medium', label: 'medium (recommended)' },
          { value: 'high', label: 'high' }, { value: 'xhigh', label: 'xhigh (slow)' },
        ],
        help: 'Thinking budget. xhigh can spend thousands of tokens before answering.' },
      { key: 'max_tokens', label: 'Max tokens', type: 'int', default: 2048, min: 64, max: 32000,
        help: 'Counts thinking tokens too — a small budget can be spent entirely on reasoning, leaving no answer.' },
      { key: 'top_p', label: 'Top-p', type: 'float', default: 0.95, min: 0, max: 1, step: 0.01, advanced: true },
      { key: 'top_k', label: 'Top-k', type: 'int', default: 20, min: 0, max: 200, advanced: true },
      { key: 'system', label: 'System prompt', type: 'string', default: '', advanced: true },
    ],
    build({ prompt, params, outPath, images, history }: RunContext) {
      const messages: Record<string, unknown>[] = []
      if (params.system) messages.push({ role: 'system', content: String(params.system) })
      // `history` arrives only when the chat's context toggle is on, so an
      // off-toggle message is genuinely a fresh single-turn request.
      //
      // Assistant turns are replayed from what was DISPLAYED, which includes
      // the thinking block this adapter streams. Feeding a model its own prior
      // chain-of-thought wastes context and degrades later turns, so keep only
      // the answer below the rule.
      for (const h of history ?? []) {
        const content =
          h.role === 'assistant' && h.content.includes(THINK_RULE)
            ? h.content.slice(h.content.lastIndexOf(THINK_RULE) + THINK_RULE.length)
            : h.content
        messages.push({ role: h.role, content })
      }

      // Images ride on the final user turn as data URLs. Base64 of a few MB
      // blows past ARG_MAX, so the body goes to a file rather than argv.
      if (vision && images.length) {
        messages.push({
          role: 'user',
          content: [
            ...images.map((p) => ({
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${readFileSync(p).toString('base64')}` },
            })),
            { type: 'text', text: prompt },
          ],
        })
      } else {
        messages.push({ role: 'user', content: prompt })
      }

      const body: Record<string, unknown> = {
        model, messages, stream: true,
        temperature: typeof params.temperature === 'number' ? params.temperature : 1.0,
        max_tokens: typeof params.max_tokens === 'number' ? params.max_tokens : 2048,
      }
      if (typeof params.top_p === 'number') body.top_p = params.top_p
      if (typeof params.top_k === 'number') body.top_k = params.top_k
      if (params.reasoning_effort) body.reasoning_effort = String(params.reasoning_effort)

      // Written beside the artifact: it is also the provenance record of
      // exactly what was sent, which is the first thing you want when a
      // multi-turn run behaves unexpectedly.
      const reqPath = join(dirname(outPath), 'request.json')
      writeFileSync(reqPath, JSON.stringify(body, null, 2))
      return { bin: workerPath('omlx_chat.sh'), args: [reqPath], env: { LOCALLAB_OMLX_HOST: OMLX_HOST } }
    },

    /**
     * oMLX streams OpenAI SSE: `data: {json}` per event, `data: [DONE]` last.
     * Thinking models put chain-of-thought in `reasoning_content`; it is shown
     * (silence during a long think reads as a hang) and separated from the
     * answer by a rule so the two are never confused.
     */
    makeStream() {
      let buf = ''
      let sawReasoning = false
      let sawContent = false
      return (chunk: string): string => {
        buf += chunk
        let out = ''
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          if (!line.startsWith('data:')) {
            out += line + '\n' // curl error body / proxy page — surface it raw
            continue
          }
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') continue
          try {
            const j = JSON.parse(payload) as {
              choices?: { delta?: { content?: string; reasoning_content?: string } }[]
              error?: { message?: string }
            }
            if (j.error) { out += `\n[omlx] ${j.error.message ?? JSON.stringify(j.error)}\n`; continue }
            const d = j.choices?.[0]?.delta
            if (d?.reasoning_content) {
              if (!sawReasoning) { out += 'thinking…\n'; sawReasoning = true }
              out += d.reasoning_content
            }
            if (d?.content) {
              if (sawReasoning && !sawContent) out += THINK_RULE
              sawContent = true
              out += d.content
            }
          } catch {
            out += payload
          }
        }
        return out
      }
    },
  }
}

export function omlxAdapters(): Adapter[] {
  return discoverOmlxModels().map(omlxAdapter)
}
