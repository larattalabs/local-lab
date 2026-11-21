<script lang="ts">
  import { Maximize2, X, Columns2, ChevronLeft, ChevronRight } from '@lucide/svelte'
  import type { MediaItem } from '@shared/studio'
  import { fileUrl } from '../api'
  let { item, items, onSelect }: { item:MediaItem;items:MediaItem[];onSelect:(item:MediaItem)=>void }=$props()
  let full=$state(false), dialog=$state<HTMLDialogElement>(), compare=$state(false), before=$state(''), split=$state(50), failed=$state(false)
  const done=$derived(items.filter((i)=>i.message.state==='done'&&i.message.outputPath))
  const index=$derived(done.findIndex((i)=>i.id===item.id))
  const candidates=$derived(done.filter((i)=>i.modality==='image'&&i.id!==item.id))
  const original=$derived(before||item.source||done.slice(0,index).filter(i=>i.modality==='image').at(-1)?.message.outputPath||candidates[0]?.message.outputPath)
  const canCompare=$derived(item.modality==='image'&&!!(item.source||candidates.length))
  $effect(()=>{void item.id;compare=false;before='';split=50;failed=false})
  $effect(()=>{if(full&&dialog&&!dialog.open)dialog.showModal()})
  function step(direction:number){const next=done[index+direction];if(next)onSelect(next)}
  let touchX=0,touchY=0,sliding=false
</script>
<div class="media-viewer">
  <div class="viewer-tools"><span>{item.modality==='video'?'Video':'Image'} · {index>=0?`Version ${index+1}`:'Preview'}</span><div>{#if canCompare}<button class="studio-button quiet" aria-pressed={compare} onclick={()=>compare=!compare}><Columns2 size={16}/>Compare</button>{/if}<button class="studio-icon" aria-label="Open fullscreen viewer" onclick={()=>full=true}><Maximize2 size={18}/></button></div></div>
  {#if !full}{@render canvas(false)}{:else}<div class="media-canvas"></div>{/if}
  {#if compare&&canCompare}{@render comparisonControls()}{/if}
</div>
{#if full}
  <dialog class="media-dialog" aria-label="Fullscreen media viewer" bind:this={dialog} oncancel={()=>full=false} onkeydown={(e)=>{if(['INPUT','SELECT','TEXTAREA'].includes((e.target as HTMLElement).tagName))return;if(e.key==='ArrowLeft')step(-1);if(e.key==='ArrowRight')step(1)}}>
    <header><span>{item.title} · Version {index+1}</span><div>{#if canCompare}<button class="studio-button" aria-pressed={compare} onclick={()=>compare=!compare}><Columns2 size={16}/>Compare</button>{/if}<button class="studio-icon" aria-label="Close fullscreen viewer" onclick={()=>full=false}><X size={22}/></button></div></header>
    {@render canvas(true)}
    {#if compare&&canCompare}{@render comparisonControls()}{/if}
    <footer><button class="studio-button" disabled={index<=0} onclick={()=>step(-1)}><ChevronLeft size={18}/>Previous</button><span>{index+1} of {done.length}</span><button class="studio-button" disabled={index>=done.length-1} onclick={()=>step(1)}>Next<ChevronRight size={18}/></button></footer>
  </dialog>
{/if}
{#snippet canvas(expanded:boolean)}
  <div class:expanded class="media-canvas" role="group" aria-label="Media preview" ontouchstart={(e)=>{touchX=e.touches[0].clientX;touchY=e.touches[0].clientY;sliding=(e.target as HTMLElement).tagName==='INPUT'}} ontouchend={(e)=>{if(!expanded||sliding||compare||item.modality==='video')return;const dx=e.changedTouches[0].clientX-touchX,dy=e.changedTouches[0].clientY-touchY;if(Math.abs(dx)>70&&Math.abs(dx)>Math.abs(dy)*1.5)step(dx<0?1:-1)}}>
    {#if failed}<div class="viewer-empty"><p>This file is no longer available.</p><span>Other versions and your prompt are still saved.</span></div>
    {:else if item.message.outputPath}
      {#if item.modality==='video'}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video src={fileUrl(item.message.outputPath)} controls playsinline preload="metadata" poster={item.source?fileUrl(item.source):undefined} onerror={()=>failed=true}></video>
      {:else}
        <img class="result-image" src={fileUrl(item.message.outputPath)} alt={item.message.effectivePrompt||'Generated result'} onerror={()=>failed=true}/>
        {#if compare&&canCompare&&original}
          <div class="compare-original" style={`clip-path:inset(0 ${100-split}% 0 0)`}><img src={fileUrl(original)} alt="Before comparison"/></div>
          <div class="compare-divider" style={`left:${split}%`}></div><span class="compare-label before">Before</span><span class="compare-label after">After</span>
        {/if}
      {/if}
    {/if}
  </div>
{/snippet}
{#snippet comparisonControls()}
  <div class="compare-controls"><label>Before<select aria-label="Compare against" value={before} onchange={(e)=>before=e.currentTarget.value}><option value="">{item.source?'Source image':index===0?'Next image':'Previous image'}</option>{#each candidates as c}<option value={c.message.outputPath}>Version {done.findIndex((i)=>i.id===c.id)+1}</option>{/each}</select></label><label class="comparison-slider">Reveal original<input type="range" min="0" max="100" step="1" bind:value={split} aria-label="Before and after comparison position"/></label></div>
{/snippet}
