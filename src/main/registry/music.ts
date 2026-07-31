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
 * EXPERIMENTAL: the worker is written against ACE-Step's documented pipeline
 * API but has not been run end-to-end here. Expect to adjust the worker, not
 * this adapter, if the first run fails.
 */
const acestep: Adapter = {
  id: 'acestep',
  label: 'ACE-Step v1.5',
  modality: 'music',
  family: 'acestep',
  notes: 'EXPERIMENTAL — text-to-music. Worker not yet verified end-to-end.',
  outputExt: 'wav',
  approxPeakGb: 24,
  requires: [ACESTEP_PY],
  params: [
    { key: 'duration', label: 'Duration (s)', type: 'int', default: 30, min: 5, max: 240 },
    { key: 'seed', label: 'Seed', type: 'seed', default: null },
    { key: 'steps', label: 'Steps', type: 'int', default: 27, min: 8, max: 60, advanced: true },
    { key: 'lyrics', label: 'Lyrics', type: 'string', default: '', advanced: true,
      help: 'Leave blank for an instrumental.' },
  ],
  build({ prompt, params, outPath }: RunContext) {
    const args = [
      workerPath('acestep_worker.py'),
      '--prompt', prompt,
      '--duration', String(params.duration ?? 30),
      '--steps', String(params.steps ?? 27),
      '--output', outPath,
    ]
    if (params.seed != null && params.seed !== '') args.push('--seed', String(params.seed))
    if (params.lyrics) args.push('--lyrics', String(params.lyrics))
    return { bin: ACESTEP_PY, args, cwd: ACESTEP_DIR }
  },
}

export const musicAdapters: Adapter[] = [acestep]
