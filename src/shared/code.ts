/**
 * Code tab vocabulary, shared by the main process and the renderer.
 *
 * The Code tab runs a coding agent (a "harness": omp or opencode) against one
 * of the local text models. Both harnesses speak very different protocols, so
 * each driver translates its own stream into the small `CodeEvent` union below,
 * and one reducer (`reduceCode`) turns those events into the transcript. The
 * main process persists the reduced transcript; the renderer runs the same
 * reducer on live events, so both sides always agree on what was said.
 */

export type CodeHarness = 'omp' | 'opencode'

/** One server process that can hold a model in memory. Only one runs at a time. */
export type CodeBackend = 'ollama' | 'omlx' | 'ds4' | 'ds4-ablit' | 'ds4-v41'

/**
 * How much the agent may do without asking.
 *  - ask:  reads run freely; edits and commands wait for approval
 *  - edit: reads and edits run freely; commands wait for approval
 *  - auto: everything runs without asking
 */
export type CodeApprovalMode = 'ask' | 'edit' | 'auto'

/**
 * Reasoning control. oMLX models only switch thinking on or off (the chat
 * template's enable_thinking — oMLX's reasoning_effort is unreliable);
 * DwarfStar models take effort levels. 'default' leaves the model alone.
 */
export type CodeThinking = 'default' | 'on' | 'off' | 'low' | 'medium' | 'high'
export type CodeThinkingKind = 'toggle' | 'effort' | 'none'

/** How a message typed while a turn is running is delivered. */
export type CodeDelivery = 'queue' | 'steer'

export interface CodeAttachment { path: string; mime: string }

export interface CodeModel {
  /** `<backend>/<model id>`; also the omp `--model` value. */
  id: string
  backend: CodeBackend
  /** The id the backend's OpenAI-compatible server expects. */
  model: string
  label: string
  /** Short description shown under the label in the picker. */
  note: string
  /** Approximate resident memory while loaded, in GB. */
  ramGB: number
  contextWindow: number
  maxOutput: number
  reasoning: boolean
  uncensored: boolean
  vision: boolean
  /** Cold turns take a minute or more (SSD streaming). */
  slow: boolean
  thinking: CodeThinkingKind
}

/** A catalog entry as stored in the private catalog file. */
export interface CodeCatalogEntry {
  backend: CodeBackend
  model: string
  label?: string
  note?: string
  ramGB?: number
  contextWindow?: number
  maxOutput?: number
  reasoning?: boolean
  uncensored?: boolean
  vision?: boolean
  slow?: boolean
}

/** A model a server reports that may or may not be in the catalog. */
export interface CodeDiscovered {
  backend: CodeBackend
  model: string
  contextWindow?: number
  inCatalog: boolean
}

export interface CodeCheckResult { ok: boolean; seconds: number; detail: string }

/** App-wide Code tab settings (userData/code/settings.json). */
export interface CodeSettings {
  /** omp's tool list when a session uses the lean set. */
  ompTools: string[]
  /** Extra instructions appended to the harness system prompt for every session. */
  appendSystemPrompt: string
  /** Stop DwarfStar servers after this many idle minutes (0 = never). */
  idleUnloadMinutes: number
}

export const DEFAULT_OMP_TOOLS = ['read', 'write', 'edit', 'bash', 'grep', 'glob', 'todo']
export const ALL_OMP_TOOLS = [
  // omp's BUILTIN_TOOL_NAMES (16.3), minus memory/skill internals.
  'read', 'write', 'edit', 'bash', 'grep', 'glob', 'todo', 'ast_grep', 'ast_edit', 'lsp', 'task', 'web_search',
  'checkpoint', 'rewind', 'inspect_image', 'ask', 'job', 'eval', 'debug', 'browser', 'github', 'ssh',
]
export const DEFAULT_CODE_SETTINGS: CodeSettings = { ompTools: DEFAULT_OMP_TOOLS, appendSystemPrompt: '', idleUnloadMinutes: 10 }

export interface CodeCommand { name: string; description?: string }
export interface CodeAgent { id: string; description?: string }

export interface CodeChangedFile { path: string; status: string; additions: number; deletions: number; patch: string }
export interface CodeChanges { repo: boolean; branch?: string; files: CodeChangedFile[]; error?: string }

/** oMLX per-model context caps (~/.omlx/model_settings.json). */
export interface CodeServerSettings {
  omlx: { model: string; maxContext: number | null; native?: number }[]
}

export interface CodeSession {
  id: string
  title: string
  cwd: string
  harness: CodeHarness
  modelId: string
  mode: CodeApprovalMode
  /** omp only: send the configured lean tool set instead of all tools. */
  leanTools: boolean
  thinking?: CodeThinking
  /** opencode primary agent (build, plan, …). */
  agent?: string
  createdAt: number
  updatedAt: number
  /** Harness-side resume handle: omp session file, or opencode session id. */
  harnessRef?: string
}

export type CodeStatus =
  | { state: 'idle' }
  | { state: 'backend'; detail: string }
  | { state: 'running'; detail?: string }
  | { state: 'approval' }
  | { state: 'error'; detail: string }

export type CodeEvent =
  | { type: 'user'; text: string; images?: string[]; delivery?: CodeDelivery }
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool-start'; id: string; name: string; input: unknown }
  | { type: 'tool-update'; id: string; output: string }
  | { type: 'tool-end'; id: string; output: string; error?: boolean }
  | { type: 'approval'; id: string; title: string; detail: string }
  | { type: 'approval-resolved'; id: string; approved: boolean }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; text: string }
  | { type: 'usage'; input: number; output: number; cached?: number }
  | { type: 'context'; tokens: number; window: number }
  | { type: 'turn-end' }
  | { type: 'status'; status: CodeStatus }

export type CodeItem =
  | { kind: 'user'; id: string; text: string; at: number; images?: string[]; delivery?: CodeDelivery }
  | { kind: 'assistant'; id: string; text: string; thinking: string }
  | { kind: 'tool'; id: string; name: string; input: string; output: string; state: 'running' | 'done' | 'error' }
  | { kind: 'approval'; id: string; title: string; detail: string; state: 'pending' | 'approved' | 'denied' }
  | { kind: 'notice'; id: string; level: 'info' | 'warning' | 'error'; text: string }

export interface CodeTranscript {
  items: CodeItem[]
  usage?: { input: number; output: number; cached?: number }
  context?: { tokens: number; window: number }
}

/** Live push from main → renderer. */
export interface CodePush {
  sessionId: string
  event: CodeEvent
}

export interface CodeBackendState {
  /** The backend Local Lab last brought up (others were stopped first). */
  active?: CodeBackend
  /** Ports that answer right now. */
  up: CodeBackend[]
}

export interface CodeNewSession {
  cwd: string
  harness: CodeHarness
  modelId: string
  mode: CodeApprovalMode
  leanTools?: boolean
  thinking?: CodeThinking
  agent?: string
}

const MAX_TOOL_TEXT = 20_000
const clip = (s: string) => (s.length > MAX_TOOL_TEXT ? s.slice(0, MAX_TOOL_TEXT) + `\n…[${s.length - MAX_TOOL_TEXT} more characters]` : s)

export function stringifyInput(input: unknown): string {
  if (typeof input === 'string') return input
  try { return JSON.stringify(input, null, 2) ?? '' } catch { return String(input) }
}

let counter = 0
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`

/**
 * Fold one event into the transcript. Pure apart from id generation, and
 * returns a new array so Svelte state and persistence both see a change.
 */
export function reduceCode(t: CodeTranscript, ev: CodeEvent): CodeTranscript {
  const items = t.items.slice()
  const last = items[items.length - 1]
  switch (ev.type) {
    case 'user':
      items.push({ kind: 'user', id: nextId('u'), text: ev.text, at: Date.now(), ...(ev.images?.length ? { images: ev.images } : {}), ...(ev.delivery ? { delivery: ev.delivery } : {}) })
      break
    case 'text':
    case 'thinking': {
      if (!ev.delta) return t
      const a = last?.kind === 'assistant' ? { ...last } : { kind: 'assistant' as const, id: nextId('a'), text: '', thinking: '' }
      if (ev.type === 'text') a.text += ev.delta
      else a.thinking += ev.delta
      if (last?.kind === 'assistant') items[items.length - 1] = a
      else items.push(a)
      break
    }
    case 'tool-start': {
      const i = items.findIndex((x) => x.kind === 'tool' && x.id === ev.id)
      const tool = { kind: 'tool' as const, id: ev.id, name: ev.name, input: clip(stringifyInput(ev.input)), output: '', state: 'running' as const }
      if (i >= 0) items[i] = { ...(items[i] as typeof tool), name: ev.name, input: tool.input }
      else items.push(tool)
      break
    }
    case 'tool-update':
    case 'tool-end': {
      const i = items.findIndex((x) => x.kind === 'tool' && x.id === ev.id)
      if (i < 0) {
        if (ev.type === 'tool-update') return t
        items.push({ kind: 'tool', id: ev.id, name: 'tool', input: '', output: clip(ev.output), state: ev.error ? 'error' : 'done' })
        break
      }
      const cur = items[i] as Extract<CodeItem, { kind: 'tool' }>
      items[i] = ev.type === 'tool-update'
        ? { ...cur, output: clip(ev.output) }
        : { ...cur, output: clip(ev.output || cur.output), state: ev.error ? 'error' : 'done' }
      break
    }
    case 'approval':
      items.push({ kind: 'approval', id: ev.id, title: ev.title, detail: ev.detail, state: 'pending' })
      break
    case 'approval-resolved': {
      const i = items.findIndex((x) => x.kind === 'approval' && x.id === ev.id)
      if (i < 0) return t
      items[i] = { ...(items[i] as Extract<CodeItem, { kind: 'approval' }>), state: ev.approved ? 'approved' : 'denied' }
      break
    }
    case 'notice':
      items.push({ kind: 'notice', id: nextId('n'), level: ev.level, text: ev.text })
      break
    case 'usage':
      return { ...t, items, usage: { input: ev.input, output: ev.output, cached: ev.cached } }
    case 'context':
      return { ...t, items, context: { tokens: ev.tokens, window: ev.window } }
    case 'turn-end': {
      // A turn that ends with tools still "running" (abort, crash) should not
      // spin forever in the transcript.
      let changed = false
      for (let i = 0; i < items.length; i++) {
        const x = items[i]
        if (x.kind === 'tool' && x.state === 'running') { items[i] = { ...x, state: 'error', output: x.output || '(stopped)' }; changed = true }
        if (x.kind === 'approval' && x.state === 'pending') { items[i] = { ...x, state: 'denied' }; changed = true }
      }
      if (!changed) return t
      break
    }
    case 'status':
      return t
  }
  return { ...t, items }
}
