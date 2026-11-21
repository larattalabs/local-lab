<script lang="ts">
  import { Plus, Images, Sparkles, Heart, Pencil, Clapperboard, Shuffle, Download, Ellipsis, Expand, SlidersHorizontal, History, X, Search, Menu, Check, Pin, RefreshCw, ImagePlus, ArrowUpRight } from '@lucide/svelte'
  import type { Modality, ChatMessage } from '@shared/types'
  import { reportedProgress, durationEstimate, type MediaItem, type StudioProject } from '@shared/studio'
  import { basicDefaults } from '@shared/basic'
  import { store } from '../stores/lab.svelte'
  import { basicFlow as basic } from '../stores/basic.svelte'
  import { studio } from '../stores/studio.svelte'
  import { directorFlow } from '../stores/director.svelte'
  import { lab, fileUrl, thumbnailUrl } from '../api'
  import ChatView from './ChatView.svelte'
  import ParamPanel from './ParamPanel.svelte'
  import AnimateImage from './AnimateImage.svelte'
  import MotionCompare from './MotionCompare.svelte'
  import BasicComposer from './BasicComposer.svelte'
  import MediaViewer from './MediaViewer.svelte'
  import PresetEditor from './PresetEditor.svelte'
  let { modality,onNavigate }:{modality:Modality;onNavigate:(m:Modality)=>void}=$props()
  let inspector=$state(false), chatView=$state(false), compare=$state(false), animation=$state('')
  const projects=$derived(studio.projects)
  const allItems=$derived(studio.items)
  const active=$derived(store.activeChat[modality])
  const selectedItem=$derived(allItems.find((i)=>i.id===studio.selected))
  const project=$derived(selectedItem?projects.find((p)=>p.items.some((i)=>i.id===selectedItem.id)):projects.find((p)=>p.chats.some((c)=>c.id===active)))
  const item=$derived(selectedItem??project?.items.filter((i)=>i.modality===modality).at(-1))
  const draftSource=$derived(basic.draft(modality).sourceImage)
  let sidebar=$state(false),activity=$state(false),more=$state(false),preset=$state<MediaItem>(),rename=$state(false),name=$state(''),error=$state('')
  let query=$state(''),filter=$state<'all'|'image'|'video'|'favorites'>('all'),projectFilter=$state(''),pageSize=$state(36)
  const library=$derived(projects.filter((p)=>!projectFilter||p.id===projectFilter).flatMap((p)=>p.items).filter((i)=>i.message.state==='done'&&i.message.outputPath&&(filter==='all'||filter==='favorites'&&studio.data.favorites.includes(i.message.outputPath)||i.modality===filter)&&`${i.title} ${i.message.effectivePrompt??''}`.toLowerCase().includes(query.toLowerCase())).sort((a,b)=>b.at-a.at))
  $effect(()=>{void query;void filter;void projectFilter;pageSize=36})
  $effect(()=>{void modality;void project?.id;more=false;rename=false})
  function select(i:MediaItem){studio.select(i);onNavigate(i.modality);more=false}
  function openProject(p:StudioProject){const i=p.items.at(-1);if(i)select(i);else if(p.chats[0]){store.openChat(p.chats[0].modality,p.chats[0].id);onNavigate(p.chats[0].modality);studio.selected=null;studio.page='create'}sidebar=false}
  function newProject(){for(const m of ['image','video'] as const){store.prompts[m]='';store.images[m]=[]} store.newChat('image');store.newChat('video');basic.resetDraft('image');basic.resetDraft('video');studio.selected=null;studio.page='create';onNavigate('image');sidebar=false}
  function edit(i:MediaItem,upscale=false){
    if (basic.mode==='advanced' && !upscale && i.message.outputPath) {
      select(i); store.images.image=[i.message.outputPath]; return
    }
    if(upscale)basic.setMode('basic')
    if(!i.message.outputPath)return;select(i);if(i.modality!=='image')return;basic.source('image',i.message.outputPath,upscale?'upscale':'edit');activity=false}
  function animate(i:MediaItem){if(!i.message.outputPath)return;if(basic.mode==='advanced'){animation=i.message.outputPath;return}basic.animate(i.message.outputPath,project?.id.startsWith('run:')?undefined:project?.id);studio.selected=null;studio.page='create';onNavigate('video');activity=false}
  async function vary(i:MediaItem,exact=false){select(i);await basic.send(i.modality,false,i.message,exact);studio.selected=null}
  function advanced(i:MediaItem){select(i);basic.advanced(i.message)}
  async function save(i:MediaItem){try{if(i.message.outputPath)await lab.saveMedia(i.message.outputPath)}catch(e){error=String(e)}}
  async function saveName(){if(project){await studio.update({kind:'title',id:project.id,title:name});if(!studio.error)rename=false}}
  const thumbnail=(p:StudioProject)=>p.items.filter((i)=>i.message.state==='done').at(-1)
  const previewPath=(i:MediaItem)=>i.modality==='image'?i.message.outputPath:i.source
  const stamp=(n:number)=>new Date(n).toLocaleDateString(undefined,{month:'short',day:'numeric'})
  const pending=$derived(store.jobs.filter((j)=>!j.kind&&['queued','running'].includes(j.state)))
  const activeJob=$derived(store.jobs.find(job=>job.id===item?.message.jobId))
  const progress=$derived(activeJob?reportedProgress(activeJob):undefined)
  const estimate=$derived(activeJob?durationEstimate(activeJob.adapterId,activeJob.params,allItems):undefined)
</script>
<svelte:window onkeydown={(e)=>{if(e.key==='Escape'){more=false;sidebar=false}}} onclick={(e)=>{if(!(e.target as Element).closest('.result-more'))more=false}}/>
{#if chatView && basic.mode==='advanced'}
  <button class="studio-button quiet" onclick={()=>chatView=false}>← Back to Studio</button>
  <ChatView {modality} {onNavigate}/>
{:else}
<div class="studio-view">
  <div class="studio-mobile-nav"><button class="studio-button quiet" onclick={()=>sidebar=true}><Menu size={19}/>Projects</button><button class="studio-button quiet" aria-pressed={studio.page==='library'} onclick={()=>studio.page=studio.page==='library'?'create':'library'}><Images size={18}/>Library</button><button class="studio-icon" aria-label="New project" onclick={newProject}><Plus size={20}/></button></div>
  {#if sidebar}<button class="studio-sidebar-shade" aria-label="Close project navigation" onclick={()=>sidebar=false}></button>{/if}
  <aside class:open={sidebar} class="studio-sidebar">
    <button class="studio-button new-project" onclick={newProject}><Plus size={18}/>New project</button>
    <nav aria-label="Studio navigation"><button aria-pressed={studio.page==='create'} onclick={()=>{studio.page='create';sidebar=false}}><Sparkles size={18}/>Create</button><button aria-pressed={studio.page==='library'} onclick={()=>{studio.page='library';sidebar=false}}><Images size={18}/>Library<span>{allItems.filter((i)=>i.message.state==='done').length}</span></button></nav>
    <div class="sidebar-heading">Recent projects</div>
    <div class="project-list">{#each projects as p(p.id)}{@const thumb=thumbnail(p)}<button class:active={project?.id===p.id&&studio.page==='create'} onclick={()=>openProject(p)}>{#if thumb&&previewPath(thumb)}<img src={thumbnailUrl(previewPath(thumb)!)} alt="" loading="lazy"/>{:else}<span class="project-icon"><Images size={18}/></span>{/if}<span class="project-name">{p.title}<small>{p.items.length} {p.items.length===1?'version':'versions'} · {stamp(p.updatedAt)}</small></span></button>{/each}{#if !projects.length}<p class="sidebar-empty">Your ideas and their versions will appear here.</p>{/if}</div>
    <div class="sidebar-local">Runs locally on your Mac</div>
  </aside>
  <main class="studio-main">
    {#if studio.page==='library'}
      <div class="library-header"><div><h1>Your library</h1><p>Images, edits, and videos from all your projects.</p></div><button class="studio-button" onclick={()=>store.resync().catch((e)=>error=String(e))}><RefreshCw size={16}/>Refresh</button></div>
      <div class="library-controls"><label class="search-field"><Search size={18}/><input type="search" aria-label="Search library" placeholder="Find a project or prompt…" bind:value={query}/></label><select aria-label="Filter by project" bind:value={projectFilter}><option value="">All projects</option>{#each projects as p}<option value={p.id}>{p.title}</option>{/each}</select><div class="filter-pills" aria-label="Filter media">{#each [{id:'all',name:'All'},{id:'image',name:'Images'},{id:'video',name:'Videos'},{id:'favorites',name:'Favorites'}] as f}<button aria-pressed={filter===f.id} onclick={()=>filter=f.id as typeof filter}>{f.name}</button>{/each}</div></div>
      <div class="library-scroll">{#if library.length}<div class="media-grid">{#each library.slice(0,pageSize) as i(i.id)}<article class="library-card"><button class="library-image" aria-label={`Open ${i.title}`} onclick={()=>select(i)}>{#if previewPath(i)}<img src={thumbnailUrl(previewPath(i)!)} alt={i.title} loading="lazy"/>{:else}<Clapperboard size={32}/>{/if}{#if i.modality==='video'}<span class="video-badge"><Clapperboard size={15}/>Video</span>{/if}</button><div class="library-caption"><button class="library-title" onclick={()=>select(i)}>{i.title}</button><button class="studio-icon" aria-label={`Favorite ${i.title}`} aria-pressed={studio.data.favorites.includes(i.message.outputPath!)} onclick={()=>studio.favorite(i)}><Heart size={18}/></button></div><small>{stamp(i.at)} · {i.modality==='video'?'Video':i.source?'Edit':'Image'}</small></article>{/each}</div>{#if library.length>pageSize}<button class="studio-button load-more" onclick={()=>pageSize+=36}>Show more</button>{/if}{:else}<div class="studio-empty"><Images size={36}/><h2>{filter==='favorites'?'Keep the ones you love':'Nothing here yet'}</h2><p>{filter==='favorites'?'Tap the heart on a result to save it here.':query?'Try another search or filter.':'Create an image or animate a photo to start your library.'}</p></div>{/if}</div>
    {:else}
      <header class="project-header"><div>{#if rename}<form class="rename-form" onsubmit={(e)=>{e.preventDefault();void saveName()}}><input aria-label="Project name" bind:value={name} maxlength="100"/><button class="studio-icon" aria-label="Save project name"><Check size={18}/></button><button type="button" class="studio-icon" aria-label="Cancel rename" onclick={()=>rename=false}><X size={18}/></button></form>{:else}<h1>{project?.title??(modality==='video'?'Bring a moment to life':'What will you create?')}</h1>{/if}<p>{project?`${project.items.length} ${project.items.length===1?'version':'versions'} · Images and motion together`:'Start with an idea, a character, or an image.'}</p></div><div>{#if project?.chats.length}<button class="studio-icon" aria-label="Rename project" onclick={()=>{name=project.title;rename=true}}><Pencil size={17}/></button>{/if}{#if project}<button class="studio-button quiet" aria-label="Project activity" aria-pressed={activity} onclick={()=>activity=!activity}><History size={17}/><span>Activity</span></button>{/if}</div></header>
      <div class="studio-result-area">
        {#if activity&&project}
          <section class="activity-panel" aria-label="Project activity"><header><h2>Project activity</h2><button class="studio-icon" aria-label="Close project activity" onclick={()=>activity=false}><X size={18}/></button></header>{#each project.chats.flatMap((c)=>c.messages.map((m)=>({...m,modality:c.modality}))).sort((a,b)=>a.at-b.at) as m(m.id)}<article class:request={m.role==='user'}><small>{m.role==='user'?'Your request':m.adapterLabel} · {stamp(m.at)}</small><p>{m.role==='user'?m.text:m.state==='done'?'Ready':m.error??m.state}</p>{#if m.requestSnapshot?.basic?.modifiers}{@const mods=m.requestSnapshot.basic.modifiers}<details><summary>{mods.mood.name} · {mods.intensity.name}</summary><p>{[mods.mood.instructions,mods.intensity.instructions,...(m.modality==='video'?[mods.mood.motionInstructions,mods.intensity.motionInstructions]:[])].filter(Boolean).join('\n')||'No extra modifier instructions.'}</p></details>{/if}{#if m.role==='gen'&&m.effectivePrompt}<details><summary>Prompt used</summary><p>{m.effectivePrompt}</p></details>{/if}</article>{/each}</section>
        {:else if item?.message.state==='done'&&item.message.outputPath}
          <MediaViewer {item} items={project?.items??[item]} onSelect={select}/>
          <details class="recipe-details"><summary>Run recipe · {item.message.adapterLabel??item.message.adapterId}</summary>
            <dl>{#each Object.entries(item.message.details??{}).filter(([k,v])=>v!=null&&v!==''&&k!=='model') as [k,v]}<dt>{{engine:'Engine',encoder:'Text encoder',identity:'Identity',strength:'Adapter strength',seed:'Seed',size:'Output size',frames:'Frames',fps:'FPS'}[k]??k}</dt><dd>{v}</dd>{/each}</dl>
            {#if item.source}<p>Source</p><img src={fileUrl(item.source)} alt="Submitted source" width="72" />{/if}
            {#if item.message.originalPrompt || item.message.director}<p>Original request</p><blockquote>{item.message.originalPrompt??item.message.director?.originalPrompt}</blockquote>{/if}
            <p>Submitted prompt</p><blockquote>{item.message.effectivePrompt??item.message.requestSnapshot?.prompt}</blockquote>
            {#if item.message.requestSnapshot}<details><summary>All settings</summary><pre>{JSON.stringify(item.message.requestSnapshot.params,null,2)}</pre></details>{/if}
          </details>
          <div class="result-toolbar" aria-label="Result actions">
            {#if item.modality==='image'}<button class="studio-button" onclick={()=>edit(item)}><Pencil size={17}/>Edit</button><button class="studio-button" onclick={()=>animate(item)}><Clapperboard size={17}/>Animate</button>{/if}
            {#if item.message.requestSnapshot&&item.chatId}<button class="studio-button" disabled={basic.busy} onclick={()=>vary(item)}><Shuffle size={17}/>Make another</button>{/if}
            <button class="studio-button" onclick={()=>save(item)}><Download size={17}/>Save</button><button class="studio-icon" aria-label="Favorite result" aria-pressed={studio.data.favorites.includes(item.message.outputPath)} onclick={()=>studio.favorite(item)}><Heart size={18}/></button>
            <div class="result-more"><button class="studio-icon" aria-label="More result actions" aria-expanded={more} onclick={()=>more=!more}><Ellipsis size={20}/></button>{#if more}<div class="result-menu">
            {#if item.modality==='image'||item.source}<button onclick={()=>{compare=true;more=false}}>Compare motion…</button>{/if}
            {#if item.chatId&&item.message.requestSnapshot&&item.message.seed!=null}<button onclick={()=>{more=false;void vary(item,true)}}>Repeat settings & seed</button>{/if}
            {#if item.modality==='image'&&item.message.outputPath}<button onclick={()=>{const path=item!.message.outputPath!;newProject();basic.setMode('basic');basic.source('image',path,'edit')}}>Use in new project</button>{/if}
{#if item.modality==='image'}<button onclick={()=>{edit(item,true);more=false}}><Expand size={16}/>Upscale</button>{/if}{#if item.message.requestSnapshot}<button onclick={()=>{preset=item;more=false}}><Sparkles size={16}/>Save as preset</button><button onclick={()=>advanced(item)}><SlidersHorizontal size={16}/>Open in Advanced</button>{/if}<button onclick={()=>{activity=true;more=false}}><History size={16}/>Prompt & details</button></div>{/if}</div>
          </div>
        {:else if item&&['queued','running'].includes(item.message.state??'')}
          <div class="generation-stage" role="status">{#if item.source}<img src={fileUrl(item.source)} alt="Pinned generation source"/>{:else}<Sparkles size={34}/>{/if}<h2>{progress?.label??'Generation in progress'}</h2>{#if progress?.total}<progress value={progress.step} max={progress.total}></progress><p>Sampling step {progress.step} of {progress.total}</p>{:else}<div class="indeterminate-line"></div>{/if}<p>{estimate??'You can keep browsing while your Mac works.'}</p>{#if item.message.jobId}<button class="studio-button" onclick={()=>lab.cancel(item.message.jobId!)}>Cancel generation</button>{/if}</div>
        {:else if item&&['error','cancelled'].includes(item.message.state??'')}
          <div class="generation-stage"><h2>{item.message.state==='error'?'This generation couldn’t finish':'Generation cancelled'}</h2><p>Your earlier results are safe.</p>{#if item.message.error}<details><summary>What happened?</summary><pre>{item.message.error}</pre></details>{/if}{#if item.message.requestSnapshot}<button class="studio-button" onclick={()=>advanced(item)}>Restore request in Advanced</button>{/if}</div>
        {:else if draftSource}<div class="media-viewer"><div class="viewer-tools"><span>{modality==='video'?'Starting frame':'Selected source'}</span></div><div class="media-canvas"><img class="result-image" src={fileUrl(draftSource)} alt="Selected starting frame"/></div></div>
        {:else}<div class="studio-empty"><Sparkles size={36}/><h2>{modality==='video'?'Give your image a little motion':'A place for your next idea'}</h2><p>{modality==='video'?'Choose Animate on a result, or attach a starting image below.':'Describe what you imagine. We’ll help with the details.'}</p>{#if modality==='image'}<div class="starter-prompts">{#each ['A natural portrait in soft window light','A cinematic scene at blue hour','An editorial fashion photograph'] as prompt}<button class="studio-button" onclick={()=>basic.update('image',{prompt})}>{prompt}</button>{/each}</div>{/if}</div>{/if}
      </div>
      {#if project&&project.items.length>1}<div class="version-strip" aria-label="Project versions">{#each project.items as i,index(i.id)}<button class:selected={item?.id===i.id} aria-label={`Select version ${index+1}, ${i.modality}${i.source?', from a source image':''}`} aria-pressed={item?.id===i.id} onclick={()=>select(i)}>{#if previewPath(i)}<img src={thumbnailUrl(previewPath(i)!)} alt="" loading="lazy"/>{:else}<span>{i.message.state==='error'?'!':i.modality==='video'?'▶':'…'}</span>{/if}<small>{index+1}{i.modality==='video'?' · Video':i.source?' · Edit':''}</small></button>{/each}</div>{/if}
      {#if basic.mode==='advanced'}
        <div class="inspector-bar"><button class="studio-button" aria-expanded={inspector} onclick={()=>inspector=!inspector}><SlidersHorizontal size={16}/>Model & director</button><button class="studio-button quiet" onclick={()=>chatView=true}>Chat history</button></div>
        {#if inspector}<div class="studio-inspector"><ParamPanel {modality}/></div>{/if}
        <ChatView onAccepted={()=>studio.selected=null} composerOnly {modality} {onNavigate}/>
      {:else}<BasicComposer {modality}/>{/if}
    {/if}
    {#if error||studio.error}<div role="alert" class="studio-error">{error||studio.error}<button class="text-action" onclick={()=>{error='';studio.error=''}}>Dismiss</button></div>{/if}
  </main>
</div>
{/if}
{#if animation}<AnimateImage image={animation} onDismiss={()=>animation=''} {onNavigate}/>{/if}
{#if compare && item?.message.outputPath}<MotionCompare source={item.modality==='image'?item.message.outputPath:item.source??''} projectId={project?.id.startsWith('run:')?undefined:project?.id} clips={project?.items.filter(i=>i.modality==='video'&&i.message.state==='done'&&i.message.outputPath)??[]} onDismiss={()=>compare=false} onQueued={()=>{compare=false;studio.selected=null;onNavigate('video')}}/>{/if}
{#if preset?.message.requestSnapshot}{@const request=preset.message.requestSnapshot}<PresetEditor moodId={request.basic?.style} intensityId={request.basic?.intensity} directorId={basic.catalog.presets.find((p)=>p.id===request.basic?.presetId)?.director??(request.basic?.adult?'adult':undefined)} adapterId={request.adapterIds[0]} params={request.params[request.adapterIds[0]]} thumbnail={preset.modality==='image'?preset.message.outputPath:preset.source} onDismiss={()=>preset=undefined}/>{/if}
