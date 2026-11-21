import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
const require=createRequire(import.meta.url),{build}=createRequire(import.meta.resolve('vite'))('esbuild')
const root=realpathSync(mkdtempSync(join(tmpdir(),'studio-tests-')))
try{
  await build({entryPoints:['src/shared/studio.ts','src/main/studio/service.ts','src/main/phone/assets.ts'],outdir:root,bundle:true,platform:'node',format:'cjs',outExtension:{'.js':'.cjs'},logLevel:'silent'})
  const {studioProjects,reportedProgress,durationEstimate}=require(join(root,'shared/studio.cjs'))
  const {StudioService}=require(join(root,'main/studio/service.cjs'))
  const {Assets}=require(join(root,'main/phone/assets.cjs'))
  const msg=(id,path,source,at=1)=>({id,at,role:'gen',state:'done',outputPath:path,images:source?[source]:[],adapterId:'image',requestSnapshot:{adapterIds:['image'],params:{image:{steps:8,seed:1}},prompt:'A portrait'},durationMs:30000})
  const chats=[{id:'a',modality:'image',title:'Portrait',createdAt:1,updatedAt:2,messages:[msg('m1','/first.png'),msg('m2','/edited.png','/first.png',2)]},{id:'b',modality:'video',title:'Motion',createdAt:3,updatedAt:4,sourceImage:'/edited.png',messages:[msg('m3','/motion.mp4','/edited.png',3)]},{id:'c',modality:'image',title:'Independent',createdAt:5,updatedAt:6,messages:[msg('m4','/other.png',undefined,5)]}]
  const original=JSON.stringify(chats)
  let projects=studioProjects(chats,[],[],{})
  assert.equal(projects.length,2);assert.equal(projects.find(p=>p.id==='a').items.length,3);assert.equal(JSON.stringify(chats),original,'Grouping never rewrites old chats')
  projects=studioProjects([...chats].reverse(),[],[],{a:'Garden project'});assert.equal(projects.find(p=>p.id==='a').title,'Garden project');assert.deepEqual(projects.find(p=>p.id==='a').items.map(i=>i.id),['m1','m2','m3'])
  const live={id:'live',state:'running',adapterId:'image',log:'',params:{}};const inFlight=structuredClone(chats);inFlight[0].messages.push({id:'new',jobId:'live',role:'gen',at:10,state:'queued'})
  assert.equal(studioProjects(inFlight,[],[live],{}).find(p=>p.id==='a').items.at(-1).message.state,'running')
  const record={dir:'/run',modality:'image',prompt:'Orphan',adapterLabel:'Image',adapterId:'image',outputPath:'/orphan.png',state:'done',queuedAt:7,params:{}}
  assert.equal(studioProjects(chats,[record],[],{}).length,3)
  assert.equal(studioProjects(chats,[{...record,outputPath:'/first.png'}],[],{}).length,2)
  assert.equal(reportedProgress({...live,state:'queued'}).label,'Waiting in queue')
  assert.equal(reportedProgress({...live,kind:'director'}).label,'Preparing your prompt')
  assert.equal(reportedProgress({...live,log:'$ tool "Decoding the image is part of the prompt"'}).label,'Working on your image')
  assert.deepEqual(reportedProgress({...live,log:'Loading model weights\nDenoising: 4/8\rDenoising: 5/8'}),{label:'Generating',step:5,total:8})
  assert.equal(reportedProgress({...live,log:'Denoising: 8/8\nDecoding video frames'}).label,'Finishing the media')
  assert.equal(reportedProgress({...live,log:'Downloading: 8/8'}).total,undefined,'Download counts are not sampling progress')
  assert.equal(reportedProgress({...live,log:'Qwen INT8: 8 steps, seed 42'}).label,'Generating')
  assert.equal(durationEstimate('image',{steps:8,seed:999},projects.flatMap(p=>p.items)).startsWith('Usually'),true)
  assert.equal(durationEstimate('image',{steps:40},projects.flatMap(p=>p.items)),undefined,'Different quality profiles must not share estimates')
  assert.equal(durationEstimate('image',{steps:8},[{...projects[0].items[0],at:1,message:{...projects[0].items[0].message,durationMs:80000}},{...projects[0].items[0],at:2,message:{...projects[0].items[0].message,durationMs:20000}}]),'Last run 20s')
  const runs=join(root,'runs');mkdirSync(runs);const image=join(runs,'image.png');writeFileSync(image,'image');const outside=join(root,'outside.png');writeFileSync(outside,'private');symlinkSync(outside,join(runs,'escape.png'))
  const settings=join(root,'settings');let service=new StudioService(settings,runs),events=0;service.onChange(()=>events++)
  service.update({kind:'favorite',path:image,value:true});service.update({kind:'favorite',path:image,value:true});assert.deepEqual(service.info().favorites,[image])
  service.update({kind:'title',id:'a',title:'Garden project'});service.update({kind:'presetFavorite',id:'natural',value:true});service.update({kind:'subjectImage',id:'character',thumbnail:image});assert.equal(events,5)
  assert.throws(()=>service.update({kind:'favorite',path:join(runs,'escape.png'),value:true}),/media in the library/)
  assert.throws(()=>service.update({kind:'title',id:'__proto__',title:'bad'}),/project name/)
  assert.throws(()=>service.update({kind:'favorite',path:image,value:'true'}),/Invalid favorite/)
  service=new StudioService(settings,runs);assert.equal(service.info().titles.a,'Garden project');assert.equal(service.info().subjectImages[0].thumbnail,image)
  const assets=new Assets(runs,'test-secret'),wire=assets.wire(service.info());assert.equal(assets.path(wire.favorites[0]),image);assert.equal(assets.path(wire.subjectImages[0].thumbnail),image)
  service.update({kind:'favorite',path:image,value:false});assert.equal(service.info().favorites.length,0);assert.equal(service.info().titles.a,'Garden project')
  console.log('Studio passed: non-destructive source-linked projects, stable version order, legacy media, live jobs, honest progress, profile-specific estimates, durable favorites/portraits/names, signed phone assets and path validation.')
}finally{rmSync(root,{recursive:true,force:true})}
