import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CodeApprovalMode, CodeCommand, CodeModel, CodeThinking } from '@shared/code'
import { modelEnv } from '../env'
import { workerPath } from '../paths'
import { lineSplitter, readBase64, resultText, type Driver, type DriverHost, type PromptInput } from './driver'

/**
 * omp (Oh My Pi) over its JSON-lines RPC protocol.
 *
 * `--mode rpc-ui`, not plain `rpc`: only rpc-ui gives the agent an interactive
 * UI context, and without one every tool that needs approval fails with "no
 * interactive UI available" instead of asking. Approvals then arrive as
 * `extension_ui_request` select prompts (Approve / Deny) that we answer.
 *
 * The binary is spawned directly, not through the `omp()` zsh function: that
 * wrapper exists to start/stop model servers, which the BackendManager already
 * did — and a Finder-launched app has no zshrc anyway.
 */

const home = homedir()
const OMP = process.env.LOCALLAB_OMP_BIN ?? join(home, '.bun', 'bin', 'omp')
const MODE: Record<CodeApprovalMode, string> = { ask: 'always-ask', edit: 'write', auto: 'yolo' }

export function ompAvailable(): boolean { return existsSync(OMP) }

/**
 * omp is a `#!/usr/bin/env bun` script, and bun usually comes from mise, which
 * only reaches PATH through an interactive shell. Find it explicitly.
 */
function bunDir(): string | undefined {
  const mise = join(home, '.local', 'share', 'mise', 'installs', 'bun')
  const candidates = [
    process.env.LOCALLAB_BUN_BIN && dirname(process.env.LOCALLAB_BUN_BIN),
    join(home, '.bun', 'bin'),
    join(mise, 'latest', 'bin'),
    ...(existsSync(mise) ? readdirSync(mise).sort().reverse().map((v) => join(mise, v, 'bin')) : []),
    join(home, '.local', 'share', 'mise', 'shims'),
    '/opt/homebrew/bin',
  ].filter(Boolean) as string[]
  return candidates.find((d) => existsSync(join(d, 'bun')))
}

/**
 * Run-only omp settings for Code sessions (a `--config` overlay; nothing in
 * ~/.omp changes):
 *  - compaction.strategy: context-full. omp's default, snapcompact, archives
 *    history as bitmap images for the model to read back: it throws on
 *    text-only local models and stalled (no request, no answer) on a local
 *    vision model. A plain LLM summary works on every model.
 *  - thresholdPercent: 85 for windows of 64K or less. The default flat
 *    16,384-token reserve made 32K windows compact on every turn.
 */
function configOverlay(model: CodeModel): string {
  const small = model.contextWindow <= 65536
  const path = join(tmpdir(), `locallab-omp-${small ? 'small' : 'large'}-window.yml`)
  const body = `compaction:\n  strategy: context-full\n${small ? '  thresholdPercent: 85\n' : ''}`
  writeFileSync(path, body)
  return path
}

/**
 * omp thinking levels. oMLX models are configured with the qwen-chat-template
 * dialect, where any enabled level just turns thinking on.
 */
function ompThinking(t: CodeThinking | undefined): string | undefined {
  if (!t || t === 'default') return undefined
  return t === 'on' ? 'medium' : t
}

interface Pending { resolve(v: any): void; reject(e: Error): void }

export class OmpDriver implements Driver {
  private child?: ChildProcessWithoutNullStreams
  private seq = 0
  private pending = new Map<string, Pending>()
  /** extension_ui_request ids we surfaced as approvals, and how to answer each. */
  private approvals = new Map<string, 'select' | 'confirm'>()
  private stderr = ''
  private disposed = false
  /** Children we stopped on purpose; their exit is not an error. */
  private killed = new WeakSet<ChildProcessWithoutNullStreams>()
  running = false

  constructor(private host: DriverHost) {}

  private start(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null) return this.child
    const s = this.host.session
    const args = ['--mode', 'rpc-ui', '--cwd', s.cwd, '--model', this.host.model.id, '--approval-mode', MODE[s.mode]]
    // The full 19-tool default costs ~18K prompt tokens per turn; the lean set is ~55% smaller.
    const settings = this.host.settings()
    if (s.leanTools && settings.ompTools.length) args.push('--tools', settings.ompTools.join(','))
    const thinking = ompThinking(s.thinking)
    if (thinking && this.host.model.thinking !== 'none') args.push('--thinking', thinking)
    if (settings.appendSystemPrompt.trim()) args.push('--append-system-prompt', settings.appendSystemPrompt.trim())
    // Writes outside the folder always ask, except in Full auto (see the hook's header).
    if (s.mode !== 'auto') args.push('--hook', workerPath('omp-folder-guard.ts'))
    args.push('--config', configOverlay(this.host.model))
    if (s.harnessRef && existsSync(s.harnessRef)) args.push('--resume', s.harnessRef)
    if (s.cwd === home) args.push('--allow-home')
    // Tests point this at a temp dir so they don't add to the user's omp history.
    if (process.env.LOCALLAB_OMP_SESSION_DIR) args.push('--session-dir', process.env.LOCALLAB_OMP_SESSION_DIR)
    const child = spawn(OMP, args, {
      cwd: s.cwd,
      env: modelEnv({ PATH: [bunDir(), join(home, '.bun', 'bin'), join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin:/bin:/usr/sbin:/sbin'].filter(Boolean).join(':') }),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    this.stderr = ''
    child.stdout.on('data', lineSplitter((l) => this.onLine(l)))
    child.stderr.on('data', (d) => { this.stderr = (this.stderr + d.toString()).slice(-4000) })
    child.on('error', (e) => this.host.emit({ type: 'notice', level: 'error', text: `omp failed to start: ${e.message}` }))
    child.on('close', (code) => {
      for (const p of this.pending.values()) p.reject(new Error('omp exited'))
      this.pending.clear()
      if (this.child === child) this.child = undefined
      if (!this.disposed && !this.killed.has(child) && (this.running || code !== 0)) {
        const tail = this.stderr.trim().split('\n').slice(-6).join('\n')
        this.host.emit({ type: 'notice', level: 'error', text: `omp exited (code ${code}).${tail ? '\n' + tail : ''}` })
      }
      if (this.running) this.finish()
    })
    return child
  }

  /**
   * One RPC command. A timeout backs up the id-less error case below, so a
   * command omp never answers can't wedge the session (compaction may run a
   * model call, hence its long limit; `prompt` returns before the turn runs).
   */
  private send(cmd: Record<string, unknown>): Promise<any> {
    const child = this.start()
    const id = `ll-${++this.seq}`
    const limit = cmd.type === 'compact' ? 15 * 60_000 : 120_000
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`omp did not answer "${cmd.type}" within ${limit / 1000}s.`))
      }, limit)
      timer.unref?.()
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      child.stdin.write(JSON.stringify({ ...cmd, id }) + '\n')
    })
  }

  private write(frame: Record<string, unknown>) {
    this.child?.stdin.write(JSON.stringify(frame) + '\n')
  }

  private finish() {
    this.running = false
    this.host.emit({ type: 'turn-end' })
    this.host.emit({ type: 'status', status: { state: 'idle' } })
  }

  private onLine(line: string) {
    let ev: any
    try { ev = JSON.parse(line) } catch { return }
    const emit = this.host.emit
    switch (ev.type) {
      case 'response': {
        // Some failures come back without our id, reported as command "parse"
        // (seen: compact → "Failed to parse command: Nothing to compact
        // (session too small)"). Commands are answered in order, so fail the
        // oldest pending one rather than leave it waiting forever.
        const key = ev.id && this.pending.has(ev.id) ? ev.id : (!ev.success ? this.pending.keys().next().value : undefined)
        const p = key && this.pending.get(key)
        if (p) {
          this.pending.delete(key)
          if (ev.success) p.resolve(ev.data)
          else p.reject(new Error(String(ev.error ?? `${ev.command} failed`).replace(/^Failed to parse command: /, '')))
        }
        return
      }
      case 'agent_start':
        // A queued follow-up (or compaction) can start its own agent run after
        // agent_end: track it as running so the service doesn't treat the
        // session as idle (second prompt, mode change, backend switch) mid-run.
        this.running = true
        emit({ type: 'status', status: { state: 'running' } })
        return
      case 'prompt_result':
        // A slash command handled by omp itself never starts an agent turn.
        if (ev.agentInvoked === false && this.running) { this.finish(); void this.captureRef() }
        return
      case 'message_update': {
        const a = ev.assistantMessageEvent
        if (a?.type === 'text_delta') emit({ type: 'text', delta: a.delta })
        else if (a?.type === 'thinking_delta') emit({ type: 'thinking', delta: a.delta })
        else if (a?.type === 'error') emit({ type: 'notice', level: 'error', text: a.error?.errorMessage ?? `Model error (${a.reason})` })
        return
      }
      case 'message_end': {
        const u = ev.message?.role === 'assistant' ? ev.message.usage : undefined
        if (u) emit({ type: 'usage', input: u.input ?? 0, output: u.output ?? 0, cached: u.cacheRead })
        return
      }
      case 'tool_execution_start':
        emit({ type: 'tool-start', id: ev.toolCallId, name: ev.toolName, input: ev.args })
        return
      case 'tool_execution_update':
        emit({ type: 'tool-update', id: ev.toolCallId, output: resultText(ev.partialResult) })
        return
      case 'tool_execution_end':
        emit({ type: 'tool-end', id: ev.toolCallId, output: resultText(ev.result), error: !!ev.isError })
        return
      case 'agent_end':
        this.finish()
        void this.captureRef()
        return
      case 'auto_retry_start':
        emit({ type: 'notice', level: 'warning', text: `Retrying (${ev.attempt}/${ev.maxAttempts}): ${ev.errorMessage}` })
        return
      case 'notice':
        emit({ type: 'notice', level: ev.level ?? 'info', text: ev.message })
        return
      case 'auto_compaction_start':
        emit({ type: 'notice', level: 'info', text: 'Compacting the conversation to fit the context window…' })
        return
      case 'extension_ui_request':
        this.onUi(ev)
        return
    }
  }

  private onUi(ev: any) {
    const emit = this.host.emit
    switch (ev.method) {
      case 'select': {
        // Tool approvals are a select with Approve/Deny; other selects come from
        // extensions we don't render, so decline them instead of hanging.
        if (Array.isArray(ev.options) && ev.options.includes('Approve')) {
          const [title, ...rest] = String(ev.title ?? 'Allow tool?').split('\n')
          this.approvals.set(ev.id, 'select')
          emit({ type: 'approval', id: ev.id, title, detail: rest.join('\n') })
          emit({ type: 'status', status: { state: 'approval' } })
        } else this.write({ type: 'extension_ui_response', id: ev.id, cancelled: true })
        return
      }
      case 'confirm':
        this.approvals.set(ev.id, 'confirm')
        emit({ type: 'approval', id: ev.id, title: ev.title ?? 'Confirm', detail: ev.message ?? '' })
        emit({ type: 'status', status: { state: 'approval' } })
        return
      case 'input':
      case 'editor':
        this.write({ type: 'extension_ui_response', id: ev.id, cancelled: true })
        return
      case 'notify':
        emit({ type: 'notice', level: ev.notifyType ?? 'info', text: ev.message })
        return
      case 'cancel':
        if (this.approvals.delete(ev.targetId)) emit({ type: 'approval-resolved', id: ev.targetId, approved: false })
        return
    }
  }

  private async captureRef() {
    try {
      const st = await this.send({ type: 'get_state' })
      if (st?.sessionFile) this.host.setRef(st.sessionFile)
      const u = st?.contextUsage
      if (u && typeof u.tokens === 'number') this.host.emit({ type: 'context', tokens: u.tokens, window: u.contextWindow })
    } catch { /* process gone */ }
  }

  async prompt({ text, images, delivery }: PromptInput): Promise<void> {
    const imgs = images.map((a) => ({ type: 'image', data: readBase64(a), mimeType: a.mime }))
    const withImages = imgs.length ? { images: imgs } : {}
    if (this.running && this.child) {
      // Mid-turn: steer injects before the next model call; follow_up waits for the turn to end.
      await this.send({ type: delivery === 'steer' ? 'steer' : 'follow_up', message: text, ...withImages })
      return
    }
    this.running = true
    this.host.emit({ type: 'status', status: { state: 'running' } })
    try {
      await this.send({ type: 'prompt', message: text, ...withImages })
    } catch (e) {
      // A crash was already reported (with stderr) by the close handler.
      if (e instanceof Error && e.message === 'omp exited') return
      this.running = false
      this.host.emit({ type: 'status', status: { state: 'idle' } })
      throw e
    }
  }

  async abort(): Promise<void> {
    if (!this.child) return
    for (const id of this.approvals.keys()) await this.answer(id, false)
    await this.send({ type: 'abort' }).catch(() => {})
  }

  async answer(approvalId: string, approve: boolean): Promise<void> {
    const kind = this.approvals.get(approvalId)
    if (!kind) return
    this.approvals.delete(approvalId)
    this.write(kind === 'select'
      ? { type: 'extension_ui_response', id: approvalId, value: approve ? 'Approve' : 'Deny' }
      : { type: 'extension_ui_response', id: approvalId, confirmed: approve })
    this.host.emit({ type: 'approval-resolved', id: approvalId, approved: approve })
    if (this.running) this.host.emit({ type: 'status', status: { state: 'running' } })
  }

  async setModel(model: CodeModel): Promise<void> {
    const overlayChanged = configOverlay(this.host.model) !== configOverlay(model)
    this.host.model = model
    if (!this.child || this.child.exitCode !== null) return
    // The compaction overlay is a launch flag: relaunch (resuming the same
    // session file) when moving between small- and large-window models.
    if (overlayChanged) { this.stopChild(); return }
    await this.send({ type: 'set_model', provider: model.backend, modelId: model.model })
  }

  async setThinking(level: CodeThinking): Promise<void> {
    const t = ompThinking(level)
    if (t && this.child && this.child.exitCode === null) await this.send({ type: 'set_thinking_level', level: t })
  }

  async setAgent(): Promise<void> { /* omp has no primary-agent switch */ }

  async compact(): Promise<void> {
    if (this.running) throw new Error('Wait for the current turn to finish before compacting.')
    this.running = true
    this.host.emit({ type: 'status', status: { state: 'running', detail: 'Compacting…' } })
    try {
      await this.send({ type: 'compact' })
      this.host.emit({ type: 'notice', level: 'info', text: 'Conversation compacted.' })
    } finally {
      this.running = false
      this.host.emit({ type: 'status', status: { state: 'idle' } })
    }
    await this.captureRef()
  }

  async commands(): Promise<CodeCommand[]> {
    const r = await this.send({ type: 'get_available_commands' })
    return (r?.commands ?? []).map((c: any) => ({ name: c.name, description: c.description }))
  }

  dispose(): void {
    this.disposed = true
    this.stopChild()
  }

  private stopChild(): void {
    const c = this.child
    this.child = undefined
    if (c && c.exitCode === null) {
      this.killed.add(c)
      c.stdin.end()
      c.kill('SIGTERM')
      setTimeout(() => { if (c.exitCode === null) c.kill('SIGKILL') }, 3000).unref()
    }
  }
}
