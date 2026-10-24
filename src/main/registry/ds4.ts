import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Adapter } from './types'
import { workerPath } from '../paths'
import { AI_ROOT } from '../env'

const ENGINE_DIR = process.env.LOCALLAB_DS4_DIR ?? join(homedir(), 'Developer', '_infra', 'ds4-v41')
const MODEL = process.env.LOCALLAB_DS4_MODEL ?? join(
  AI_ROOT, 'ds4-gguf', 'v41-1017', 'DeepSeek-V4.1-Flash-1017-IQ2_XXS-Q2_K-imatrix.gguf'
)
const PYTHON = '/usr/bin/python3'
const THINK_RULE = '\n───\n'

export const ds4Adapters: Adapter[] = [{
  id: 'ds4:deepseek-v4.1-flash-1017',
  label: 'DeepSeek V4.1 Flash 1017 · Q2',
  modality: 'text',
  family: 'ds4',
  notes: 'DwarfStar / Metal with SSD streaming. Loads for each run and releases memory afterward.',
  outputExt: '',
  streams: true,
  requires: [PYTHON, join(ENGINE_DIR, 'ds4-server'), MODEL],
  params: [
    { key: 'temperature', label: 'Temperature', type: 'float', default: 0.7, min: 0, max: 2, step: 0.05 },
    { key: 'reasoning_effort', label: 'Reasoning', type: 'select', default: 'none', options: [
      { value: 'none', label: 'off (fastest)' }, { value: 'low', label: 'low' },
      { value: 'medium', label: 'medium' }, { value: 'high', label: 'high' },
      { value: 'max', label: 'maximum' },
    ], help: 'Thinking consumes the output token budget before the answer starts.' },
    { key: 'max_tokens', label: 'Max tokens', type: 'int', default: 2048, min: 64, max: 16384 },
    { key: 'ctx', label: 'Context length', type: 'int', default: 32768, min: 4096, max: 131072,
      advanced: true, help: 'Includes conversation history, thinking, and the answer. More context uses more memory.' },
    { key: 'system', label: 'System prompt', type: 'string', default: '', advanced: true },
  ],
  build({ prompt, params, outPath, history }) {
    const messages: { role: string; content: string }[] = []
    if (params.system) messages.push({ role: 'system', content: String(params.system) })
    for (const h of history ?? []) {
      const content = h.role === 'assistant' && h.content.includes(THINK_RULE)
        ? h.content.slice(h.content.lastIndexOf(THINK_RULE) + THINK_RULE.length) : h.content
      messages.push({ role: h.role, content })
    }
    messages.push({ role: 'user', content: prompt })
    const effort = String(params.reasoning_effort ?? 'none')
    const body = {
      model: 'deepseek-v4.1-flash', messages, stream: true,
      temperature: params.temperature ?? 0.7,
      max_tokens: params.max_tokens ?? 2048,
      thinking: effort !== 'none', reasoning_effort: effort,
    }
    const reqPath = join(dirname(outPath), 'request.json')
    writeFileSync(reqPath, JSON.stringify(body, null, 2))
    return {
      bin: PYTHON,
      args: [workerPath('ds4_chat.py'), reqPath, '--engine-dir', ENGINE_DIR, '--model', MODEL,
        '--ctx', String(params.ctx ?? 32768)],
    }
  },
  makeStream() {
    let buf = ''
    let reasoning = false
    let content = false
    return (chunk: string): string => {
      buf += chunk
      let out = ''
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line || line.startsWith(':')) continue
        if (!line.startsWith('data:')) { out += line + '\n'; continue }
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') continue
        try {
          const j = JSON.parse(payload) as {
            choices?: { delta?: { content?: string; reasoning_content?: string } }[]
            error?: { message?: string }
          }
          if (j.error) { out += `\n[ds4] ${j.error.message ?? JSON.stringify(j.error)}\n`; continue }
          const d = j.choices?.[0]?.delta
          if (d?.reasoning_content) {
            if (!reasoning) { out += 'thinking…\n'; reasoning = true }
            out += d.reasoning_content
          }
          if (d?.content) {
            if (reasoning && !content) out += THINK_RULE
            content = true
            out += d.content
          }
        } catch { out += payload }
      }
      return out
    }
  },
}]
