/**
 * Shared vocabulary between the Electron main process and the renderer.
 *
 * The whole app is one idea: every local model is "spawn a binary, in a
 * specific environment, with specific flags, and get a file (or stdout) back".
 * An `AdapterInfo` is the renderer-safe description of one such model; the main
 * process holds the actual `Adapter` with its argument builder.
 */

export type Modality = 'image' | 'video' | 'music' | 'text'

export const MODALITIES: { id: Modality; label: string; blurb: string }[] = [
  { id: 'image', label: 'Image', blurb: 'Diffusion and flow models — Krea 2, FLUX, Qwen, Z-Image' },
  { id: 'video', label: 'Video', blurb: 'Image-to-video and text-to-video' },
  { id: 'music', label: 'Music', blurb: 'Text-to-music and audio generation' },
  { id: 'text', label: 'Text', blurb: 'Local LLMs via Ollama, MLX and DwarfStar' },
]

export type ParamType = 'int' | 'float' | 'string' | 'select' | 'bool' | 'seed'

export interface ParamSpec {
  key: string
  label: string
  type: ParamType
  default?: string | number | boolean | null
  min?: number
  max?: number
  step?: number
  options?: { value: string; label: string }[]
  help?: string
  /** Render on the collapsed "advanced" shelf rather than the main form. */
  advanced?: boolean
}

/** Renderer-safe description of a model. No functions cross the IPC boundary. */
export interface AdapterInfo {
  id: string
  label: string
  modality: Modality
  /** Grouping key for the picker — 'mflux', 'krea2', 'ollama', … */
  family: string
  /** One line the UI shows under the model name. */
  notes?: string
  /** File extension the run produces; '' for stdout-only models like LLMs. */
  outputExt: string
  params: ParamSpec[]
  /** Accepts reference/init images (FLUX.2 edit, Kontext, img2img). */
  acceptsImages?: boolean
  /** The CLI *requires* an input image — editing/variation models. Running
   *  without one fails immediately with a clear message instead of a
   *  argparse traceback. */
  requiresImage?: boolean
  /** Accepts an input audio file (ACE-Step cover/remix). */
  acceptsAudio?: boolean
  /** The task cannot run without a source audio file. */
  requiresAudio?: boolean
  /** Streams tokens to stdout instead of writing a file. */
  streams?: boolean
  /** Rough peak memory in GB, shown as a warning before running big models. */
  approxPeakGb?: number
}

export interface AvailabilityReport {
  id: string
  available: boolean
  /** Why it isn't available, phrased as something the user can act on. */
  reason?: string
}

export type JobState = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export interface Job {
  id: string
  adapterId: string
  adapterLabel: string
  modality: Modality
  prompt: string
  params: Record<string, unknown>
  images?: string[]
  state: JobState
  /** Absolute path to the produced artifact, once done. */
  outputPath?: string
  /** Accumulated stdout for streaming (text) models. */
  text?: string
  error?: string
  queuedAt: number
  startedAt?: number
  finishedAt?: number
  /** Everything the process printed — the first thing you want when it fails. */
  log: string
  /** Run directory holding run.json + the artifact; set when the job starts. */
  runDir?: string
}

/** One prompt fanned out across N models — the reason this app exists. */
export interface Comparison {
  id: string
  modality: Modality
  prompt: string
  jobIds: string[]
  createdAt: number
}

export interface RunRequest {
  adapterIds: string[]
  modality: Modality
  prompt: string
  params: Record<string, Record<string, unknown>>
  images?: string[]
  /** Prior conversation turns, for context-aware text generation. */
  history?: { role: 'user' | 'assistant'; content: string }[]
}

/**
 * One persisted generation, as written to `run.json` in its run directory.
 * History is rebuilt purely from disk — the runs folder IS the database, so
 * deleting a folder in Finder and deleting from the app agree by construction.
 */
export interface RunRecord {
  dir: string
  modality: Modality
  adapterId: string
  adapterLabel: string
  prompt: string
  params: Record<string, unknown>
  state: 'done' | 'error' | 'cancelled'
  queuedAt: number
  startedAt?: number
  finishedAt?: number
  /** Absolute path of the artifact, when the run produced a file. */
  outputPath?: string
  /** First ~2000 chars of a text run's output, for preview. */
  textPreview?: string
}

/**
 * One turn in a conversation. A 'user' message is the prompt as typed; each
 * model it fanned out to gets its own 'gen' message. Gen messages mirror the
 * final state of their job so the chat replays fully after a restart, while
 * live jobs render from runner state via jobId.
 */
export interface ChatMessage {
  id: string
  role: 'user' | 'gen'
  at: number
  /* user */
  text?: string
  contextOn?: boolean
  images?: string[]
  /* gen */
  jobId?: string
  adapterId?: string
  adapterLabel?: string
  state?: JobState
  outputPath?: string
  runDir?: string
  textOut?: string
  error?: string
  seed?: string
  durationMs?: number
}

/**
 * A conversation, persisted as one JSON file under <runs>/chats/. Chats hold
 * the dialogue; artifacts stay in their run directories — deleting a chat
 * never deletes generations.
 */
export interface Chat {
  id: string
  modality: Modality
  title: string
  createdAt: number
  updatedAt: number
  /** Composer default for this chat; each user message records what it used. */
  contextOn: boolean
  messages: ChatMessage[]
}
