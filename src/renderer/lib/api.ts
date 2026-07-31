import type { AdapterInfo, AvailabilityReport, Job, Modality, RunRequest } from '@shared/types'

interface LabApi {
  listAdapters(): Promise<AdapterInfo[]>
  adaptersByModality(m: Modality): Promise<AdapterInfo[]>
  availability(): Promise<AvailabilityReport[]>
  refreshAdapters(): Promise<AdapterInfo[]>
  listJobs(): Promise<Job[]>
  run(req: RunRequest): Promise<Job[]>
  cancel(id: string): Promise<void>
  clearFinished(): Promise<void>
  pickImages(): Promise<string[]>
  reveal(p: string): Promise<void>
  openRuns(): Promise<void>
  runsDir(): Promise<string>
  onJobUpdate(cb: (job: Job) => void): () => void
}

declare global {
  interface Window { lab: LabApi }
}

export const lab = window.lab
