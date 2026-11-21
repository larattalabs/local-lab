import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CodeAgent, CodeApprovalMode, CodeCommand, CodeModel, CodeSettings, CodeThinking } from '@shared/code'
import { modelEnv } from '../env'
import { BACKEND_LABEL, BACKEND_URL } from './catalog'
import { lineSplitter, readBase64, resultText, type Driver, type DriverHost, type PromptInput } from './driver'

/**
 * opencode (v2 API) through one shared `opencode serve` process.
 *
 * The app owns the whole configuration: providers for every local backend are
 * passed in OPENCODE_CONFIG_CONTENT, so nothing in ~/.config/opencode changes.
 * Sessions still land in opencode's normal database, so a session started here
 * can be continued from the opencode CLI and vice versa.
 *
 * The server password is random per launch and never logged. Network-facing
 * extras (models.dev fetch, free hosted models, auto-update) are switched off:
 * everything here is local.
 */

const OPENCODE = process.env.LOCALLAB_OPENCODE_BIN ?? '/opt/homebrew/bin/opencode'
export function opencodeAvailable(): boolean { return existsSync(OPENCODE) }

/**
 * opencode permission actions seen on the wire: `edit` (carries a unified diff
 * in metadata.files[].patch) and `shell`. Only explicit rules are given for ask
 * and edit, so there is no first-match/last-match ambiguity to depend on.
 */
function permissions(mode: CodeApprovalMode) {
  if (mode === 'auto') return [{ action: '*', resource: '*', effect: 'allow' }]
  // external_directory: any access outside the session folder asks, even when
  // edits are auto-accepted (seen live: a model wrote to ~/Library/… otherwise).
  const rules = [{ action: 'shell', resource: '*', effect: 'ask' }, { action: 'external_directory', resource: '*', effect: 'ask' }]
  if (mode === 'ask') rules.unshift({ action: 'edit', resource: '*', effect: 'ask' })
  return rules
}

/**
 * Thinking control as opencode model variants. Unknown variant keys are passed
 * through as request-body fields (verified against a capture server):
 *  - oMLX: chat_template_kwargs.enable_thinking (its reasoning_effort is unreliable)
 *  - DwarfStar: reasoning_effort levels, and `thinking: false` to switch it off
 */
function variantsFor(m: CodeModel): Record<string, unknown> | undefined {
  if (m.thinking === 'toggle') return {
    on: { chat_template_kwargs: { enable_thinking: true } },
    off: { chat_template_kwargs: { enable_thinking: false } },
  }
  if (m.thinking === 'effort') return {
    off: { thinking: false },
    low: { reasoningEffort: 'low' }, medium: { reasoningEffort: 'medium' }, high: { reasoningEffort: 'high' },
  }
  return undefined
}

function variantId(m: CodeModel, t: CodeThinking | undefined): string | undefined {
  if (!t || t === 'default' || m.thinking === 'none') return undefined
  if (m.thinking === 'toggle') return t === 'off' ? 'off' : 'on'
  return t === 'on' ? 'medium' : t
}

const modelRef = (m: CodeModel, t: CodeThinking | undefined) => {
  const v = variantId(m, t)
  return { providerID: m.backend, id: m.model, ...(v ? { variant: v } : {}) }
}

/**
 * opencode's prompt tells the model to prefer its temp folder for scratch
 * files; a local model then wrote a requested deliverable there instead of
 * the project (seen live). One standing line fixes the reading.
 */
const BUILT_IN = 'Files the user asks you to create or change belong in the working directory: use paths relative to it unless the user names another location. The temporary folder is only for your own scratch files.'

/** Built-in plus user extra instructions, in a file referenced from the generated config. */
function instructionsFile(text: string): string[] {
  const dir = join(tmpdir(), 'locallab-opencode')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'instructions.md')
  writeFileSync(path, [BUILT_IN, text.trim()].filter(Boolean).join('\n\n') + '\n')
  return [path]
}

function configFor(models: CodeModel[], settings: CodeSettings) {
  const provider: Record<string, unknown> = {}
  for (const m of models) {
    const p = (provider[m.backend] ??= {
      npm: '@ai-sdk/openai-compatible',
      name: BACKEND_LABEL[m.backend],
      options: { baseURL: BACKEND_URL[m.backend] },
      models: {},
    }) as { models: Record<string, unknown> }
    p.models[m.model] = {
      name: m.label,
      tool_call: true,
      reasoning: m.reasoning,
      attachment: m.vision,
      // opencode reserves the full output budget out of the context window and
      // compacts early when it doesn't fit; with oMLX's 32K cap and opencode's
      // ~14K-token system prompt, an 8K reserve forced compaction on turn 3.
      limit: { context: m.contextWindow, output: m.contextWindow <= 32768 ? Math.min(m.maxOutput, 4096) : m.maxOutput },
      ...(variantsFor(m) ? { variants: variantsFor(m) } : {}),
    }
  }
  const instructions = instructionsFile(settings.appendSystemPrompt)
  return { $schema: 'https://opencode.ai/config.json', autoupdate: false, share: 'disabled', provider, ...(instructions.length ? { instructions } : {}) }
}

/**
 * opencode's global instructions. By default it falls back to Claude Code's
 * ~/.claude/CLAUDE.md, whose Claude-specific rules (subagents, skills, loop
 * mode…) are pure noise for a local model and pushed the system prompt to ~48K
 * characters; a model fed that went off writing files under ~/Library/Claude.
 * An app-owned OPENCODE_CONFIG_DIR whose AGENTS.md links to the shared machine
 * context (~/.codex/AGENTS.md, the same content omp reads) replaces that
 * fallback, while project-level AGENTS.md / CLAUDE.md files are still read.
 */
function configDir(): string {
  const dir = join(tmpdir(), 'locallab-opencode', 'config')
  mkdirSync(dir, { recursive: true })
  const link = join(dir, 'AGENTS.md')
  const shared = process.env.LOCALLAB_AGENTS_MD ?? join(homedir(), '.codex', 'AGENTS.md')
  let current: string | undefined
  try { current = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : 'file' } catch { /* missing */ }
  if (current !== (existsSync(shared) ? shared : undefined)) {
    rmSync(link, { force: true })
    if (existsSync(shared)) symlinkSync(shared, link)
  }
  return dir
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => { const a = s.address(); s.close(() => resolve(typeof a === 'object' && a ? a.port : 0)) })
  })
}

type Listener = (ev: { type: string; data: any }) => void

/** The single shared server, started lazily and restarted if it dies. */
class OpencodeServer {
  private child?: ChildProcess
  private base = ''
  private auth = ''
  private starting?: Promise<void>
  private listeners = new Map<string, Set<Listener>>()
  private stream?: AbortController
  private configKey = ''

  /**
   * Start the server, or restart it when the generated config changed — unless
   * another session's turn is running on it, in which case the old config
   * stays until the next idle moment rather than killing that turn.
   */
  async ensure(models: CodeModel[], settings: CodeSettings, othersRunning: () => boolean = () => false): Promise<void> {
    const key = JSON.stringify(configFor(models, settings))
    const alive = !!this.child && this.child.exitCode === null
    if (alive && (this.configKey === key || othersRunning())) return
    if (this.starting) return this.starting
    this.starting = this.start(key).finally(() => { this.starting = undefined })
    return this.starting
  }

  private async start(config: string) {
    this.stop()
    const port = await freePort()
    const password = randomBytes(24).toString('base64url')
    this.base = `http://127.0.0.1:${port}`
    this.auth = 'Basic ' + Buffer.from('opencode:' + password).toString('base64')
    this.configKey = config
    const child = spawn(OPENCODE, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
      cwd: homedir(),
      env: modelEnv({
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_CONFIG_CONTENT: config,
        OPENCODE_DISABLE_MODELS_FETCH: '1',
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_FREE_MODELS: '1',
        OPENCODE_CONFIG_DIR: configDir(),
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    let log = ''
    const keep = (d: Buffer) => { log = (log + d.toString().replaceAll(password, '***')).slice(-4000) }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`opencode serve exited: ${log.trim().split('\n').slice(-4).join('\n')}`)
      try {
        const r = await fetch(this.base + '/api/info', { headers: { authorization: this.auth }, signal: AbortSignal.timeout(1000) })
        if (r.ok) break
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250))
    }
    if (Date.now() >= deadline) throw new Error('opencode serve did not start within 30 s')
    this.subscribe()
  }

  private subscribe() {
    this.stream?.abort()
    const ctl = new AbortController()
    this.stream = ctl
    const run = async () => {
      while (!ctl.signal.aborted) {
        try {
          const r = await fetch(this.base + '/api/event', { headers: { authorization: this.auth, accept: 'text/event-stream' }, signal: ctl.signal })
          if (!r.ok || !r.body) throw new Error(`event stream ${r.status}`)
          const split = lineSplitter((line) => {
            if (!line.startsWith('data:')) return
            let ev: any
            try { ev = JSON.parse(line.slice(5).trim()) } catch { return }
            const sid = ev?.data?.sessionID
            if (sid) for (const l of this.listeners.get(sid) ?? []) l(ev)
          })
          for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) split(Buffer.from(chunk))
        } catch {
          if (ctl.signal.aborted) return
        }
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
    void run()
  }

  on(sessionId: string, l: Listener): () => void {
    let set = this.listeners.get(sessionId)
    if (!set) this.listeners.set(sessionId, (set = new Set()))
    set.add(l)
    return () => { set!.delete(l) }
  }

  async api(method: string, path: string, body?: unknown): Promise<any> {
    const r = await fetch(this.base + path, {
      method,
      headers: { authorization: this.auth, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await r.text()
    let j: any
    try { j = text ? JSON.parse(text) : undefined } catch { j = text }
    if (!r.ok) throw new Error(j?.message ?? `opencode ${method} ${path}: ${r.status}`)
    return j?.data ?? j
  }

  /** Primary agents the user can pick (build, plan, …). */
  async agents(): Promise<CodeAgent[]> {
    const list = (await this.api('GET', '/api/agent')) as any[]
    return (list ?? []).filter((a) => a.mode === 'primary' && !a.hidden).map((a) => ({ id: a.id, description: a.description }))
  }

  get running(): boolean { return !!this.child && this.child.exitCode === null }

  stop() {
    this.stream?.abort()
    this.stream = undefined
    if (this.child && this.child.exitCode === null) this.child.kill('SIGTERM')
    this.child = undefined
  }
}

export const opencodeServer = new OpencodeServer()

export class OpencodeDriver implements Driver {
  running = false
  private off?: () => void
  private sessionId?: string
  private toolNames = new Map<string, string>()
  private approvals = new Set<string>()
  private commandNames?: Set<string>

  constructor(private host: DriverHost, private allModels: () => Promise<CodeModel[]>) {}

  private async ensureSession(): Promise<string> {
    await opencodeServer.ensure(await this.allModels(), this.host.settings(), this.host.othersRunning)
    const s = this.host.session
    if (!this.sessionId && s.harnessRef) {
      try { await opencodeServer.api('GET', `/api/session/${s.harnessRef}`); this.sessionId = s.harnessRef } catch { /* gone; make a new one */ }
    }
    if (!this.sessionId) {
      const created = await opencodeServer.api('POST', '/api/session', {
        title: s.title,
        location: { directory: s.cwd },
        model: modelRef(this.host.model, s.thinking),
        permissions: permissions(s.mode),
        ...(s.agent ? { agent: s.agent } : {}),
      })
      this.sessionId = created.id as string
      this.host.setRef(this.sessionId)
    } else {
      // Mode and model may have changed while the app was closed.
      await opencodeServer.api('PATCH', `/api/session/${this.sessionId}`, { permissions: permissions(s.mode) }).catch(() => {})
    }
    if (!this.off) this.off = opencodeServer.on(this.sessionId, (ev) => this.onEvent(ev))
    return this.sessionId
  }

  private finish() {
    this.running = false
    this.host.emit({ type: 'turn-end' })
    this.host.emit({ type: 'status', status: { state: 'idle' } })
  }

  private onEvent(ev: { type: string; data: any }) {
    const d = ev.data ?? {}
    const emit = this.host.emit
    switch (ev.type) {
      case 'session.execution.started':
        this.running = true
        emit({ type: 'status', status: { state: 'running' } })
        return
      case 'session.text.delta':
        emit({ type: 'text', delta: d.delta ?? '' })
        return
      case 'session.reasoning.delta':
        emit({ type: 'thinking', delta: d.delta ?? '' })
        return
      case 'session.tool.input.started':
        this.toolNames.set(d.id, d.name)
        emit({ type: 'tool-start', id: d.id, name: d.name, input: '' })
        return
      case 'session.tool.called':
        emit({ type: 'tool-start', id: d.id, name: this.toolNames.get(d.id) ?? 'tool', input: d.input })
        return
      case 'session.tool.success':
        emit({ type: 'tool-end', id: d.id, output: resultText(d.content) })
        return
      case 'session.tool.failed':
        emit({ type: 'tool-end', id: d.id, output: resultText(d.error ?? d.content ?? d.message ?? 'failed'), error: true })
        return
      case 'session.step.ended': {
        const t = d.tokens
        if (t) {
          emit({ type: 'usage', input: t.input ?? 0, output: t.output ?? 0, cached: t.cache?.read })
          // Prompt tokens of the last step ≈ what the next request carries.
          emit({ type: 'context', tokens: (t.input ?? 0) + (t.cache?.read ?? 0) + (t.output ?? 0), window: this.host.model.contextWindow })
        }
        return
      }
      case 'session.compaction.started':
        emit({ type: 'notice', level: 'info', text: 'Compacting the conversation…' })
        return
      case 'session.compaction.ended':
        emit({ type: 'notice', level: 'info', text: 'Conversation compacted.' })
        return
      case 'session.compaction.failed':
        emit({ type: 'notice', level: 'warning', text: `Compaction failed: ${resultText(d.error ?? d.message ?? d)}` })
        return
      case 'session.retry.scheduled':
        emit({ type: 'notice', level: 'warning', text: `Retrying: ${d.message ?? d.error ?? 'model error'}` })
        return
      case 'session.error':
      case 'session.step.failed':
        emit({ type: 'notice', level: 'error', text: resultText(d.error ?? d.message ?? d) })
        return
      case 'permission.asked': {
        this.approvals.add(d.id)
        const patch = (d.metadata?.files ?? []).map((f: any) => f.patch).filter(Boolean).join('\n')
        const what = d.action === 'shell' ? 'Run command' : d.action === 'edit' ? 'Edit files'
          : d.action === 'external_directory' ? 'Access outside the session folder' : `Allow ${d.action}`
        emit({ type: 'approval', id: d.id, title: `${what}: ${(d.resources ?? []).join(', ')}`, detail: patch || d.message || '' })
        emit({ type: 'status', status: { state: 'approval' } })
        return
      }
      case 'permission.replied':
        if (this.approvals.delete(d.requestID)) emit({ type: 'approval-resolved', id: d.requestID, approved: d.reply !== 'reject' })
        return
      case 'session.execution.succeeded':
        this.finish()
        return
      case 'session.execution.failed':
        emit({ type: 'notice', level: 'error', text: resultText(d.error ?? d.message ?? 'The run failed.') })
        this.finish()
        return
      case 'session.execution.interrupted':
        emit({ type: 'notice', level: 'info', text: 'Stopped.' })
        this.finish()
        return
    }
  }

  async prompt({ text, images, delivery }: PromptInput): Promise<void> {
    const files = images.map((a, i) => ({ uri: `data:${a.mime};base64,${readBase64(a)}`, name: `image-${i + 1}.${a.mime.split('/')[1] ?? 'png'}` }))
    const extra = { ...(files.length ? { files } : {}), ...(this.running && delivery ? { delivery } : {}) }
    const wasRunning = this.running
    this.running = true
    if (!wasRunning) this.host.emit({ type: 'status', status: { state: 'running' } })
    try {
      const id = await this.ensureSession()
      // "/name args" runs an opencode command (init, review, goal, …) when one exists.
      const slash = text.match(/^\/([\w:-]+)\s*([\s\S]*)$/)
      if (slash && (await this.commandSet()).has(slash[1])) {
        await opencodeServer.api('POST', `/api/session/${id}/command`, { name: slash[1], text: slash[2], ...extra })
      } else {
        await opencodeServer.api('POST', `/api/session/${id}/prompt`, { text, ...extra })
      }
    } catch (e) {
      if (!wasRunning) {
        this.running = false
        this.host.emit({ type: 'status', status: { state: 'idle' } })
      }
      throw e
    }
  }

  private async commandSet(): Promise<Set<string>> {
    if (!this.commandNames?.size) this.commandNames = new Set((await this.commands()).map((c) => c.name))
    return this.commandNames
  }

  async commands(): Promise<CodeCommand[]> {
    await opencodeServer.ensure(await this.allModels(), this.host.settings(), this.host.othersRunning)
    // A just-started server loads its command list asynchronously; an empty
    // answer in the first seconds means "not yet", not "none".
    for (let attempt = 0; ; attempt++) {
      const list = ((await opencodeServer.api('GET', '/api/command')) as any[]) ?? []
      if (list.length || attempt >= 12) return list.map((c) => ({ name: c.name, description: c.description }))
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  async setThinking(level: CodeThinking): Promise<void> {
    if (this.sessionId) await opencodeServer.api('POST', `/api/session/${this.sessionId}/model`, { model: modelRef(this.host.model, level) })
  }

  async setAgent(agent: string): Promise<void> {
    if (this.sessionId) await opencodeServer.api('POST', `/api/session/${this.sessionId}/agent`, { agent })
  }

  async compact(): Promise<void> {
    if (this.running) throw new Error('Wait for the current turn to finish before compacting.')
    const id = await this.ensureSession()
    await opencodeServer.api('POST', `/api/session/${id}/compact`, {})
  }

  async abort(): Promise<void> {
    if (!this.sessionId) return
    for (const id of [...this.approvals]) await this.answer(id, false)
    await opencodeServer.api('POST', `/api/session/${this.sessionId}/interrupt`).catch(() => {})
  }

  async answer(approvalId: string, approve: boolean): Promise<void> {
    if (!this.sessionId) return
    await opencodeServer.api('POST', `/api/session/${this.sessionId}/permission/${approvalId}/reply`, { decision: approve ? 'once' : 'reject' })
    if (this.approvals.delete(approvalId)) this.host.emit({ type: 'approval-resolved', id: approvalId, approved: approve })
    if (this.running) this.host.emit({ type: 'status', status: { state: 'running' } })
  }

  async setModel(model: CodeModel): Promise<void> {
    this.host.model = model
    if (this.sessionId) await opencodeServer.api('POST', `/api/session/${this.sessionId}/model`, { model: modelRef(model, this.host.session.thinking) })
  }

  dispose(): void {
    this.off?.()
    this.off = undefined
  }
}
