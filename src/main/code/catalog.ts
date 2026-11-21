import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CodeBackend, CodeBackendState, CodeCatalogEntry, CodeCheckResult, CodeDiscovered, CodeModel, CodeServerSettings } from '@shared/code'
import { AI_ROOT, modelEnv } from '../env'
import { workerPath } from '../paths'

/**
 * Which local models the Code tab offers, and how their servers are reached.
 *
 * A coding agent is useless on a model that cannot emit tool calls through its
 * server, and "the server lists it" does not tell you that. So the curated list
 * lives in a private file (`~/AI/local-lab-private/code-models.json`) holding
 * only models that passed a tool-call check — and keeping personal model
 * identities out of this public repo. Without that file the tab falls back to
 * whatever Ollama and oMLX report, marked unverified.
 */

const home = homedir()
const CATALOG = process.env.LOCALLAB_CODE_MODELS ?? join(AI_ROOT, 'local-lab-private', 'code-models.json')

export const BACKEND_URL: Record<CodeBackend, string> = {
  ollama: 'http://127.0.0.1:11434/v1',
  omlx: 'http://127.0.0.1:8080/v1',
  ds4: 'http://127.0.0.1:8000/v1',
  'ds4-ablit': 'http://127.0.0.1:8002/v1',
  'ds4-v41': 'http://127.0.0.1:8003/v1',
}
export const BACKEND_LABEL: Record<CodeBackend, string> = {
  ollama: 'Ollama', omlx: 'oMLX', ds4: 'DwarfStar (ds4)', 'ds4-ablit': 'DwarfStar abliterated', 'ds4-v41': 'DwarfStar V4.1 (SSD)',
}
export const BACKENDS = Object.keys(BACKEND_URL) as CodeBackend[]

type CatalogEntry = CodeCatalogEntry

async function getJson(url: string, ms = 1500): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) })
  if (!r.ok) throw new Error(`${url}: ${r.status}`)
  return r.json()
}

function toModel(e: CatalogEntry, verified: boolean): CodeModel {
  return {
    id: `${e.backend}/${e.model}`,
    backend: e.backend,
    model: e.model,
    label: e.label ?? e.model,
    note: e.note ?? (verified ? '' : 'Not checked for tool calls.'),
    ramGB: e.ramGB ?? 0,
    contextWindow: e.contextWindow ?? 32768,
    maxOutput: e.maxOutput ?? 8192,
    reasoning: e.reasoning ?? false,
    uncensored: e.uncensored ?? false,
    vision: e.vision ?? false,
    slow: e.slow ?? false,
    thinking: !(e.reasoning ?? false) ? 'none' : e.backend === 'omlx' ? 'toggle' : e.backend === 'ollama' ? 'none' : 'effort',
  }
}

/** Discovery fallback: whatever the two always-installed servers report. */
async function discover(): Promise<CodeModel[]> {
  const out: CodeModel[] = []
  try {
    const tags = await getJson('http://127.0.0.1:11434/api/tags')
    for (const m of tags.models ?? []) out.push(toModel({ backend: 'ollama', model: m.name }, false))
  } catch { /* Ollama not running */ }
  try {
    const list = await getJson(BACKEND_URL.omlx + '/models')
    for (const m of list.data ?? []) out.push(toModel({ backend: 'omlx', model: m.id }, false))
  } catch { /* oMLX stopped — its normal resting state */ }
  return out
}

function writeJsonAtomic(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  renameSync(tmp, path)
}

/** The raw private catalog (entries as stored), or null when there is none. */
export function readCatalog(): { _comment?: string; models: CatalogEntry[] } | null {
  if (!existsSync(CATALOG)) return null
  const j = JSON.parse(readFileSync(CATALOG, 'utf8'))
  return { ...j, models: Array.isArray(j.models) ? j.models : [] }
}

function validEntry(e: CatalogEntry): CatalogEntry {
  if (!BACKENDS.includes(e.backend)) throw new Error('Unknown backend.')
  const model = String(e.model ?? '').trim()
  if (!model) throw new Error('A model id is required.')
  const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : undefined)
  const out: CatalogEntry = { backend: e.backend, model }
  if (e.label?.trim()) out.label = e.label.trim().slice(0, 80)
  if (e.note?.trim()) out.note = e.note.trim().slice(0, 200)
  const ram = num(e.ramGB, 0, 512); if (ram !== undefined) out.ramGB = ram
  const ctx = num(e.contextWindow, 2048, 4_194_304); if (ctx !== undefined) out.contextWindow = ctx
  const outTok = num(e.maxOutput, 256, 262_144); if (outTok !== undefined) out.maxOutput = outTok
  for (const k of ['reasoning', 'uncensored', 'vision', 'slow'] as const) if (typeof e[k] === 'boolean') out[k] = e[k]
  return out
}

/** Add or replace one entry (matched on backend + model). */
export function upsertCatalog(entry: CatalogEntry) {
  const e = validEntry(entry)
  const cat = readCatalog() ?? { _comment: 'Local Lab Code tab model catalog (tool-call-checked models).', models: [] }
  const i = cat.models.findIndex((m) => m.backend === e.backend && m.model === e.model)
  if (i >= 0) cat.models[i] = e
  else cat.models.push(e)
  writeJsonAtomic(CATALOG, cat)
}

export function removeFromCatalog(id: string) {
  const cat = readCatalog()
  if (!cat) return
  cat.models = cat.models.filter((m) => `${m.backend}/${m.model}` !== id)
  writeJsonAtomic(CATALOG, cat)
}

/** Models the always-installed servers report, flagged by catalog membership. */
export async function discoverModels(): Promise<CodeDiscovered[]> {
  const inCat = new Set((readCatalog()?.models ?? []).map((m) => `${m.backend}/${m.model}`))
  const out: CodeDiscovered[] = []
  try {
    const tags = await getJson('http://127.0.0.1:11434/api/tags')
    for (const m of tags.models ?? []) out.push({ backend: 'ollama', model: m.name, inCatalog: inCat.has(`ollama/${m.name}`) })
  } catch { /* Ollama not running */ }
  try {
    const list = await getJson(BACKEND_URL.omlx + '/models')
    for (const m of list.data ?? []) out.push({ backend: 'omlx', model: m.id, contextWindow: m.max_model_len, inCatalog: inCat.has(`omlx/${m.id}`) })
  } catch {
    // oMLX stopped: list its model directory instead (HF-cache models only show while it runs).
    for (const id of omlxDiskModels()) out.push({ backend: 'omlx', model: id, inCatalog: inCat.has(`omlx/${id}`) })
  }
  return out
}

/**
 * The tool-call admission check: one request with a trivial write_file tool.
 * The caller must already have brought the model's backend up.
 */
export async function checkToolCalls(backend: CodeBackend, model: string): Promise<CodeCheckResult> {
  const t0 = Date.now()
  const body = {
    model, max_tokens: 1500, stream: false,
    messages: [{ role: 'user', content: 'Create hello.txt containing hi. Use the tool.' }],
    tools: [{ type: 'function', function: { name: 'write_file', description: 'Write a file to disk',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } }],
  }
  const seconds = () => Math.round((Date.now() - t0) / 100) / 10
  try {
    const r = await fetch(BACKEND_URL[backend] + '/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(600_000),
    })
    const text = await r.text()
    let j: any
    try { j = JSON.parse(text) } catch { return { ok: false, seconds: seconds(), detail: `Not JSON (HTTP ${r.status}): ${text.slice(0, 200)}` } }
    if (!r.ok || j.error) return { ok: false, seconds: seconds(), detail: j.error?.message ?? `HTTP ${r.status}` }
    const call = j.choices?.[0]?.message?.tool_calls?.[0]?.function
    if (call?.name === 'write_file') {
      let args: any = {}
      try { args = JSON.parse(call.arguments) } catch { /* reported below */ }
      if (args.path && 'content' in args) return { ok: true, seconds: seconds(), detail: `write_file(${JSON.stringify(args).slice(0, 120)})` }
      return { ok: false, seconds: seconds(), detail: `Tool call with unusable arguments: ${String(call.arguments).slice(0, 160)}` }
    }
    const content = String(j.choices?.[0]?.message?.content ?? '').slice(0, 200)
    return { ok: false, seconds: seconds(), detail: `No tool call. Model said: ${content || '(nothing)'}` }
  } catch (e) {
    return { ok: false, seconds: seconds(), detail: e instanceof Error ? e.message : String(e) }
  }
}

const OMLX_MODEL_DIR = process.env.LOCALLAB_OMLX_MODEL_DIR ?? join(home, 'AI', 'laguna-omlx')
const OMLX_MODEL_SETTINGS = join(home, '.omlx', 'model_settings.json')

function omlxDiskModels(): string[] {
  try {
    return readdirSync(OMLX_MODEL_DIR, { withFileTypes: true })
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && existsSync(join(OMLX_MODEL_DIR, e.name, 'config.json')))
      .map((e) => e.name)
  } catch { return [] }
}

function nativeContext(model: string): number | undefined {
  try {
    const c = JSON.parse(readFileSync(join(OMLX_MODEL_DIR, model, 'config.json'), 'utf8'))
    return c.max_position_embeddings ?? c.text_config?.max_position_embeddings
  } catch { return undefined }
}

/** Per-model oMLX context caps, for every model in its model directory. */
export function readServerSettings(): CodeServerSettings {
  let ms: any = {}
  try { ms = JSON.parse(readFileSync(OMLX_MODEL_SETTINGS, 'utf8')) } catch { /* none yet */ }
  return {
    omlx: omlxDiskModels().map((model) => ({ model, maxContext: ms.models?.[model]?.max_context_window ?? null, native: nativeContext(model) })),
  }
}

/** Set (or clear, with null) one oMLX model's context cap. Takes effect when oMLX next starts. */
export function setOmlxContext(model: string, maxContext: number | null) {
  if (!omlxDiskModels().includes(model)) throw new Error('Unknown oMLX model.')
  if (maxContext !== null && (!Number.isInteger(maxContext) || maxContext < 4096 || maxContext > 4_194_304)) throw new Error('Context must be 4096 or more.')
  let ms: any = { version: 1, models: {} }
  if (existsSync(OMLX_MODEL_SETTINGS)) {
    ms = JSON.parse(readFileSync(OMLX_MODEL_SETTINGS, 'utf8'))
    const backup = OMLX_MODEL_SETTINGS + '.bak-locallab'
    if (!existsSync(backup)) writeFileSync(backup, readFileSync(OMLX_MODEL_SETTINGS))
  }
  ms.models ??= {}
  const entry = (ms.models[model] ??= {})
  if (maxContext === null) delete entry.max_context_window
  else entry.max_context_window = maxContext
  if (!Object.keys(entry).length) delete ms.models[model]
  writeJsonAtomic(OMLX_MODEL_SETTINGS, ms)
}

export async function codeModels(): Promise<CodeModel[]> {
  if (existsSync(CATALOG)) {
    try {
      const j = readCatalog()!
      const models = j.models.filter((e) => BACKENDS.includes(e.backend) && e.model).map((e) => toModel(e, true))
      if (models.length) return models
    } catch (e) {
      console.error('[code] unreadable model catalog', CATALOG, e)
    }
  }
  return discover()
}

async function answers(b: CodeBackend): Promise<boolean> {
  try {
    await getJson(b === 'ollama' ? 'http://127.0.0.1:11434/api/tags' : BACKEND_URL[b] + '/models', 1200)
    return true
  } catch { return false }
}

/**
 * Brings up one backend at a time through `code_backend.zsh`, which takes the
 * same lock as the terminal `omp` switcher and stops every other model server
 * first. Calls are serialized here as well, so two sessions starting at once
 * cannot race each other into loading two large models.
 */
export class BackendManager {
  private active?: CodeBackend
  private chain: Promise<unknown> = Promise.resolve()

  async state(): Promise<CodeBackendState> {
    const up: CodeBackend[] = []
    await Promise.all(BACKENDS.map(async (b) => { if (await answers(b)) up.push(b) }))
    return { active: this.active, up: BACKENDS.filter((b) => up.includes(b)) }
  }

  /**
   * @param busy names another running session's backend; switching away from it
   *   would kill that session's model mid-turn, so the switch is refused.
   */
  ensure(target: CodeBackend, onStatus: (line: string) => void, busy?: CodeBackend): Promise<void> {
    return this.serial(async () => {
      if (busy && busy !== target) {
        throw new Error(`Another Code session is running on ${BACKEND_LABEL[busy]}. Stop it before switching to ${BACKEND_LABEL[target]}.`)
      }
      await this.script([target], onStatus, `Could not start ${BACKEND_LABEL[target]}`)
      this.active = target
    })
  }

  /** Stop one server (for Ollama: unload its resident models). */
  stop(target: CodeBackend, onStatus: (line: string) => void = () => {}): Promise<void> {
    return this.serial(async () => {
      await this.script(['stop', target], onStatus, `Could not stop ${BACKEND_LABEL[target]}`)
      if (this.active === target) this.active = undefined
    })
  }

  /** The backend this app last brought up, if it is still ours. */
  get current(): CodeBackend | undefined { return this.active }

  /**
   * Quit path: stop the server we started without waiting (the script keeps
   * running after the app exits, under the same lock).
   */
  stopDetached(target: CodeBackend) {
    const child = spawn('/bin/zsh', [workerPath('code_backend.zsh'), 'stop', target], {
      env: modelEnv({ HOME: home }), stdio: 'ignore', detached: true,
    })
    child.unref()
    if (this.active === target) this.active = undefined
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn)
    this.chain = p.catch(() => {})
    return p
  }

  private script(args: string[], onStatus: (line: string) => void, failure: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn('/bin/zsh', [workerPath('code_backend.zsh'), ...args], {
        env: modelEnv({ HOME: home }), stdio: ['ignore', 'pipe', 'pipe'],
      })
      let last = ''
      const lines = (buf: Buffer) => {
        for (const l of buf.toString().split('\n')) {
          const t = l.trim()
          if (t.startsWith('status: ')) { last = t.slice(8); onStatus(last) }
        }
      }
      child.stdout.on('data', lines)
      child.stderr.on('data', lines)
      child.on('error', reject)
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(last || `${failure} (exit ${code}).`)))
    })
  }
}
