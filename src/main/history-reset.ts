import { existsSync, mkdirSync, lstatSync, readdirSync, readFileSync, writeFileSync, renameSync, rmdirSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { HistoryClear, HistoryPreview, HistoryState } from '@shared/history-reset'
const directories = ['image', 'video', 'music', 'text', 'chats', 'uploads', 'basic-plans', 'director', 'wan-cache']
interface ResetJournal { runs: string; name: string; resetId: string; phase: 'staging'|'trash'|'metadata' }
const journalPath = (settings: string) => join(settings, 'history-reset-journal.json')
function writeJournal(settings: string, journal: ResetJournal) {
  const path = journalPath(settings)
  writeFileSync(path + '.tmp', JSON.stringify(journal), {mode:0o600})
  renameSync(path + '.tmp', path)
}
// Recover files before constructors recreate managed directories. Finish metadata after startup.
export function recoverHistory(runs: string, settings: string): boolean {
  const path = journalPath(settings)
  if (!existsSync(path)) return false
  const journal: ResetJournal = JSON.parse(readFileSync(path, 'utf8'))
  if (journal.runs !== resolve(runs) || !/^Cleared history [0-9TZ-]+ [0-9a-f]{8}$/.test(journal.name) ||
      !/^[0-9a-f-]{36}$/.test(journal.resetId)) throw new Error('Invalid pending history reset. Check the runs folder.')
  const stage = join(runs, journal.name)
  if (journal.phase === 'staging' || (journal.phase === 'trash' && existsSync(stage))) {
    if (existsSync(stage)) {
      if (!lstatSync(stage).isDirectory()) throw new Error('Cannot restore the history staging directory.')
      for (const name of directories) {
        const source = join(stage,name)
        if (!existsSync(source)) continue
        if (existsSync(join(runs,name))) throw new Error('History recovery requires reviewing both copies of '+name)
        renameSync(source,join(runs,name))
      }
      rmdirSync(stage)
    }
    unlinkSync(path)
    return false
  }
  if (!['trash','metadata'].includes(journal.phase)) throw new Error('Unknown history recovery phase.')
  const state = join(settings, 'history-reset.json')
  writeFileSync(state+'.tmp', JSON.stringify({resetId:journal.resetId}), {mode:0o600})
  renameSync(state+'.tmp',state)
  return true
}
interface Dependencies {
  busy(): boolean
  trash(path: string): Promise<void>
  reset(): void
}
/** Only app-owned history directories are moved. Models and unrelated folders are never traversed. */
export class HistoryReset {
  private state: HistoryState
  private stateFile: string
  private operations = 0
  private clearing = false
  private challenge?: { token: string; fingerprint: string; expires: number }
  private listeners = new Set<() => void>()
  constructor(private runs: string, private settings: string, private dep: Dependencies) {
    this.runs = resolve(runs); mkdirSync(settings, {recursive:true})
    this.stateFile = join(settings, 'history-reset.json')
    this.state = existsSync(this.stateFile) ? JSON.parse(readFileSync(this.stateFile, 'utf8')) : {resetId:'initial'}
  }
  finishRecovery() {
    this.dep.reset()
    unlinkSync(journalPath(this.settings))
  }
  info(): HistoryState { return {...this.state} }
  onChange(fn:()=>void) { this.listeners.add(fn); return ()=>this.listeners.delete(fn) }
  async access<T>(operation:()=>T|Promise<T>): Promise<T> {
    if (this.clearing) throw new Error('History is being cleared. Try again in a moment.')
    this.operations++
    try { return await operation() } finally { this.operations-- }
  }
  private snapshot() {
    if (existsSync(this.runs) && lstatSync(this.runs).isSymbolicLink()) throw new Error('The history folder is a symbolic link. Manage it in Finder instead.')
    const hash=createHash('sha256'), counts={files:0,bytes:0,images:0,videos:0,chats:0,audio:0}
    const paths:string[]=[]
    const walk=(path:string,relative:string)=>{
      const st=lstatSync(path); hash.update(JSON.stringify([relative,st.size,st.mtimeMs,st.ino]))
      if(st.isDirectory()) for(const name of readdirSync(path).sort()) walk(join(path,name),relative+'/'+name)
      else {
        counts.files++;counts.bytes+=st.size
        if(/\.(png|jpe?g|webp)$/i.test(path))counts.images++
        if(/\.(mp4|webm|mov)$/i.test(path))counts.videos++
        if(/\.(wav|mp3|flac|m4a|aac|ogg)$/i.test(path))counts.audio++
        if(relative.startsWith('chats/')&&path.endsWith('.json'))counts.chats++
      }
    }
    for(const name of directories){const path=join(this.runs,name);if(!existsSync(path))continue
      if(lstatSync(path).isSymbolicLink())throw new Error('A history directory is a symbolic link. Manage it in Finder instead.')
      paths.push(path);walk(path,name)
    }
    return {...counts,paths,fingerprint:hash.digest('hex')}
  }
  preview(): HistoryPreview {
    if(this.clearing)throw new Error('History is being cleared. Try again in a moment.')
    const snap=this.snapshot(),token=randomUUID()
    this.challenge={token,fingerprint:snap.fingerprint,expires:Date.now()+5*60000}
    const {paths,fingerprint,...counts}=snap
    return {token,...counts,busy:this.dep.busy()||this.operations>0}
  }
  async clear(input: HistoryClear): Promise<HistoryState> {
    if(input?.confirmation!=='CLEAR'||!this.challenge||input.token!==this.challenge.token||Date.now()>this.challenge.expires)throw new Error('Open Clear history again and type CLEAR to confirm.')
    if(this.clearing||this.operations||this.dep.busy())throw new Error('Wait for generation, prompt preparation and uploads to finish, or cancel them first.')
    const snap=this.snapshot()
    if(snap.fingerprint!==this.challenge.fingerprint)throw new Error('History changed while this dialog was open. Refresh the summary and confirm again.')
    this.clearing=true;this.challenge=undefined
    const next:HistoryState={resetId:randomUUID()}
    const staging=join(this.runs,'Cleared history '+new Date().toISOString().replace(/[:.]/g,'-')+' '+next.resetId.slice(0,8))
    const journal: ResetJournal = { runs:this.runs, name:staging.slice(this.runs.length+1), resetId:next.resetId, phase:'staging' }
    const moved:string[]=[]
    let committed=false
    try {
      // Check metadata can be written before moving anything.
      writeFileSync(this.stateFile+'.tmp',JSON.stringify(next),{mode:0o600})
      writeJournal(this.settings,journal)
      if(snap.paths.length){
        mkdirSync(staging,{recursive:true})
        for(const path of snap.paths){const name=path.slice(this.runs.length+1);renameSync(path,join(staging,name));moved.push(name)}
        journal.phase = 'trash'
        writeJournal(this.settings,journal)
        await this.dep.trash(staging)
      }
      committed=true
      journal.phase='metadata'
      writeJournal(this.settings,journal)
      renameSync(this.stateFile+'.tmp',this.stateFile);this.state=next
      this.dep.reset()
      unlinkSync(journalPath(this.settings))
      return this.info()
    } catch(e) {
      if(!committed){
        const unrestored: string[] = []
        for(const name of moved.reverse())try{renameSync(join(staging,name),join(this.runs,name))}catch{unrestored.push(name)}
        if(unrestored.length)throw new Error('Could not finish clearing history or fully restore it. Recover '+unrestored.join(', ')+' from '+staging+'. '+String(e))
        if(existsSync(staging))rmdirSync(staging)
        if(existsSync(journalPath(this.settings)))unlinkSync(journalPath(this.settings))
        throw new Error('History was not cleared. '+(e instanceof Error?e.message:String(e)))
      }
      this.state={...next,warning:'History moved to Trash, but some history metadata could not be reset. Restart Local Lab. '+String(e)}
      writeFileSync(this.stateFile,JSON.stringify(this.state),{mode:0o600})
      return this.info()
    } finally {
      this.clearing=false
      if(committed)for(const fn of this.listeners)fn()
    }
  }
}
