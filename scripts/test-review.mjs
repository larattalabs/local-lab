import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const require = createRequire(import.meta.url)
const { build } = createRequire(import.meta.resolve('vite'))('esbuild')
const root = mkdtempSync(join(tmpdir(),'studio-regressions-'))
try {
  process.env.LOCALLAB_RUNS_DIR = join(root,'runs')
  const entryPoints = ['src/main/runner.ts','src/main/director/service.ts','src/shared/studio.ts','src/shared/media-plan.ts']
  await build({entryPoints, outdir:root, platform:'node', bundle:true, format:'cjs', outExtension:{'.js':'.cjs'},
    plugins:[{name:'fixture',setup(b){
      b.onResolve({filter:/^\.\/registry$/},a=>a.importer.endsWith('runner.ts')?{path:'registry',namespace:'fixture'}:undefined)
      b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`exports.byId=id=>({id,label:id,params:[],outputExt:'png',build:({outPath})=>({bin:process.execPath,args:['-e',id==='missing'?'':"require('fs').writeFileSync(process.argv[1],"+(id==='empty'?"''":"'media'")+")",outPath]})})`}))
    }}]})
  const {Runner}=require(join(root,'main/runner.cjs'))
  const {Director}=require(join(root,'main/director/service.cjs'))
  const {studioProjects}=require(join(root,'shared/studio.cjs'))
  const {motionPlan,editTarget}=require(join(root,'shared/media-plan.cjs'))
  const settings=join(root,'settings');mkdirSync(settings)
  writeFileSync(join(settings,'director-warm-models.json'),JSON.stringify(['fixture']))
  const runner=new Runner()
  new Director(settings,process.env.LOCALLAB_RUNS_DIR,runner,{
    fetch:async()=>{throw new TypeError('fetch failed',{cause:Object.assign(new Error('offline'),{code:'ECONNREFUSED'})})},
    adapters:()=>[],chats:()=>[],submit:()=>{} })
  const wait=Promise.withResolvers()
  const terminal=[]
  runner.onUpdate(j=>{if(['done','error'].includes(j.state)){ terminal.push([j.adapterId,j.state,j.error]);if(terminal.length===3)wait.resolve() }})
  runner.enqueue({modality:'image',adapterIds:['missing','empty','ok'],prompt:'fixture',params:{}})
  await wait.promise
  assert.deepEqual(terminal.map(x=>x.slice(0,2)),[['missing','error'],['empty','error'],['ok','done']])
  assert.match(terminal[0][2],/output file/)
  const chats=['a','b'].map((id,i)=>({id,projectId:id,title:id,modality:'image',createdAt:i,updatedAt:i,messages:[{id,role:'gen',at:i,outputPath:id+'.png',images:i?['a.png']:[]}]}))
  assert.equal(studioProjects(chats,[],[],{}).length,2)
  assert.equal(studioProjects(chats.map(({projectId,...c})=>c),[],[],{}).length,1)
  const select=(key,values)=>({key,options:values.map(value=>({value}))})
  const model={id:'wan',frameRate:16,params:[select('frames',['33','49','81']),select('resolution',['512x512','768x448','448x768'])]}
  for(const [ratio,size] of [[1,'512x512'],[2,'768x448'],[0.5,'448x768']])assert.deepEqual(motionPlan(model,ratio,3,true),{frames:'49',resolution:size})
  assert.equal(editTarget({id:'h3',acceptsImages:true}),'h3')
  const rows=Array.from({length:1000},(_,i)=>({...chats[0],id:'c'+i,projectId:'p'+Math.floor(i/5),messages:[{id:'m'+i,at:i,role:'gen',outputPath:i+'.png'}]}))
  const start=performance.now();assert.equal(studioProjects(rows,[],[],{}).length,200)
  console.log('Studio regressions passed. Projected 1,000 results in '+(performance.now()-start).toFixed(1)+' ms.')
} finally { rmSync(root,{recursive:true,force:true}) }
