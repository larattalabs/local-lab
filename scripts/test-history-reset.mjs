import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync, symlinkSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const require=createRequire(import.meta.url), {build}=createRequire(import.meta.resolve('vite'))('esbuild')
const root=mkdtempSync(join(tmpdir(),'history-reset-test-'))
try {
  await build({entryPoints:['src/main/history-reset.ts','src/renderer/lib/history-reset.ts'],outdir:root,bundle:true,platform:'node',format:'cjs',outExtension:{'.js':'.cjs'},logLevel:'silent'})
  const {HistoryReset,recoverHistory}=require(join(root,'main/history-reset.cjs'))
  const {syncHistoryDrafts}=require(join(root,'renderer/lib/history-reset.cjs'))
  const runs=join(root,'runs'),settings=join(root,'settings'),trash=join(root,'trash')
  for(const dir of ['image','video','chats','uploads','director','basic-plans','wan-cache','models'])mkdirSync(join(runs,dir),{recursive:true})
  writeFileSync(join(runs,'image','image.png'),'image');writeFileSync(join(runs,'video','movie.mp4'),'video');writeFileSync(join(runs,'chats','one.json'),'{}')
  writeFileSync(join(runs,'models','keep.safetensors'),'model');writeFileSync(join(runs,'keep.txt'),'unrelated')
  writeFileSync(join(runs,'wan-cache','encoding.npz'),'conditioning')
  const outside=join(root,'source.png');writeFileSync(outside,'training source');symlinkSync(outside,join(runs,'uploads','link.png'))
  let busy=false,fail=false,resets=0,events=0,blockTrash
  const dep={busy:()=>busy,trash:async path=>{if(fail)throw new Error('Trash unavailable');if(blockTrash)await blockTrash;renameSync(path,trash)},reset:()=>{resets++}}
  const service=new HistoryReset(runs,settings,dep);service.onChange(()=>events++)
  assert.equal(service.info().resetId,'initial')
  const name='Cleared history 2026-11-17T00-00-00Z abcdef12', resetId='12345678-1234-1234-1234-123456789abc'
  const journal=join(settings,'history-reset-journal.json')
  mkdirSync(settings,{recursive:true});mkdirSync(join(runs,name));renameSync(join(runs,'image'),join(runs,name,'image'))
  writeFileSync(journal,JSON.stringify({runs,name,resetId,phase:'staging'}))
  assert.equal(recoverHistory(runs,settings),false);assert(existsSync(join(runs,'image','image.png')))
  const recovery=join(root,'recovery');mkdirSync(recovery)
  writeFileSync(join(recovery,'history-reset-journal.json'),JSON.stringify({runs,name,resetId,phase:'trash'}))
  assert.equal(recoverHistory(runs,recovery),true);assert.equal(JSON.parse(readFileSync(join(recovery,'history-reset.json'))).resetId,resetId)
  let preview=service.preview();assert.equal(preview.images,2);assert.equal(preview.videos,1);assert.equal(preview.chats,1)
  await assert.rejects(service.clear({token:preview.token,confirmation:'clear'}),/type CLEAR/)
  busy=true;assert.equal(service.preview().busy,true);preview=service.preview();await assert.rejects(service.clear({token:preview.token,confirmation:'CLEAR'}),/Wait for generation/);busy=false
  let release;const active=service.access(()=>new Promise(r=>release=r));preview=service.preview();assert(preview.busy);await assert.rejects(service.clear({token:preview.token,confirmation:'CLEAR'}),/Wait for generation/);release();await active
  preview=service.preview();writeFileSync(join(runs,'image','new.png'),'new');await assert.rejects(service.clear({token:preview.token,confirmation:'CLEAR'}),/History changed/)
  fail=true;preview=service.preview();await assert.rejects(service.clear({token:preview.token,confirmation:'CLEAR'}),/History was not cleared/);assert(existsSync(join(runs,'image','image.png')));assert(existsSync(join(runs,'chats','one.json')));assert.equal(resets,0);assert.equal(service.info().resetId,'initial');assert(!readdirSync(runs).some(n=>n.startsWith('Cleared history')))
  fail=false;let finishTrash;blockTrash=new Promise(r=>finishTrash=r);preview=service.preview();const clearing=service.clear({token:preview.token,confirmation:'CLEAR'});await assert.rejects(service.access(()=>{}),/being cleared/);await assert.rejects(service.clear({token:preview.token,confirmation:'CLEAR'}));finishTrash();const result=await clearing
  assert.notEqual(result.resetId,'initial');assert.equal(resets,1);assert.equal(events,1);assert(existsSync(join(trash,'image','image.png')));assert(!existsSync(join(runs,'chats')));assert.equal(readFileSync(outside,'utf8'),'training source');assert(existsSync(join(runs,'models','keep.safetensors')));assert(existsSync(join(runs,'keep.txt')))
  assert.equal(new HistoryReset(runs,settings,dep).info().resetId,result.resetId)
  await service.access(()=>{mkdirSync(join(runs,'image'));writeFileSync(join(runs,'image','fresh.png'),'fresh')});assert.equal(service.preview().images,1)
  symlinkSync(join(runs,'models'),join(runs,'video'));assert.throws(()=>service.preview(),/symbolic link/)
  const data=new Map([['lab-preferences',JSON.stringify({selected:['model'],params:{steps:8},prompts:{image:'private draft'},images:['old.png'],activeChat:'old'})],['lab-basic-drafts','private'],['director-pending','old'],['director-choices','keep'],['lab-experience','advanced']])
  assert(existsSync(join(trash,'wan-cache','encoding.npz')))
  assert(!existsSync(join(runs,'wan-cache','encoding.npz')))
  const storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)}
  assert.equal(syncHistoryDrafts(storage,'initial'),false);assert(data.has('lab-basic-drafts'))
  assert.equal(syncHistoryDrafts(storage,result.resetId),true);assert.deepEqual(JSON.parse(data.get('lab-preferences')),{selected:['model'],params:{steps:8}});assert(!data.has('lab-basic-drafts'));assert(!data.has('director-pending'));assert.equal(data.get('director-choices'),'keep');assert.equal(data.get('lab-experience'),'advanced');assert.equal(syncHistoryDrafts(storage,result.resetId),false)
  data.set('lab-basic-drafts','stale sibling tab');assert(syncHistoryDrafts(storage,result.resetId,true));assert(!data.has('lab-basic-drafts'))
  data.delete('lab-history-reset');data.set('lab-basic-drafts','stale offline draft');assert(syncHistoryDrafts(storage,result.resetId));assert(!data.has('lab-basic-drafts'))
  console.log('History reset passed: explicit confirmation, busy-operation barrier, changed-history rejection, Trash failure rollback, concurrency exclusion, persistence, scoped removal, symlink safety, new output after reset, and offline-client draft cleanup.')
} finally { rmSync(root,{recursive:true,force:true}) }
