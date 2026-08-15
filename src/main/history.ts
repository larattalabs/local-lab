import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Adapter } from './registry/types'
import type { Job, Modality, RunRecord } from '@shared/types'
import { RUNS_DIR } from './env'

const MODALITIES: Modality[] = ['image', 'video', 'music', 'text']

/** Persist a finished job beside its artifact. The runs folder IS the database. */
export function writeRunRecord(dir: string, adapter: Adapter, job: Job): void {
  if (job.state !== 'done' && job.state !== 'error' && job.state !== 'cancelled') return
  const rec: RunRecord = {
    dir,
    modality: adapter.modality,
    adapterId: adapter.id,
    adapterLabel: adapter.label,
    prompt: job.prompt,
    params: job.params,
    state: job.state,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    outputPath: job.outputPath,
    textPreview: job.text ? job.text.slice(0, 2000) : undefined,
  }
  try {
    writeFileSync(join(dir, 'run.json'), JSON.stringify(rec, null, 2))
    // Text runs have no artifact file; persist the full output so the run
    // survives the app (and shows up if browsed in Finder).
    if (!job.outputPath && job.text) writeFileSync(join(dir, 'output.txt'), job.text)
  } catch {
    // History is best-effort; a failed metadata write must not fail the run.
  }
}

/** A run dir without run.json predates metadata. Rebuild what the dirname knows. */
function legacyRecord(modality: Modality, dir: string, name: string): RunRecord | null {
  const m = name.match(/^(.+Z)_(.+)$/)
  const artifact = readdirSync(dir).find((f) => f.startsWith('output.'))
  if (!artifact) return null
  const stamp = m ? Date.parse(m[1].replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ':$1:$2.$3Z')) : NaN
  const t = Number.isFinite(stamp) ? stamp : statSync(join(dir, artifact)).mtimeMs
  return {
    dir,
    modality,
    adapterId: m ? m[2] : 'unknown',
    adapterLabel: m ? m[2] : 'unknown',
    prompt: '',
    params: {},
    state: 'done',
    queuedAt: t,
    finishedAt: t,
    outputPath: artifact === 'output.txt' ? undefined : join(dir, artifact),
    textPreview: artifact === 'output.txt'
      ? readFileSync(join(dir, artifact), 'utf8').slice(0, 2000)
      : undefined,
  }
}

export function listRuns(): RunRecord[] {
  const out: RunRecord[] = []
  for (const modality of MODALITIES) {
    const root = join(RUNS_DIR, modality)
    if (!existsSync(root)) continue
    for (const name of readdirSync(root)) {
      const dir = join(root, name)
      try {
        if (!statSync(dir).isDirectory()) continue
        const metaPath = join(dir, 'run.json')
        if (existsSync(metaPath)) {
          const rec = JSON.parse(readFileSync(metaPath, 'utf8')) as RunRecord
          rec.dir = dir // heal records if the folder was moved
          if (rec.outputPath && !existsSync(rec.outputPath)) {
            const artifact = readdirSync(dir).find((f) => f.startsWith('output.'))
            rec.outputPath = artifact ? join(dir, artifact) : undefined
          }
          out.push(rec)
        } else {
          const rec = legacyRecord(modality, dir, name)
          if (rec) out.push(rec)
        }
      } catch {
        // One unreadable run dir must not take down the whole history.
      }
    }
  }
  return out.sort((a, b) => (b.finishedAt ?? b.queuedAt) - (a.finishedAt ?? a.queuedAt))
}

/** Delete a run directory. Refuses anything outside RUNS_DIR. */
export function deleteRun(dir: string): void {
  const target = resolve(dir)
  if (!target.startsWith(resolve(RUNS_DIR) + '/')) {
    throw new Error('refusing to delete outside the runs folder')
  }
  rmSync(target, { recursive: true, force: true })
}
