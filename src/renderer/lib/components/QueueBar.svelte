<script lang="ts">
  import { ChevronUp, X } from '@lucide/svelte'
  import { lab, isWeb } from '../api'
  import { store } from '../stores/lab.svelte'
  import { basicFlow } from '../stores/basic.svelte'
  import { reportedProgress } from '@shared/studio'
  const running=$derived(store.running), queued=$derived(store.queuedCount)
  const work=$derived(store.jobs.filter((j)=>['queued','running'].includes(j.state)).sort((a,b)=>a.queuedAt-b.queuedAt))
  let tick=$state(0),open=$state(false)
  $effect(()=>{if(!running)return;const t=setInterval(()=>tick++,1000);return()=>clearInterval(t)})
  const elapsed=$derived(tick>=0&&running?.startedAt?Math.round((Date.now()-running.startedAt)/1000):0)
  const phase=$derived(running?reportedProgress(running):undefined)
</script>
<footer class="studio-queue">
  {#if running}<span class="queue-dot working"></span><span class="queue-stage">{phase?.label}{#if phase?.total} · step {phase.step}/{phase.total}{/if}</span><span class="queue-time">{elapsed}s</span>{#if running.adapterId!=='desktop-only'}<button class="queue-cancel" onclick={()=>lab.cancel(running.id)}>Cancel</button>{/if}
  {:else}<span class="queue-dot"></span><span class="queue-stage">{isWeb?'Mac ready':'Ready'}</span>{/if}
  {#if queued}<span class="queue-time">{queued} queued</span>{/if}
  <div class="queue-spacer"></div>
  {#if work.length}<button class="queue-expand" aria-expanded={open} onclick={()=>open=!open}>Queue<ChevronUp size={15}/></button>{:else if basicFlow.mode==='advanced'}<button onclick={()=>{void lab.clearFinished();store.jobs=store.jobs.filter((j)=>['running','queued'].includes(j.state))}}>Clear finished</button>{/if}
  {#if open&&work.length}<div class="queue-list"><header><strong>On your Mac</strong><button aria-label="Close queue" onclick={()=>open=false}><X size={18}/></button></header>{#each work as j}<div><span>{j.kind==='director'?'Prompt assistant':j.adapterLabel}<small>{reportedProgress(j).label}</small></span>{#if j.adapterId!=='desktop-only'}<button onclick={()=>lab.cancel(j.id)}>Cancel</button>{/if}</div>{/each}</div>{/if}
</footer>
<style>.studio-queue{position:relative;display:flex;align-items:center;gap:10px;min-height:32px;flex-shrink:0;border-top:1px solid #292f38;padding:5px 16px;background:#0d1014;font-size:12px;color:#a9b2c0}.queue-dot{height:6px;width:6px;border-radius:50%;background:#758874;flex-shrink:0}.queue-dot.working{background:#d8a657}.queue-spacer{flex:1}.queue-stage{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.queue-time{font-size:11px;color:#939eae;flex-shrink:0;font-variant-numeric:tabular-nums}button{font-size:12px;min-height:24px;color:#d8b782}.queue-cancel{color:#e1aaa1}.queue-expand{display:flex;align-items:center;gap:5px}.queue-list{position:absolute;right:12px;bottom:calc(100% + 8px);width:360px;max-width:calc(100vw - 24px);max-height:45vh;overflow:auto;border:1px solid #3e4856;border-radius:13px;background:#1c222b;box-shadow:0 8px 48px #0008;padding:14px;z-index:50}.queue-list header,.queue-list>div{display:flex;align-items:center;justify-content:space-between;gap:12px}.queue-list header{margin-bottom:12px}.queue-list strong{font-weight:500;color:#eef0f4;font-size:14px}.queue-list>div{padding:9px 0;border-top:1px solid #333d49;color:#e2e6ed}.queue-list small{display:block;font-size:11px;color:#a7b1c0;margin-top:4px}@media(max-width:800px){.studio-queue{padding:3px 12px;gap:8px;font-size:11px;min-height:30px}.studio-queue button{min-height:30px;font-size:11px}.queue-list button{min-height:40px}.queue-stage{max-width:55vw}}</style>
