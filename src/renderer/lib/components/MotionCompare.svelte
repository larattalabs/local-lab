<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { motionPlan } from '@shared/media-plan'
  import type { MediaItem } from '@shared/studio'
  import type { SubmitTurn } from '@shared/types'
  import { lab,fileUrl } from '../api'
  import { store } from '../stores/lab.svelte'
  let { source,projectId,clips,onDismiss,onQueued }:{source:string; projectId?:string;clips:MediaItem[];onDismiss:()=>void;onQueued:()=>void}=$props()
  let dialog: HTMLDialogElement
  let ratio=$state(0), seconds=$state(2), prompt=$state(''), selected=$state<string[]>([]),busy=$state(false),error=$state('')
  let left=$state(''), right=$state(''), blind=$state(false), swapped=$state(false), position=$state(0)
  let playerA=$state<HTMLVideoElement>(),playerB=$state<HTMLVideoElement>()
  let duration=$state(0)
  const models=$derived(store.forModality('video').filter(m=>m.acceptsImages && store.isAvailable(m.id) && m.params.some(p=>p.key==='frames'&&p.options?.length)))
  const plans=$derived(models.filter(m=>selected.includes(m.id)).map(model=>({model,params:{...store.resolvedParams(model),...motionPlan(model,ratio||1,seconds,true)}})))
  const related=$derived(clips.filter(c=>c.source===source))
  const one=$derived(related.find(c=>c.id===(swapped?right:left)))
  const two=$derived(related.find(c=>c.id===(swapped?left:right)))
  let previousIntent='', pending:SubmitTurn|undefined
  onMount(()=>{dialog.showModal();left=related[0]?.id??'';right=related[1]?.id??''})
  function pick(id:string){selected=selected.includes(id)?selected.filter(v=>v!==id):[...selected,id].slice(0,4)}
  async function queue(){
    if(busy||plans.length<2||!ratio||!prompt.trim())return
    busy=true;error=''
    try{
      const params=Object.fromEntries(plans.map(p=>[p.model.id,p.params]))
      const request={modality:'video' as const,adapterIds:plans.map(p=>p.model.id),images:[source],prompt:prompt.trim(),params}
      const intent=JSON.stringify(request)
      if(!pending||intent!==previousIntent){
        const id=crypto.randomUUID()
        pending={turnId:crypto.randomUUID(),contextUsed:false,chat:{id,projectId:projectId?.startsWith('run:')?id:projectId,modality:'video',title:prompt.trim().slice(0,48),sourceImage:source,contextOn:false},request}
        previousIntent=intent
      }
      const result=await lab.submitTurn(pending)
      pending=undefined;store.acceptResult(result);onQueued()
    }catch(e){error=e instanceof Error?e.message:String(e)}finally{busy=false}
  }
  function pause(){playerA?.pause();playerB?.pause()}
  function loaded(){duration=Math.min(playerA?.duration||0,playerB?.duration||0);position=0}
  function seek(t:number){pause();position=Math.max(0,Math.min(duration||0,t));if(playerA)playerA.currentTime=position;if(playerB)playerB.currentTime=position}
  async function play(){if(!playerA||!playerB)return;if(!playerA.paused){pause();return}if(position>=duration-.04)seek(0);playerB.currentTime=playerA.currentTime;try{await Promise.all([playerA.play(),playerB.play()])}catch{pause();error='Could not play both clips. Try again after loading.'}}
  function sync(){if(!playerA||!playerB||playerA.paused)return;position=playerA.currentTime;if(position>=duration){seek(duration);return}if(Math.abs(position-playerB.currentTime)>.09)playerB.currentTime=position}
  async function toggleBlind(){pause();blind=!blind;swapped=blind&&Math.random()<.5;await tick();seek(0)}
</script>
<dialog class="motion-dialog" bind:this={dialog} oncancel={(e)=>{e.preventDefault();if(!busy)onDismiss()}}>
  <header><h2>Compare motion</h2><button disabled={busy} onclick={onDismiss}>Close</button></header>
  {#if source}<img style="height:68px;border-radius:6px" src={fileUrl(source)} alt="Shared starting frame" onload={e=>{const im=e.currentTarget as HTMLImageElement;ratio=im.naturalWidth/im.naturalHeight}}/>{/if}
  <label>Motion prompt<textarea style="display:block;width:100%" rows="2" bind:value={prompt} placeholder="The subject turns toward the camera as the water pours."></textarea></label>
  <label>Target duration <select bind:value={seconds}><option value={2}>2 seconds</option><option value={4}>4 seconds</option><option value={5}>5 seconds</option></select></label>
  {#each models as m}<label><input type="checkbox" checked={selected.includes(m.id)} disabled={!selected.includes(m.id)&&selected.length>=4} onchange={()=>pick(m.id)}/> {m.label}</label>{/each}
  {#each plans as p}<p>{p.model.label} · {p.params.resolution} · {p.params.frames} frames · {p.model.frameRate??24} FPS · {(Number(p.params.frames)/(p.model.frameRate??24)).toFixed(2)} s</p>{/each}
  <button class="primary" disabled={busy||plans.length<2||!ratio||!prompt.trim()} onclick={queue}>{busy?'Queuing…':'Queue comparison'}</button>
  {#if related.length>=2}
    <h3>Compare finished clips</h3>
    {#if !blind}{#each ['A','B'] as side}<label>Clip {side} <select value={side==='A'?left:right} onchange={e=>{pause();if(side==='A')left=e.currentTarget.value;else right=e.currentTarget.value}}>
      {#each related as c,index}<option value={c.id} disabled={side==='A'?c.id===right:c.id===left}>{c.message.adapterLabel} · take {index+1}</option>{/each}</select></label>{/each}{/if}
    <button onclick={toggleBlind}>{blind?'Reveal models':'Blind A/B'}</button>
    {#if one&&two}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <figure><figcaption>{blind?'A':one.message.adapterLabel}</figcaption><video bind:this={playerA} src={fileUrl(one.message.outputPath!)} playsinline muted preload="metadata" onloadedmetadata={loaded} ontimeupdate={sync} onended={pause}></video></figure>
        <figure><figcaption>{blind?'B':two.message.adapterLabel}</figcaption><video bind:this={playerB} src={fileUrl(two.message.outputPath!)} playsinline muted preload="metadata" onloadedmetadata={loaded} onended={pause}></video></figure>
      </div>
      <input type="range" aria-label="Shared playback time" min="0" max={duration||0} step=".001" value={position} oninput={e=>seek(Number(e.currentTarget.value))}/>
      <button onclick={()=>seek(position-1/(one?.message.details?.fps??24))}>−1 frame</button><button onclick={play}>Play / pause</button><button onclick={()=>seek(position+1/(one?.message.details?.fps??24))}>+1 frame</button>
      {#if !blind}{#each [one,two] as c}<details><summary>{c.message.adapterLabel} · run details</summary><p>{c.message.effectivePrompt}</p><pre>{JSON.stringify(c.message.details??c.message.requestSnapshot?.params,null,2)}</pre><p>{c.message.durationMs?Math.round(c.message.durationMs/1000)+' s to generate':''}</p></details>{/each}{/if}
    {/if}
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
</dialog>
