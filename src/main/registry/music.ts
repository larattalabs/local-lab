import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Adapter, RunContext } from './types'
import { workerPath } from '../paths'

const home = homedir()
const ACESTEP_DIR = process.env.LOCALLAB_ACESTEP_DIR ?? join(home, 'AI', 'ace-step')
const ACESTEP_PY = join(ACESTEP_DIR, '.venv', 'bin', 'python')

/**
 * ACE-Step has no one-shot CLI — its `acestep` entry point launches a Gradio
 * server. So we drive the pipeline through a small worker script (see
 * resources/workers/acestep_worker.py), the same shape every other adapter
 * uses: arguments in, one file out.
 *
 * The worker drives the handler/inference API (AceStepHandler +
 * generate_music) — the same call path ACE-Step's own UI uses.
 */
const acestep: Adapter = {
  id: 'acestep',
  label: 'ACE-Step v1.5',
  modality: 'music',
  family: 'acestep',
  notes: 'Text-to-music (xl-turbo DiT + 4B LM). Lyrics optional; blank = instrumental.',
  outputExt: 'wav',
  approxPeakGb: 24,
  requires: [ACESTEP_PY],
  params: [
    { key: 'duration', label: 'Duration (s)', type: 'int', default: 30, min: 5, max: 240 },
    { key: 'seed', label: 'Seed', type: 'seed', default: null },
    { key: 'steps', label: 'Steps', type: 'int', default: 8, min: 4, max: 60, advanced: true,
      help: 'xl-turbo is tuned for 8 steps with guidance off.' },
    { key: 'lyrics', label: 'Lyrics', type: 'string', default: '', advanced: true,
      help: 'Leave blank for an instrumental.' },
  ],
  build({ prompt, params, outPath }: RunContext) {
    const args = [
      workerPath('acestep_worker.py'),
      '--prompt', prompt,
      '--duration', String(params.duration ?? 30),
      '--steps', String(params.steps ?? 8),
      '--output', outPath,
    ]
    if (params.seed != null && params.seed !== '') args.push('--seed', String(params.seed))
    if (params.lyrics) args.push('--lyrics', String(params.lyrics))
    return { bin: ACESTEP_PY, args, cwd: ACESTEP_DIR }
  },
}

export const musicAdapters: Adapter[] = [acestep]
