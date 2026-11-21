// Three sequential requests per engine lifetime. Runs stay outside the source checkout.
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const root = resolve('.'), buildDir = mkdtempSync(join(tmpdir(),'lab-bench-'))
const dest = join(homedir(),'AI/local-lab-benchmarks','studio-warm-'+Date.now())
mkdirSync(dest,{recursive:true})
const {build} = createRequire(import.meta.resolve('vite'))('esbuild')
await build({entryPoints:['src/main/registry/image-stack.ts','src/main/registry/video-stack.ts'],outdir:buildDir,bundle:true,platform:'node',format:'esm',outExtension:{'.js':'.mjs'}})
const {imageStackAdapters} = await import(pathToFileURL(join(buildDir,'image-stack.mjs')))
const {videoStackAdapters} = await import(pathToFileURL(join(buildDir,'video-stack.mjs')))
const picture = imageStackAdapters.find(a=>a.id==='qwen-image-2.1-turbo'), movie=videoStackAdapters.find(a=>a.id==='ltx-2.5')
async function run(spec, name) {
 const start=performance.now()
 const child=spawn(spec.bin,spec.args,{timeout:600000,env:{...process.env,HF_HUB_OFFLINE:'1',...spec.env}})
 let output='', loadStart, loadMs
 const receive=chunk=>{
   const text=chunk.toString()
   output+=text
   if(text.includes('[gen] loading image engine:')) loadStart=performance.now()
   if(loadStart!==undefined && /\[registry\] model id=.* ready/.test(text)) loadMs=performance.now()-loadStart
 }
 child.stdout.on('data',receive);child.stderr.on('data',receive)
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)})
 writeFileSync(join(dest,name+'.log'),output)
 if(code!==0) throw new Error(name+' failed. See '+dest)
 if(name!=='handoff') {
   results[name+'StagesMs']=Array.from(output.matchAll(/stages: prompt (\d+) ms, denoise (\d+) ms .*?vae decode (\d+) ms/g),
     ([,encode,denoise,decode])=>({encode:+encode,denoise:+denoise,decode:+decode}))
   results[name+'ObservedModelLoadMs']=loadMs
   const meta=JSON.parse(readFileSync(join(dest,name+'.json')))
   results[name+'ServerReadyMs']=meta.server_ready_seconds*1000
   try { process.kill(meta.server_pid,0);throw new Error('Image engine still resident before the next model.') }
   catch(error) { if(error.code!=='ESRCH')throw error }
 }
 return (performance.now()-start)/1000
}
const prompt='A blue ceramic cup on a wooden table with a hanging linen curtain. Natural light.'
const ctx={prompt,params:{seed:871,image_engine:'mlx-serve-int8'},images:[]}
console.log(dest)
const results={}
for (const [name,count] of [['cold',1],['batch',3]]) {
 const outPath=join(dest,name+'.png'), spec=picture.build({...ctx,outPath})
 spec.args[0]=join(root,'resources/workers/qwen_full_native.py')
 spec.args.push('--benchmark-count',String(count))
 results[name]=await run(spec,name)
 results[name+'Requests']=Array.from({length:count},(_,i)=>JSON.parse(readFileSync(join(dest,name+(i?'-'+(i+1):'')+'.json'))).request_seconds)
 console.log(name,results[name],results[name+'Requests'])
}
const outPath=join(dest,'handoff.mp4')
results.handoff=await run(movie.build({outPath,prompt:'The linen curtain sways gently behind the stationary cup.',images:[join(dest,'batch-3.png')],params:{resolution:'512x512',frames:'49',stage1_steps:'4',no_audio:true}}),'handoff')
if(!existsSync(outPath))throw new Error('No handoff video')
writeFileSync(join(dest,'results.json'),JSON.stringify(results,null,2))
console.log(results)
