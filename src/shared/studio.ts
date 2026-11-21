import type { Chat, ChatMessage, Job, Modality, RunRecord } from './types'
export interface StudioData { favorites: string[]; titles: Record<string, string>; presetFavorites: string[]; subjectImages: { id: string; thumbnail: string }[] }
export type StudioChange = { kind: 'favorite'; path: string; value: boolean } | { kind: 'title'; id: string; title: string } | { kind: 'presetFavorite'; id: string; value: boolean } | { kind: 'subjectImage'; id: string; thumbnail: string }
export const emptyStudio = (): StudioData => ({ favorites: [], titles: {}, presetFavorites: [], subjectImages: [] })
export interface MediaItem { id: string; chatId?: string; modality: Modality; at: number; message: ChatMessage; job?: Job; source?: string; title: string }
export interface StudioProject { id: string; title: string; chats: Chat[]; items: MediaItem[]; updatedAt: number }
/** Relationships are derived, so adopting the studio never rewrites existing chats. */
export function studioProjects(chats: Chat[], runs: RunRecord[], jobs: Job[], titles: Record<string, string>): StudioProject[] {
  const visual = chats.filter((c) => c.modality === 'image' || c.modality === 'video').sort((a,b) => a.createdAt-b.createdAt || a.id.localeCompare(b.id))
  const parent = new Map(visual.map((c) => [c.id,c.id])), order = new Map(visual.map((c,i) => [c.id,i]))
  const find = (id: string): string => { const p = parent.get(id)!; if (p !== id) parent.set(id,find(p)); return parent.get(id)! }
  const link = (a: string, b: string) => { a=find(a);b=find(b); if (a!==b) parent.set((order.get(a)! < order.get(b)! ? b:a),order.get(a)! < order.get(b)! ? a:b) }
  const owners = new Map<string,string>()
  for (const c of visual) for (const m of c.messages) if (m.outputPath) owners.set(m.outputPath,c.id)
  for (const c of visual.filter(c=>!c.projectId)) for (const path of [c.sourceImage,...c.messages.flatMap((m)=>m.images??[])]) { const owner=path && owners.get(path); if(owner && !visual[order.get(owner)!].projectId)link(c.id,owner) }
  const groups=new Map<string,StudioProject>(), live = new Map(jobs.map((j)=>[j.id,j]))
  for(const c of visual){
    const id=c.projectId??find(c.id);let project=groups.get(id)
    if(!project){const root=visual[order.get(id)??order.get(c.id)!];project={id,title:titles[id]??root.title,chats:[],items:[],updatedAt:0};groups.set(id,project)}
    project.chats.push(c);project.updatedAt=Math.max(project.updatedAt,c.updatedAt)
    for(const [index,m] of c.messages.entries()){
      if(m.role!=='gen') continue
      const job=m.jobId?live.get(m.jobId):undefined
      const message={...m,...(job?{state:job.state,outputPath:job.outputPath??m.outputPath,error:job.error??m.error}: {})}
      project.items.push({id:m.id??(c.id+':legacy-'+index),chatId:c.id,modality:c.modality,at:m.at,message,job,source:m.images?.[0]??m.requestSnapshot?.images?.[0],title:project.title})
    }
  }
  const filed=new Set([...groups.values()].flatMap((p)=>p.items.map((i)=>i.message.outputPath)))
  for(const r of runs)if(['image','video'].includes(r.modality)&&r.outputPath&&!filed.has(r.outputPath)){
    const id='run:'+r.dir
    groups.set(id,{id,title:r.prompt.slice(0,70)||r.adapterLabel,chats:[],updatedAt:r.finishedAt??r.queuedAt,items:[{id,modality:r.modality,at:r.queuedAt,title:r.prompt.slice(0,70),message:{id,role:'gen',at:r.queuedAt,state:r.state,outputPath:r.outputPath,adapterId:r.adapterId,adapterLabel:r.adapterLabel,effectivePrompt:r.prompt,images:r.images,requestSnapshot:r.images?{modality:r.modality,adapterIds:[r.adapterId],params:{[r.adapterId]:r.params},prompt:r.prompt,images:r.images,basic:r.basic}:undefined},source:r.images?.[0]}]})
  }
  for(const p of groups.values())p.items.sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id))
  return [...groups.values()].sort((a,b)=>b.updatedAt-a.updatedAt||a.id.localeCompare(b.id))
}
export interface ProgressInfo { label: string; step?: number; total?: number }
/** Report only explicit runtime lines. A sampling percentage is never presented as total-job progress. */
export function reportedProgress(job: Job): ProgressInfo {
  return job.progress ?? parseProgress(job)
}
export function parseProgress(job: Job): ProgressInfo {
  if(job.state==='queued')return {label:'Waiting in queue'}
  if(job.state==='done')return {label:'Ready'}
  if(job.state==='error')return {label:'Generation needs attention'}
  if(job.state==='cancelled')return {label:'Cancelled'}
  if(job.kind==='director')return {label:'Preparing your prompt'}
  let result: ProgressInfo={label:'Working on your '+(job.modality==='video'?'video':'image')}
  for(const raw of job.log.replace(/\x1b\[[0-9;]*[a-zA-Z]/g,'').split(/[\r\n]+/)){
    const line=raw.trim();if(line.startsWith('$ '))continue
    if(/^(?:\[.*?\]\s*)?(?:loading|loaded|initializing|restoring)\b.*(?:model|weight|checkpoint|encoder)/i.test(line))result={label:'Loading the model'}
    if(/^(?:\[.*?\]\s*)?(?:encoding|encoded)\b.*(?:prompt|text)/i.test(line))result={label:'Encoding your prompt'}
    if(/^Qwen INT8:/.test(line))result={label:'Generating'}
    if(/(?:denois|sampling|diffusion steps|stage [12]|step\s+\d)/i.test(line)){
      const match=/(\d+)\s*\/\s*(\d+)/.exec(line)
      result=match&&Number(match[2])>0&&Number(match[1])<=Number(match[2])?{label:'Generating',step:Number(match[1]),total:Number(match[2])}:{label:'Generating'}
    }
    if(/^(?:\[.*?\]\s*)?(?:decoding|saving|writing|muxing|encoding video)\b/i.test(line))result={label:'Finishing the media'}
  }
  return result
}
export function durationEstimate(adapterId: string, params: Record<string,unknown>, items: MediaItem[]): string | undefined {
  const key=(p:Record<string,unknown>)=>JSON.stringify(Object.entries(p).filter(([k])=>!['seed','negative'].includes(k)).sort(([a],[b])=>a.localeCompare(b)))
  const samples=items.filter((i)=>i.message.state==='done'&&i.message.adapterId===adapterId&&i.message.durationMs&&key(i.message.requestSnapshot?.params[adapterId]??{})===key(params)).sort((a,b)=>a.at-b.at).slice(-12).map((i)=>i.message.durationMs!/1000)
  if(!samples.length)return
  const fmt=(n:number)=>n<60?`${Math.round(n)}s`:`${Math.round(n/60)} min`
  if(samples.length<3)return `Last run ${fmt(samples.at(-1)!)}`
  samples.sort((a,b)=>a-b)
  return `Usually ${fmt(samples[Math.floor(samples.length*.2)])}–${fmt(samples[Math.min(samples.length-1,Math.floor(samples.length*.8))])}`
}
