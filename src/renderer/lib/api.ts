import type { HistoryClear, HistoryPreview, HistoryState } from '@shared/history-reset'
import type { ModifierConfig } from '@shared/modifiers'
import type { StudioData, StudioChange } from '@shared/studio'
import type { BasicCatalog, BasicInput, BasicPlan, BasicPreset } from '@shared/basic'
import type { DirectorConfig, DirectorInfo, DirectorStart, DirectorStatus } from '@shared/director'
import type { AdapterInfo, AvailabilityReport, Chat, Job, Modality, RunRecord, RunRequest, SubmitTurn, TurnResult, PhoneStatus } from '@shared/types'

interface LabApi {
  historyState(): Promise<HistoryState>
  historyPreview(): Promise<HistoryPreview>
  historyClear(input: HistoryClear): Promise<HistoryState>
  onHistoryReset(cb: () => void): () => void
  studioInfo(): Promise<StudioData>
  studioUpdate(input: StudioChange): Promise<StudioData>
  onStudioUpdate(cb: () => void): () => void
  basicModifiers(input: ModifierConfig): Promise<BasicCatalog>
  onBasicUpdate(cb: () => void): () => void
  basicCatalog(): Promise<BasicCatalog>
  basicPlan(input: BasicInput): Promise<BasicPlan>
  basicSave(input: BasicPreset): Promise<BasicCatalog>
  basicDelete(input: { id: string; version: number }): Promise<BasicCatalog>
  saveMedia(path: string): Promise<void>
  directorInfo(): Promise<DirectorInfo>
  directorConfigure(config: DirectorConfig): Promise<DirectorInfo>
  directorStart(input: DirectorStart): Promise<DirectorStatus>
  directorStatus(id: string): Promise<DirectorStatus>
  listAdapters(): Promise<AdapterInfo[]>
  adaptersByModality(m: Modality): Promise<AdapterInfo[]>
  availability(): Promise<AvailabilityReport[]>
  refreshAdapters(): Promise<AdapterInfo[]>
  jobLog?(id:string):Promise<string>
  listJobs(): Promise<Job[]>
  run(req: RunRequest): Promise<Job[]>
  submitTurn(turn: SubmitTurn): Promise<TurnResult>
  cancel(id: string): Promise<void>
  clearFinished(): Promise<void>
  listHistory(): Promise<RunRecord[]>
  deleteRun(dir: string): Promise<void>
  listChats(): Promise<Chat[]>
  deleteChat(id: string): Promise<void>
  pickImages(): Promise<string[]>
  pickAudio(): Promise<string[]>
  reveal(p: string): Promise<void>
  openRuns(): Promise<void>
  runsDir(): Promise<string>
  onJobUpdate(cb: (job: Job) => void): () => void
  onChatsUpdate(cb: () => void): () => void
  onSync?(cb: () => void): () => void
  phoneStatus(): Promise<PhoneStatus>
  phoneEnable(): Promise<PhoneStatus>
  phoneDisable(): Promise<PhoneStatus>
  phonePair(): Promise<PhoneStatus>
  phoneApprove(id: string, allow: boolean): Promise<PhoneStatus>
  phoneRevoke(id: string): Promise<PhoneStatus>
  phoneCertificate(): Promise<void>
}
declare global { interface Window { lab: LabApi } }
export const isWeb = !window.lab
export async function webRequest(path: string, value?: unknown) {
  const res = await fetch(path, { method: value === undefined ? 'GET' : 'POST',
    headers: value === undefined ? {} : { 'Content-Type': 'application/json', 'X-Lab-Request': '1' },
    body: value === undefined ? undefined : JSON.stringify(value), cache: 'no-store' })
  const data = await res.json()
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event('lab:unpaired'))
    throw new Error(data.error ?? 'Could not reach the Mac.')
  }
  return data
}
const rpc = (method: string, arg?: unknown) => webRequest('/api/rpc', { method, arg })
const resets = new Set<() => void>()
const basic = new Set<() => void>()
const studio = new Set<() => void>()
const jobs = new Set<(job: Job) => void>(), chats = new Set<() => void>(), sync = new Set<() => void>()
let events: EventSource | undefined
export function disconnect() { events?.close(); events = undefined }
export function connect() {
  if (!isWeb || events) return
  events = new EventSource('/api/events')
  events.addEventListener('job', (e) => { const job = JSON.parse(e.data); for (const cb of jobs) cb(job) })
  events.addEventListener('history-reset', () => { for (const cb of resets) cb() })
  events.addEventListener('basic', () => { for (const cb of basic) cb() })
  events.addEventListener('studio', () => { for (const cb of studio) cb() })
  events.addEventListener('chats', () => { for (const cb of chats) cb() })
  events.addEventListener('sync', () => { for (const cb of sync) cb(); window.dispatchEvent(new CustomEvent('lab:connection', { detail: true })) })
  events.onerror = () => {
    window.dispatchEvent(new CustomEvent('lab:connection', { detail: false }))
    void webRequest('/api/session').catch(() => {})
  }
}
if (isWeb) {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && events) { disconnect(); connect() }
  })
}
async function pickImages(): Promise<string[]> {
  const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp'; input.multiple = true
  const files = await new Promise<File[]>((resolve) => {
    input.onchange = () => resolve(Array.from(input.files ?? [])); input.oncancel = () => resolve([]); input.click()
  })
  if (files.length > 16) throw new Error('Choose up to 16 images.')
  const paths: string[] = []
  for (const file of files) {
    if (file.size > 25 * 1024 * 1024) throw new Error('Each image must be smaller than 25 MB.')
    const res = await fetch('/api/upload', { method: 'POST', headers: { 'X-Lab-Request': '1' }, body: file })
    const data = await res.json(); if (!res.ok) throw new Error(data.error); paths.push(data.path)
  }
  return paths
}
async function share(path: string) {
  // Save/share uses the authenticated media URL. Safari can save the opened image/video.
  const a = document.createElement('a'); a.href = fileUrl(path) + '?download=1'; a.download = 'local-lab'; a.click()
}
const desktopOnly = async (): Promise<never> => { throw new Error('Manage this on the Mac in Local Lab.') }
const remote: LabApi = {
  historyState: () => rpc('historyState'), historyPreview: () => rpc('historyPreview'), historyClear: (input) => rpc('historyClear', input),
  onHistoryReset: (cb) => { resets.add(cb); return () => resets.delete(cb) },
  studioInfo: () => rpc('studioInfo'), studioUpdate: (input) => rpc('studioUpdate', input),
  onStudioUpdate: (cb) => { studio.add(cb); return () => studio.delete(cb) },
  basicModifiers: (input) => rpc('basicModifiers', input),
  onBasicUpdate: (cb) => { basic.add(cb); return () => basic.delete(cb) },
  basicCatalog: () => rpc('basicCatalog'), basicPlan: (input) => rpc('basicPlan', input),
  basicSave: (input) => rpc('basicSave', input), basicDelete: (input) => rpc('basicDelete', input), saveMedia: share,
  directorInfo: () => rpc('directorInfo'), directorConfigure: (config) => rpc('directorConfigure', config),
  directorStart: (input) => rpc('directorStart', input), directorStatus: (id) => rpc('directorStatus', id),
  listAdapters: () => rpc('listAdapters'), adaptersByModality: async (m) => (await rpc('listAdapters')).filter((a: AdapterInfo) => a.modality === m),
  availability: () => rpc('availability'), refreshAdapters: () => rpc('listAdapters'), listJobs: () => rpc('listJobs'),
  run: desktopOnly, submitTurn: (t) => rpc('submitTurn', t), cancel: (id) => rpc('cancel', id), clearFinished: () => rpc('clearFinished'),
  listHistory: () => rpc('listHistory'), deleteRun: desktopOnly, listChats: () => rpc('listChats'), deleteChat: (id) => rpc('deleteChat', id),
  pickImages, pickAudio: desktopOnly, reveal: share, openRuns: desktopOnly, runsDir: async () => '/api/assets',
  onJobUpdate: (cb) => { jobs.add(cb); return () => jobs.delete(cb) }, onChatsUpdate: (cb) => { chats.add(cb); return () => chats.delete(cb) },
  onSync: (cb) => { sync.add(cb); return () => sync.delete(cb) },
  phoneStatus: desktopOnly, phoneEnable: desktopOnly, phoneDisable: desktopOnly, phonePair: desktopOnly,
  phoneApprove: desktopOnly, phoneRevoke: desktopOnly, phoneCertificate: desktopOnly,
}
export const lab = isWeb ? remote : window.lab
export function fileUrl(p: string): string { return isWeb ? p : 'labfile://f/' + encodeURIComponent(p) }

export function thumbnailUrl(path:string) { return fileUrl(path) + '?thumbnail=1' }
