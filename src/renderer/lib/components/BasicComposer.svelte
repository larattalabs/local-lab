<script lang="ts">
  import { motionPlan } from '@shared/media-plan'
  import { SlidersHorizontal, UserRound, Sparkles, Paperclip, ArrowUp, X, Pin, Heart, Check, Pencil, Clapperboard, ImagePlus, Expand, RefreshCw } from '@lucide/svelte'
  import type { Modality } from '@shared/types'
  import { BASIC_STYLES, presetControls } from '@shared/basic'
  import { basicFlow as basic } from '../stores/basic.svelte'
  import { studio } from '../stores/studio.svelte'
  import { store } from '../stores/lab.svelte'
  import { lab, fileUrl } from '../api'
  import ModelSettings from './ModelSettings.svelte'
  import PresetEditor from './PresetEditor.svelte'
  import ModifierEditor from './ModifierEditor.svelte'
  import type { ModifierKind } from '@shared/modifiers'
  import DirectorEditor from './DirectorEditor.svelte'
  let { modality }: { modality: Modality } = $props()
  const d=$derived(basic.draft(modality))
  const preset=$derived(basic.catalog.presets.find((p)=>p.id===d.presetId))
  const adapter=$derived(store.adapters.find((a)=>a.id===preset?.adapterId))
  const adult=$derived(d.presetId==='adult'||preset?.director==='adult')
  const mood=$derived(basic.catalog.modifiers.moods.find((p)=>p.id===d.mood))
  const intensity=$derived(basic.catalog.modifiers.intensities.find((p)=>p.id===(d.intensity??'low')))
  const style=$derived(BASIC_STYLES.find((s)=>s.id===d.presetId))
  const subject=$derived(basic.catalog.subjects.find((s)=>s.id===d.subject))
  const sourceProject=$derived(studio.projects.find(p=>p.items.some(i=>i.message.outputPath===d.sourceImage)))
  const sourceVersion=$derived(sourceProject ? 1+sourceProject.items.findIndex(i=>i.message.outputPath===d.sourceImage) : 0)
  const modelId=$derived(preset?.adapterId ?? (d.workflow==='animate'?basic.catalog.models.video:d.workflow==='upscale'?'seedvr2':basic.catalog.models[d.quality]))
  const model=$derived(store.adapters.find(a=>a.id===modelId))
  const effectiveModel=$derived(d.workflow==='edit' && !preset ? store.adapters.find(a=>a.id===(model?.imageEditAdapterId??modelId)) : model)
  const motion=$derived(d.workflow==='animate' && model ? motionPlan(model,d.matchSource!==false && d.sourceRatio ? d.sourceRatio : Number(d.aspect.split(':')[0])/Number(d.aspect.split(':')[1]),Number(d.duration)/24,d.quality==='fast') : undefined)
  const requiresImage=$derived(d.workflow!=='create')
  const valid=$derived(!basic.busy&&!(d.workflow==='animate' && d.matchSource!==false && !d.sourceRatio)&&(d.workflow==='upscale'||!!d.prompt.trim())&&(!requiresImage||!!d.sourceImage))
  const presets=$derived(basic.catalog.presets.filter((p)=>(p.workflow==='animate')===(modality==='video')).sort((a,b)=>Number(studio.data.presetFavorites.includes(b.id))-Number(studio.data.presetFavorites.includes(a.id))))
  let panel=$state<'style'|'subject'|'settings'|'presets'|null>(null), dialog=$state<HTMLDialogElement>()
  let editor=$state(false), directorEditor=$state(false), modifierEditor=$state<ModifierKind|null>(null)
  $effect(()=>{if(panel&&dialog&&!dialog.open)dialog.showModal()})
  const subjectImage=(id:string)=>studio.data.subjectImages.find((s)=>s.id===id)?.thumbnail??studio.items.find((i)=>i.modality==='image'&&i.message.state==='done'&&i.message.requestSnapshot?.basic?.subject===id)?.message.outputPath
  const styleImage=(id:string)=>studio.items.find((i)=>i.modality==='image'&&i.message.state==='done'&&i.message.requestSnapshot?.basic?.presetId===id)?.message.outputPath
  async function attach(){try{const paths=await lab.pickImages();if(paths[0])basic.source(modality,paths[0],d.workflow==='create'?'edit':d.workflow)}catch(e){basic.error=String(e)}}
  async function portrait(id:string){try{const paths=await lab.pickImages();if(paths[0])await studio.update({kind:'subjectImage',id,thumbnail:paths[0]})}catch(e){basic.error=String(e)}}
  const action=$derived(d.workflow==='animate'?'Create video':d.workflow==='edit'?'Apply edit':d.workflow==='upscale'?'Upscale image':'Create image')
</script>
<div class="studio-composer">
  {#if requiresImage}
    <div class="source-ribbon">
      {#if d.sourceImage}<img src={fileUrl(d.sourceImage)} onload={(e)=>{const im=e.currentTarget as HTMLImageElement; if(d.workflow==='animate' && d.sourceRatio!==im.naturalWidth/im.naturalHeight) basic.update(modality,{sourceRatio:im.naturalWidth/im.naturalHeight,matchSource:d.matchSource??true})}} alt="Pinned source" />{:else}<Paperclip size={18}/>{/if}
      <div><strong>{d.sourceImage?sourceVersion?(d.workflow==='animate'?'Animate':'Edit')+' version '+sourceVersion:d.workflow==='animate'?'Starting frame pinned':'Source image pinned':'Choose a source image'}</strong><span>{d.sourceImage?'This exact image will be used.':'Attach a photo or choose a result.'}</span></div>
      <button class="studio-button quiet" onclick={attach} disabled={basic.busy}>{d.sourceImage?'Change':'Attach'}</button>
      {#if d.sourceImage}<button class="studio-icon" aria-label="Remove pinned source" disabled={basic.busy} onclick={()=>basic.update(modality,{sourceImage:undefined})}><X size={17}/></button>{/if}
    </div>
  {/if}
  <div class="recipe-line">{effectiveModel?.label??modelId}{#if motion?.resolution} · {String(preset?.params.resolution??motion.resolution).replace('x','×')}{/if}{#if d.sourceImage && requiresImage} · Reference image{/if}{#if subject && !preset && ['create','edit'].includes(d.workflow)} · {subject.label} adapter{/if}{#if preset?.params.lora} · {String(preset.params.lora)} adapter{/if}</div>
  <div class="prompt-surface">
    <div class="prompt-heading">
      {#if modality==='image'}<select class="workflow-select" aria-label="Image workflow" value={d.workflow} disabled={basic.busy} onchange={(e)=>basic.workflow(modality,e.currentTarget.value as 'create'|'edit'|'upscale')}><option value="create">Create image</option><option value="edit">Edit image</option><option value="upscale">Upscale image</option></select>{:else}<span><Clapperboard size={15}/> Animate an image</span>{/if}
      <button class="studio-icon" aria-label="Attach source image" onclick={attach} disabled={basic.busy}><Paperclip size={17}/></button>
    </div>
    {#if d.workflow!=='upscale'}
      <textarea aria-label={d.workflow==='edit'?'What would you like to change?':d.workflow==='animate'?'What should happen next?':'What would you like to create?'} value={d.prompt} disabled={basic.busy} rows="2" placeholder={d.workflow==='edit'?'Change the cardigan to deep blue. Keep everything else…':d.workflow==='animate'?'A gentle turn, a smile, a breeze through her hair…':'Describe a moment, a look, or a place…'} oninput={(e)=>basic.update(modality,{prompt:e.currentTarget.value})} onkeydown={(e)=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)&&valid){e.preventDefault();void basic.send(modality)}}}></textarea>
    {:else}<p class="upscale-note">Restore detail and enlarge your selected image.</p>{/if}
    <div class="composer-bottom">
      <div class="composer-chips">
        {#if d.workflow==='create'||d.workflow==='edit'}<button class="setting-chip" onclick={()=>panel='subject'} disabled={!!preset}><UserRound size={15}/><span>{subject?.label??'Character'}</span></button>{/if}
        <button class="setting-chip" onclick={()=>panel='style'}><Sparkles size={15}/><span>{preset?.name??style?.name??'Style'}{adult?` · ${mood?.name??d.mood} · ${intensity?.name.split(' · ')[0]??d.intensity??'Low'}`:''}</span></button>
        <button class="setting-chip" onclick={()=>panel='settings'}><span>{preset?'Saved settings':d.workflow==='upscale'?'Size & detail':`${d.quality==='fast'?'Fast':'Detailed'} · ${d.workflow==='animate'?Math.round(Number(d.duration)/24)+'s':d.aspect}`}</span></button>
        <button class="studio-icon" aria-label="Adjust generation settings" onclick={()=>panel='settings'}><SlidersHorizontal size={17}/></button>
      </div>
      <button class="studio-button primary generate-button" disabled={!valid} onclick={()=>basic.send(modality)}>{basic.busy?'Preparing…':action}<ArrowUp size={18}/></button>
    </div>
  </div>
  <div class="composer-foot">
    {#if d.workflow!=='upscale'}<label class="assist-toggle"><input type="checkbox" checked={d.assistance!=='off'} disabled={basic.busy} onchange={(e)=>basic.update(modality,{assistance:e.currentTarget.checked?'auto':'off'})}/>{adult?'Adult editorial director':'Prompt assist'}</label><button class="text-action" disabled={!valid||d.assistance==='off'} onclick={()=>basic.send(modality,true)}>Review prompt</button>{:else}<span>Source stays unchanged</span>{/if}
    <button class="text-action presets-link" onclick={()=>panel='presets'}>Saved presets</button>
  </div>
  {#if basic.error}<div class="studio-error" role="alert">{basic.error}<button class="text-action" onclick={()=>basic.error=''}>Dismiss</button></div>{/if}
</div>
{#if panel}
  <dialog class="studio-sheet" bind:this={dialog} aria-labelledby="adjust-title" oncancel={()=>panel=null}>
    <header><div><h2 id="adjust-title">{panel==='subject'?'Choose a character':panel==='presets'?'Your presets':panel==='style'?'Choose a style':'Make it yours'}</h2><p>Changes apply to your next generation.</p></div><button class="studio-icon" aria-label="Close settings" onclick={()=>panel=null}><X size={20}/></button></header>
    <nav class="sheet-tabs" aria-label="Generation choices"><button aria-pressed={panel==='style'} onclick={()=>panel='style'}>Style</button>{#if ['create','edit'].includes(d.workflow)&&!preset}<button aria-pressed={panel==='subject'} onclick={()=>panel='subject'}>Character</button>{/if}<button aria-pressed={panel==='settings'} onclick={()=>panel='settings'}>Settings</button><button aria-pressed={panel==='presets'} onclick={()=>panel='presets'}>Saved presets</button></nav>
    <section class="sheet-content">
      {#if panel==='style'}
        <div class="visual-options">{#each BASIC_STYLES as s}<button class="visual-option style-{s.id}" aria-pressed={d.presetId===s.id} onclick={()=>basic.usePreset(modality,s.id)}><div class="style-preview">{#if styleImage(s.id)}<img src={fileUrl(styleImage(s.id)!)} alt="Recent result using this style" loading="lazy"/>{:else}<Sparkles size={26}/>{/if}</div><span>{s.name}{#if d.presetId===s.id}<Check size={16}/>{/if}</span></button>{/each}</div>
        {#if adult}{@render adultChoices()}{/if}
      {:else if panel==='subject'}
        <div class="visual-options characters"><button class="visual-option" aria-pressed={!d.subject} onclick={()=>basic.update(modality,{subject:''})}><div class="character-preview"><UserRound size={32}/></div><span>As described</span></button>{#each basic.catalog.subjects as s}<article><button class="visual-option" aria-pressed={d.subject===s.id} onclick={()=>basic.update(modality,{subject:s.id})}><div class="character-preview">{#if subjectImage(s.id)}<img src={fileUrl(subjectImage(s.id)!)} alt={s.label}/>{:else}<UserRound size={32}/>{/if}</div><span>{s.label}{#if d.subject===s.id}<Check size={16}/>{/if}</span></button><button class="text-action portrait-action" onclick={()=>portrait(s.id)}>Change portrait</button></article>{/each}</div>
        {#if !basic.catalog.subjects.length}<p class="sheet-hint">Describe your subject in the prompt. Saved identities will appear here when configured on the Mac.</p>{/if}
      {:else if panel==='presets'}
        {#if adult}{@render adultChoices()}{/if}
        <div class="preset-heading"><span>{presets.length} saved {presets.length===1?'preset':'presets'}</span><button class="studio-button quiet" onclick={()=>basic.reload().catch((e)=>basic.error=String(e))}><RefreshCw size={15}/>Refresh</button></div>
        {#if !presets.length}<div class="sheet-empty"><Sparkles size={28}/><h3>Your favorite setups belong here</h3><p>Choose “Save as preset” from a result or Advanced model settings.</p></div>{/if}
        <div class="visual-options">{#each presets as p}<article class="preset-card"><button class="visual-option" aria-pressed={d.presetId===p.id} onclick={()=>basic.usePreset(modality,p.id)}><div class="style-preview">{#if p.thumbnail}<img src={fileUrl(p.thumbnail)} alt={p.name} loading="lazy"/>{:else}<Sparkles size={26}/>{/if}</div><span>{p.name}</span><small>{p.workflow}</small></button><div class="preset-card-actions"><button class="studio-icon" aria-label={`Favorite ${p.name}`} aria-pressed={studio.data.presetFavorites.includes(p.id)} onclick={()=>studio.update({kind:'presetFavorite',id:p.id,value:!studio.data.presetFavorites.includes(p.id)})}><Heart size={17}/></button><button class="text-action" onclick={()=>{basic.usePreset(modality,p.id);editor=true}}>Edit preset</button></div></article>{/each}</div>
      {:else}
        {#if adult}{@render adultChoices()}{/if}
        {#if preset&&adapter}<h3>{preset.name}</h3><ModelSettings adapter={presetControls(preset,adapter)} values={d.values??preset.params} onchange={(key,value)=>basic.update(modality,{values:{...d.values,[key]:value}})}/><p class="sheet-hint">Only controls exposed by this preset are shown.</p><button class="text-action" onclick={()=>editor=true}>Edit preset</button>
        {:else}<div class="settings-fields">
          {#if d.workflow!=='upscale'}<label>Quality<select value={d.quality} onchange={(e)=>basic.update(modality,{quality:e.currentTarget.value as 'fast'|'detailed'})}><option value="fast">Fast — explore an idea</option><option value="detailed">Detailed — refine the result</option></select></label><label>Shape<select value={d.workflow==='animate'&&d.matchSource!==false?'match':d.aspect} onchange={(e)=>basic.update(modality,e.currentTarget.value==='match'?{matchSource:true}:{aspect:e.currentTarget.value as typeof d.aspect,matchSource:false})}>{#if d.workflow==='animate'}<option value="match">Match starting frame</option>{/if}<option value="1:1">Square</option><option value="2:3">Portrait</option><option value="3:2">Landscape</option><option value="9:16">Phone portrait</option><option value="16:9">Widescreen</option></select></label>{/if}
          {#if d.workflow==='animate'}<label>Duration<select value={d.duration} onchange={(e)=>basic.update(modality,{duration:e.currentTarget.value as typeof d.duration})}><option value="49">About 2 seconds</option><option value="97">About 4 seconds</option><option value="121">About 5 seconds</option><option value="241">About 10 seconds</option></select></label>{/if}
          {#if d.workflow==='upscale'}<p>Uses the upscaler’s quality defaults. Save a custom upscale preset in Advanced to choose a different size.</p>{/if}
        </div>{/if}
      {/if}
      {#if studio.error}<p class="studio-error" role="alert">{studio.error}</p>{/if}
    </section>
    <footer><button class="studio-button primary" onclick={()=>panel=null}>Done</button></footer>
  </dialog>
{/if}
{#if editor&&preset}<PresetEditor existing={preset} onDismiss={()=>editor=false}/>{/if}
{#if directorEditor}<DirectorEditor modality={modality==='video'?'video':'image'} initialId="adult" editOnly onDismiss={()=>directorEditor=false}/>{/if}

{#snippet adultChoices()}
  <div class="adult-collection"><h3>Adult editorial · 18+</h3><p>Choose the mood and intensity. Describe the wardrobe and action you want.</p>
    <h4>Mood</h4><div class="choice-row">{#each basic.catalog.modifiers.moods as option}<button class="studio-button" aria-pressed={d.mood===option.id} onclick={()=>basic.update(modality,{mood:option.id})}>{option.name}</button>{/each}</div>
    <p>{mood?.description??'This mood is unavailable. Choose another.'}</p>
    <h4>Intensity</h4><div class="choice-row">{#each basic.catalog.modifiers.intensities as option}<button class="studio-button" aria-pressed={(d.intensity??'low')===option.id} onclick={()=>basic.update(modality,{intensity:option.id})}>{option.name}</button>{/each}</div>
    <p>{intensity?.description??'This intensity is unavailable. Choose another.'}</p>
    <details><summary>Preview mood and intensity instructions</summary>
      {#each [mood,intensity] as choice}{#if choice}<strong>{choice.name}</strong><p>{choice.instructions}</p>{#if modality==='video' && choice.motionInstructions}<p>{choice.motionInstructions}</p>{/if}{/if}{/each}
    </details>
    <div class="choice-row"><button class="text-action" onclick={()=>modifierEditor='moods'}>Edit moods</button><button class="text-action" onclick={()=>modifierEditor='intensities'}>Edit intensity levels</button><button class="text-action" onclick={()=>directorEditor=true}>Edit adult director</button></div>
  </div>
{/snippet}
{#if modifierEditor}<ModifierEditor initialKind={modifierEditor} onDismiss={()=>modifierEditor=null}/>{/if}
