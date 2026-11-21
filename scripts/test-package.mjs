import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { X509Certificate } from 'node:crypto'
import tls from 'node:tls'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import https from 'node:https'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

const bundle=resolve(process.argv[2] || 'release/mac-arm64/Local Lab.app')
const root=mkdtempSync(join(tmpdir(),'local-lab-packaged-'))
const userData=join(root,'settings'), runs=join(root,'runs')
const port=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const n=s.address().port;s.close(()=>resolve(n))})})
const cdp=await port(), phone=await port()
const child=spawn(join(bundle,'Contents/MacOS/Local Lab'),['--user-data-dir='+userData],{stdio:'ignore',
  env:{...process.env,LOCALLAB_RUNS_DIR:runs,LOCALLAB_AI_ROOT:join(root,'models'),LOCALLAB_CDP:String(cdp),LOCALLAB_SMOKE_PORT:String(phone)}})
let socket
try {
  let target
  for(let i=0;i<160&&!target;i++){
    if(child.exitCode!==null)throw Error('Packaged app exited during startup.')
    try {target=(await (await fetch('http://127.0.0.1:'+cdp+'/json/list')).json()).find(t=>t.url.includes('/renderer/index.html'))}catch{}
    if(!target)await delay(125)
  }
  assert(target,'Packaged renderer did not load')
  socket=new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j})
  async function evaluate(expression){
    const response=new Promise((r,j)=>{socket.onmessage=e=>{const msg=JSON.parse(e.data);if(msg.id===1){if(msg.result.exceptionDetails)j(Error(msg.result.exceptionDetails.exception?.description||'Renderer exception'));else r(msg.result.result.value)}}})
    socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}))
    return response
  }
  // The renderer target can appear before the preload has exposed its API (seen on slower CI runners).
  for(let i=0;i<160&&!(await evaluate('typeof window.lab==="object"&&document.readyState!=="loading"'));i++)await delay(125)
  assert.equal(await evaluate('typeof window.lab'),'object','Packaged preload did not expose window.lab within 20 s')
  assert.equal(await evaluate('window.lab.runsDir()'),runs)
  assert.equal((await evaluate('window.lab.historyState()')).resetId,'initial')
  const status=await evaluate('window.lab.phoneEnable()')
  assert(status.enabled, status.error)
  const ca=readFileSync(join(userData,'phone/ca.pem'))
  // On a TLS failure, report which certificate the server presented versus the CA the test trusted.
  const diagnose=e=>new Promise(r=>{const s=tls.connect({host:'127.0.0.1',port:phone,servername:'localhost',rejectUnauthorized:false},()=>{
    const peer=s.getPeerX509Certificate(),trusted=new X509Certificate(ca)
    e.message+=`\nserved: subject=${peer?.subject} issuer=${peer?.issuer} checkIssued=${peer?.checkIssued(trusted)} verify=${peer?.verify(trusted.publicKey)}`
      +`\ntrusted CA: subject=${trusted.subject} fp=${trusted.fingerprint256}\napp CA fp: ${status.fingerprint}\nphone dir: ${readdirSync(join(userData,'phone')).join(' ')}`
    s.end();r(e)});s.on('error',x=>{e.message+='\ndiagnostic connect failed: '+x.message;r(e)})})
  const get=path=>new Promise((r,j)=>https.get({host:'127.0.0.1',port:phone,servername:'localhost',path,ca},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>{try{assert.equal(res.statusCode,200);r(body)}catch(e){j(e)}})}).on('error',e=>diagnose(e).then(j,j)))
  const html=await get('/')
  const entry=html.match(/src="([^"]+\.js)"/)?.[1];assert(entry)
  assert((await get(new URL(entry,'https://localhost/').pathname)).includes('Compare motion'))
  assert(statSync(join(bundle,'Contents/Resources/workers/qwen_full_native.py')).size>0)
  assert(statSync(join(bundle,'Contents/Resources/workers/omlx_chat.sh')).size>0)
  await evaluate('window.lab.phoneDisable()')
  console.log('Packaged Mac preload, isolated history, HTTPS phone bundle and external workers passed.')
} finally {
  socket?.close()
  if(child.exitCode===null){const ended=new Promise(r=>child.once('exit',r));child.kill();await ended}
  rmSync(root,{recursive:true,force:true})
}
