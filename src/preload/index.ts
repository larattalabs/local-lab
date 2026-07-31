import { contextBridge, ipcRenderer } from 'electron'
import type { AdapterInfo, AvailabilityReport, Job, Modality, RunRequest } from '@shared/types'

/**
 * The renderer gets exactly these calls and nothing else — no `require`, no
 * direct filesystem, no arbitrary spawn. Every model invocation goes through
 * the registry in the main process, so the UI cannot construct a command line.
 */
const api = {
  listAdapters: (): Promise<AdapterInfo[]> => ipcRenderer.invoke('adapters:list'),
  adaptersByModality: (m: Modality): Promise<AdapterInfo[]> =>
    ipcRenderer.invoke('adapters:byModality', m),
  availability: (): Promise<AvailabilityReport[]> => ipcRenderer.invoke('adapters:availability'),
  refreshAdapters: (): Promise<AdapterInfo[]> => ipcRenderer.invoke('adapters:refresh'),

  listJobs: (): Promise<Job[]> => ipcRenderer.invoke('jobs:list'),
  run: (req: RunRequest): Promise<Job[]> => ipcRenderer.invoke('jobs:run', req),
  cancel: (id: string): Promise<void> => ipcRenderer.invoke('jobs:cancel', id),
  clearFinished: (): Promise<void> => ipcRenderer.invoke('jobs:clearFinished'),

  pickImages: (): Promise<string[]> => ipcRenderer.invoke('files:pickImages'),
  reveal: (p: string): Promise<void> => ipcRenderer.invoke('files:reveal', p),
  openRuns: (): Promise<void> => ipcRenderer.invoke('files:openRuns'),
  runsDir: (): Promise<string> => ipcRenderer.invoke('app:runsDir'),

  onJobUpdate: (cb: (job: Job) => void) => {
    const h = (_e: unknown, job: Job) => cb(job)
    ipcRenderer.on('job:update', h)
    return () => ipcRenderer.off('job:update', h)
  },
}

contextBridge.exposeInMainWorld('lab', api)
export type LabApi = typeof api
