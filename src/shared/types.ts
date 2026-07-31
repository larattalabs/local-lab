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
  { id: 'text', label: 'Text', blurb: 'Local LLMs via Ollama and MLX' },
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
}
