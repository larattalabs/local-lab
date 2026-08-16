import type { AdapterInfo, AvailabilityReport, Chat, Job, Modality, RunRecord, RunRequest } from '@shared/types'

interface LabApi {
  listAdapters(): Promise<AdapterInfo[]>
  adaptersByModality(m: Modality): Promise<AdapterInfo[]>
  availability(): Promise<AvailabilityReport[]>
  refreshAdapters(): Promise<AdapterInfo[]>
  listJobs(): Promise<Job[]>
  run(req: RunRequest): Promise<Job[]>
  cancel(id: string): Promise<void>
  clearFinished(): Promise<void>
  listHistory(): Promise<RunRecord[]>
  deleteRun(dir: string): Promise<void>
  listChats(): Promise<Chat[]>
  saveChat(chat: Chat): Promise<void>
  deleteChat(id: string): Promise<void>
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

/**
 * Served over the app's own `labfile://` scheme — see src/main/index.ts for
 * why plain file:// does not work here, and why the whole path goes in as a
 * single encoded segment rather than as URL path components.
 */
export function fileUrl(p: string): string {
  return 'labfile://f/' + encodeURIComponent(p)
}
