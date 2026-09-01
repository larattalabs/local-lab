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

/**
 * Cover / remix — ACE-Step's Gradio calls this "Remix Mode"; the API task is
 * `cover`. Feed it a song and a style caption: it regenerates the track in the
 * new style while keeping the source's structure and melody. Duration is
 * locked to the source. The 5Hz LM is skipped for this task (per ACE-Step's
 * API docs), so the worker doesn't load it — covers start faster than
 * text2music despite doing more.
 */
const acestepCover: Adapter = {
  id: 'acestep-cover',
  label: 'ACE-Step — remix / cover',
  modality: 'music',
  family: 'acestep',
  notes: 'Attach a song, describe the target style. Keeps melody/structure; swaps genre, instrumentation, vocals.',
  outputExt: 'wav',
  approxPeakGb: 16,
  acceptsAudio: true,
  requiresAudio: true,
  requires: [ACESTEP_PY],
  params: [
    { key: 'cover_strength', label: 'Cover strength', type: 'float', default: 0.7,
      min: 0, max: 1, step: 0.05,
      help: '1.0 hugs the original notes; ~0.2 is loose style transfer. 0.7 is a good remix default.' },
    { key: 'seed', label: 'Seed', type: 'seed', default: null },
    { key: 'lyrics', label: 'Lyrics', type: 'string', default: '', advanced: true,
      help: 'Paste the original lyrics to keep vocals aligned, or new ones to swap them. Blank leans instrumental.' },
    { key: 'bpm', label: 'BPM lock', type: 'int', default: null, min: 30, max: 300, advanced: true,
      help: 'Blank = auto-detect from the source.' },
    { key: 'keyscale', label: 'Key lock', type: 'string', default: '', advanced: true,
      help: 'e.g. "E Major" or "Am". Blank = auto-detect.' },
    { key: 'steps', label: 'Steps', type: 'int', default: 8, min: 4, max: 60, advanced: true },
  ],
  build({ prompt, params, outPath, images }: RunContext) {
    const args = [
      workerPath('acestep_worker.py'),
      '--task', 'cover',
      '--src-audio', images[0],
      '--prompt', prompt,
      '--cover-strength', String(params.cover_strength ?? 0.7),
      '--steps', String(params.steps ?? 8),
      '--output', outPath,
    ]
    if (params.seed != null && params.seed !== '') args.push('--seed', String(params.seed))
    if (params.lyrics) args.push('--lyrics', String(params.lyrics))
    if (params.bpm != null && params.bpm !== '') args.push('--bpm', String(params.bpm))
    if (params.keyscale) args.push('--keyscale', String(params.keyscale))
    return { bin: ACESTEP_PY, args, cwd: ACESTEP_DIR }
  },
}

export const musicAdapters: Adapter[] = [acestep, acestepCover]
