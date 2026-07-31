import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Environment for spawned model processes.
 *
 * The load-bearing part is HF_HOME. A GUI app launched from Finder never
 * sources ~/.zshrc, so it inherits no HF_HOME and `huggingface_hub` falls back
 * to ~/.cache/huggingface — which on this machine holds stale partial
 * downloads for models that are fully present at ~/AI/huggingface. A process
 * that inherits the wrong cache doesn't fail; it silently resumes a broken
 * download: low CPU, no progress, no error, indefinitely. Set it explicitly.
 *
 * HF_HUB_OFFLINE defaults on for the same reason — it turns a cache miss into
 * an immediate loud error instead of a silent hang. Set LOCALLAB_ALLOW_DOWNLOAD=1
 * when deliberately pulling a new model for the first time.
 */

const home = homedir()

export const AI_ROOT = process.env.LOCALLAB_AI_ROOT ?? join(home, 'AI')
export const HF_HOME = process.env.LOCALLAB_HF_HOME ?? join(AI_ROOT, 'huggingface')
export const HF_HUB_CACHE = process.env.LOCALLAB_HF_HUB_CACHE ?? join(HF_HOME, 'hub')

/** Where runs are written. Not in the repo — see .gitignore. */
export const RUNS_DIR = process.env.LOCALLAB_RUNS_DIR ?? join(home, 'AI', 'local-lab-runs')

export function modelEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // A GUI app's PATH is bare; model CLIs live in user-local bins.
    PATH: [
      join(home, '.local', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      process.env.PATH ?? '',
      '/usr/bin:/bin:/usr/sbin:/sbin',
    ].join(':'),
    HF_HOME,
    HF_HUB_CACHE,
    ...(process.env.LOCALLAB_ALLOW_DOWNLOAD === '1' ? {} : { HF_HUB_OFFLINE: '1' }),
    // Several MLX/torch audio paths call ops that have no MPS kernel; without
    // this they raise instead of falling back to CPU for that one op.
    PYTORCH_ENABLE_MPS_FALLBACK: '1',
    ...extra,
  }
}
