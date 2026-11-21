import type { HistoryClear } from '@shared/history-reset'
import type { ModifierConfig } from '@shared/modifiers'
import type { StudioChange } from '@shared/studio'
import type { BasicInput, BasicPreset } from '@shared/basic'
import type { DirectorConfig, DirectorStart } from '@shared/director'
import { contextBridge, ipcRenderer } from 'electron'
import type { AdapterInfo, AvailabilityReport, Chat, Job, SubmitTurn, TurnResult, PhoneStatus, Modality, RunRecord, RunRequest } from '@shared/types'

/**
 * The renderer gets exactly these calls and nothing else — no `require`, no
 * direct filesystem, no arbitrary spawn. Every model invocation goes through
 * the registry in the main process, so the UI cannot construct a command line.
 */
const api = {
  historyState: () => ipcRenderer.invoke('history:state'),
  historyPreview: () => ipcRenderer.invoke('history:preview'),
  historyClear: (input: HistoryClear) => ipcRenderer.invoke('history:clear', input),
  onHistoryReset: (cb: () => void) => { ipcRenderer.on('history:reset', cb); return () => ipcRenderer.off('history:reset', cb) },
  studioInfo: () => ipcRenderer.invoke('studio:info'),
  studioUpdate: (input: StudioChange) => ipcRenderer.invoke('studio:update', input),
  onStudioUpdate: (cb: () => void) => { ipcRenderer.on('studio:update', cb); return () => ipcRenderer.off('studio:update', cb) },
  basicModifiers: (input: ModifierConfig) => ipcRenderer.invoke('basic:modifiers', input),
  onBasicUpdate: (cb: () => void) => { ipcRenderer.on('basic:update', cb); return () => ipcRenderer.off('basic:update', cb) },
  basicCatalog: () => ipcRenderer.invoke('basic:catalog'),
  basicPlan: (input: BasicInput) => ipcRenderer.invoke('basic:plan', input),
  basicSave: (input: BasicPreset) => ipcRenderer.invoke('basic:save', input),
  basicDelete: (input: { id: string; version: number }) => ipcRenderer.invoke('basic:delete', input),
  saveMedia: (path: string) => ipcRenderer.invoke('files:save', path),
  directorInfo: () => ipcRenderer.invoke('director:info'),
  directorConfigure: (config: DirectorConfig) => ipcRenderer.invoke('director:configure', config),
  directorStart: (input: DirectorStart) => ipcRenderer.invoke('director:start', input),
  directorStatus: (id: string) => ipcRenderer.invoke('director:status', id),
  listAdapters: (): Promise<AdapterInfo[]> => ipcRenderer.invoke('adapters:list'),
  adaptersByModality: (m: Modality): Promise<AdapterInfo[]> =>
    ipcRenderer.invoke('adapters:byModality', m),
  availability: (): Promise<AvailabilityReport[]> => ipcRenderer.invoke('adapters:availability'),
  refreshAdapters: (): Promise<AdapterInfo[]> => ipcRenderer.invoke('adapters:refresh'),

  jobLog: (id:string):Promise<string> => ipcRenderer.invoke('jobs:log',id),
  listJobs: (): Promise<Job[]> => ipcRenderer.invoke('jobs:list'),
  run: (req: RunRequest): Promise<Job[]> => ipcRenderer.invoke('jobs:run', req),
  cancel: (id: string): Promise<void> => ipcRenderer.invoke('jobs:cancel', id),
  clearFinished: (): Promise<void> => ipcRenderer.invoke('jobs:clearFinished'),

  listHistory: (): Promise<RunRecord[]> => ipcRenderer.invoke('history:list'),
  deleteRun: (dir: string): Promise<void> => ipcRenderer.invoke('history:delete', dir),
  listChats: (): Promise<Chat[]> => ipcRenderer.invoke('chats:list'),
  submitTurn: (turn: SubmitTurn): Promise<TurnResult> => ipcRenderer.invoke('chats:submit', turn),
  onChatsUpdate: (cb: () => void) => { ipcRenderer.on('chats:update', cb); return () => ipcRenderer.off('chats:update', cb) },
  phoneStatus: (): Promise<PhoneStatus> => ipcRenderer.invoke('phone:status'),
  phoneEnable: (): Promise<PhoneStatus> => ipcRenderer.invoke('phone:enable'),
  phoneDisable: (): Promise<PhoneStatus> => ipcRenderer.invoke('phone:disable'),
  phonePair: (): Promise<PhoneStatus> => ipcRenderer.invoke('phone:pair'),
  phoneApprove: (id: string, allow: boolean): Promise<PhoneStatus> => ipcRenderer.invoke('phone:approve', id, allow),
  phoneRevoke: (id: string): Promise<PhoneStatus> => ipcRenderer.invoke('phone:revoke', id),
  phoneCertificate: (): Promise<void> => ipcRenderer.invoke('phone:certificate'),
  deleteChat: (id: string): Promise<void> => ipcRenderer.invoke('chats:delete', id),

  pickImages: (): Promise<string[]> => ipcRenderer.invoke('files:pickImages'),
  pickAudio: (): Promise<string[]> => ipcRenderer.invoke('files:pickAudio'),
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

/** Code tab (desktop only; never proxied to the phone server). */
const codeApi = {
  catalog: () => ipcRenderer.invoke('code:catalog'),
  refreshCatalog: () => ipcRenderer.invoke('code:refreshCatalog'),
  backends: () => ipcRenderer.invoke('code:backends'),
  list: () => ipcRenderer.invoke('code:list'),
  open: (id: string) => ipcRenderer.invoke('code:open', id),
  create: (input: unknown) => ipcRenderer.invoke('code:create', input),
  send: (id: string, text: string, images?: string[], delivery?: string) => ipcRenderer.invoke('code:send', id, text, images, delivery),
  saveImage: (base64: string, mime: string) => ipcRenderer.invoke('code:saveImage', base64, mime),
  pickImages: () => ipcRenderer.invoke('files:pickImages'),
  compact: (id: string) => ipcRenderer.invoke('code:compact', id),
  commands: (id: string) => ipcRenderer.invoke('code:commands', id),
  agents: () => ipcRenderer.invoke('code:agents'),
  changes: (id: string) => ipcRenderer.invoke('code:changes', id),
  settings: () => ipcRenderer.invoke('code:settings'),
  saveSettings: (input: unknown) => ipcRenderer.invoke('code:saveSettings', input),
  discover: () => ipcRenderer.invoke('code:discover'),
  checkModel: (backend: string, model: string) => ipcRenderer.invoke('code:checkModel', backend, model),
  saveModel: (entry: unknown) => ipcRenderer.invoke('code:saveModel', entry),
  removeModel: (id: string) => ipcRenderer.invoke('code:removeModel', id),
  serverSettings: () => ipcRenderer.invoke('code:serverSettings'),
  setOmlxContext: (model: string, ctx: number | null) => ipcRenderer.invoke('code:setOmlxContext', model, ctx),
  onCheckStatus: (cb: (line: string) => void) => { const h = (_e: unknown, l: string) => cb(l); ipcRenderer.on('code:checkStatus', h); return () => ipcRenderer.off('code:checkStatus', h) },
  stop: (id: string) => ipcRenderer.invoke('code:stop', id),
  stopBackend: (backend: string) => ipcRenderer.invoke('code:stopBackend', backend),
  answer: (id: string, approvalId: string, approve: boolean) => ipcRenderer.invoke('code:answer', id, approvalId, approve),
  configure: (id: string, patch: unknown) => ipcRenderer.invoke('code:configure', id, patch),
  remove: (id: string) => ipcRenderer.invoke('code:remove', id),
  pickFolder: () => ipcRenderer.invoke('code:pickFolder'),
  reveal: (path: string) => ipcRenderer.invoke('code:reveal', path),
  onEvent: (cb: (p: unknown) => void) => { const h = (_e: unknown, p: unknown) => cb(p); ipcRenderer.on('code:event', h); return () => ipcRenderer.off('code:event', h) },
  onSessions: (cb: () => void) => { ipcRenderer.on('code:sessions', cb); return () => ipcRenderer.off('code:sessions', cb) },
}
contextBridge.exposeInMainWorld('labCode', codeApi)
