import { readFileSync } from 'node:fs'
import type { CodeAgent, CodeAttachment, CodeCommand, CodeDelivery, CodeEvent, CodeModel, CodeSession, CodeSettings, CodeThinking } from '@shared/code'

export interface PromptInput {
  text: string
  images: CodeAttachment[]
  /** Set when the message arrives while a turn is running. */
  delivery?: CodeDelivery
}

/**
 * One live harness conversation. A driver owns whatever the harness needs (an
 * omp RPC child process, or a session on the shared opencode server) and
 * reports everything through `emit` as normalized `CodeEvent`s.
 */
export interface Driver {
  readonly running: boolean
  /** Starts a turn (or queues/steers into a running one); resolves once accepted, not when it ends. */
  prompt(input: PromptInput): Promise<void>
  abort(): Promise<void>
  answer(approvalId: string, approve: boolean): Promise<void>
  setModel(model: CodeModel): Promise<void>
  setThinking(level: CodeThinking): Promise<void>
  /** opencode only; omp has no agent switch. */
  setAgent(agent: string): Promise<void>
  /** Summarize the conversation now to free context. */
  compact(): Promise<void>
  commands(): Promise<CodeCommand[]>
  dispose(): void
}

export interface AgentLister { agents(): Promise<CodeAgent[]> }

export interface DriverHost {
  session: CodeSession
  model: CodeModel
  emit(ev: CodeEvent): void
  /** Persist the harness-side resume handle. */
  setRef(ref: string): void
  settings(): CodeSettings
  /** Another session's turn is in flight (don't restart shared processes). */
  othersRunning(): boolean
}

export const readBase64 = (a: CodeAttachment) => readFileSync(a.path).toString('base64')

/** Text out of a harness tool result: `[{type:'text', text}]`, a string, or anything else. */
export function resultText(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(resultText).filter(Boolean).join('\n')
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o.text === 'string') return o.text
    if ('content' in o) return resultText(o.content)
    if (typeof o.output === 'string') return o.output
  }
  try { return JSON.stringify(v) } catch { return String(v) }
}

/** Line-buffer a byte stream into whole lines. */
export function lineSplitter(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let buf = ''
  return (chunk) => {
    buf += chunk.toString()
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '')
      buf = buf.slice(nl + 1)
      if (line.trim()) onLine(line)
    }
  }
}
