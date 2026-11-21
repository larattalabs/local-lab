<script lang="ts">
  import { Settings2 } from '@lucide/svelte'
  import StudioSettings from './lib/components/StudioSettings.svelte'
  import HistorySettings from './lib/components/HistorySettings.svelte'
  import { syncHistoryDrafts } from './lib/history-reset'
  import { onMount } from 'svelte'
  import './studio.css'
  import StudioView from './lib/components/StudioView.svelte'
  import UpdateNotice from './lib/components/UpdateNotice.svelte'
  import { studio } from './lib/stores/studio.svelte'
  import { MODALITIES, type Modality } from '@shared/types'
  import { store } from './lib/stores/lab.svelte'
  import { basicFlow } from './lib/stores/basic.svelte'
  import { lab, isWeb, webRequest, connect, disconnect } from './lib/api'
  import ChatView from './lib/components/ChatView.svelte'
  import DirectorPreview from './lib/components/DirectorPreview.svelte'
  import QueueBar from './lib/components/QueueBar.svelte'
  import PhoneAccess from './lib/components/PhoneAccess.svelte'
  import PairDevice from './lib/components/PairDevice.svelte'
  import CodeView from './lib/components/code/CodeView.svelte'
  let active = $state<Modality>('image'), ready = $state(false), paired = $state(!isWeb)
  let settingsOpen=$state(false)
  let codeOpen = $state(false)
  function modeChange(mode:'basic'|'advanced') {
    if (mode===basicFlow.mode) return
    if (active==='image'||active==='video') {
      const draft=basicFlow.draft(active)
      if(mode==='advanced') {
        store.prompts[active]=draft.prompt
        store.images[active]=draft.sourceImage && draft.workflow!=='create'?[draft.sourceImage]:[]
      } else {
        const source=store.images[active][0]
        basicFlow.update(active,{prompt:store.prompts[active],sourceImage:source,sourceRatio:source===draft.sourceImage?draft.sourceRatio:undefined,
          workflow:active==='video'?'animate':source?(draft.workflow==='upscale'?'upscale':'edit'):'create'})
      }
    }
    basicFlow.setMode(mode)
    if(mode==='basic'&&active!=='image'&&active!=='video') active='image'
  }
  let historyOpen = $state(false), resetWarning = $state('')
  let observedResetId: string | undefined
  async function checkHistory(reload = false) {
    const info = await lab.historyState()
    resetWarning = info.warning ?? ''
    const changedInThisWindow = observedResetId !== undefined && observedResetId !== info.resetId
    const changed = syncHistoryDrafts(localStorage, info.resetId, changedInThisWindow)
    observedResetId = info.resetId
    if (changed && reload) { ready = false; window.location.reload() }
  }
  let phoneOpen = $state(false), connected = $state(true), error = $state('')
  const modalities = $derived(MODALITIES.filter((m) => (!isWeb && basicFlow.mode === 'advanced') || ['image', 'video'].includes(m.id)))
  async function start() {
    error = ''
    try {
      if (isWeb) { await webRequest('/api/session'); paired = true }
      await checkHistory(); await store.init(); await studio.init(); await basicFlow.init().catch((e) => basicFlow.error = String(e)); ready = true; connect()
      if (isWeb && 'serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => {})
    } catch (e) { error = e instanceof Error ? e.message : String(e) }
  }
  onMount(() => {
    const unpaired = () => { paired = false; ready = false; disconnect() }
    const connection = (e: Event) => { connected = (e as CustomEvent).detail }
    window.addEventListener('lab:unpaired', unpaired); window.addEventListener('lab:connection', connection)
    const reset = lab.onHistoryReset(() => { void checkHistory(true).catch((e) => error = String(e)) })
    const sync = lab.onSync?.(() => { void checkHistory(true).catch(() => {}) })
    void start()
    return () => { reset(); sync?.(); window.removeEventListener('lab:unpaired', unpaired); window.removeEventListener('lab:connection', connection) }
  })
  $effect(() => {
    if (!ready) return
    localStorage.setItem('lab-preferences', JSON.stringify({ selected: store.selected, params: store.params, activeChat: store.activeChat, prompts: store.prompts, images: store.images, contextDraft: store.contextDraft, imageEditSources: store.imageEditSources }))
  })
</script>
<div class:web-client={isWeb} class="app-shell flex h-full flex-col">
  {#if isWeb && !paired}<PairDevice onPaired={() => { void start() }} />
  {:else}
    <header class="titlebar flex items-center gap-1 border-b border-bench-700 bg-bench-950 pl-20 pr-3 h-11 shrink-0">
      <span class="brand text-[13px] font-semibold text-bench-100 mr-4">Local Lab</span>
      {#each modalities as m}<button class="px-3 py-1.5 rounded text-[12px] transition-colors {active === m.id && !codeOpen ? 'bg-bench-700 text-bench-100' : 'text-bench-400 hover:text-bench-100'}" title={m.blurb} onclick={() => { codeOpen = false; active = m.id; studio.selected = null; studio.page = 'create' }}>{m.label}</button>{/each}
      {#if !isWeb}<button class="px-3 py-1.5 rounded text-[12px] transition-colors {codeOpen ? 'bg-bench-700 text-bench-100' : 'text-bench-400 hover:text-bench-100'}" title="Coding agent (omp or opencode) on a local text model" onclick={() => codeOpen = true}>Code</button>{/if}
      <div class="flex-1"></div>
      <div class:phone-hidden={isWeb} class="experience-switch" aria-label="Interface mode">{#each ['basic', 'advanced'] as mode}<button aria-pressed={basicFlow.mode === mode} onclick={() => { modeChange(mode as 'basic' | 'advanced') }}>{mode === 'basic' ? 'Basic' : 'Advanced'}</button>{/each}</div>
      <button class="history-button" title="Studio settings" aria-label="Studio settings" disabled={!ready} onclick={() => settingsOpen = true}><Settings2 size={18}/></button>
      {#if !isWeb}
        <button class="mono text-[11px] text-signal px-2 py-1" onclick={() => phoneOpen = true}>Phone access</button>
        <button class="mono text-[11px] text-bench-400 px-2 py-1" title="Open the runs folder in Finder" onclick={() => lab.openRuns()}>Outputs ↗</button>
      {/if}
    </header>
    {#if isWeb && !connected}<div class="connection-banner" role="status">Reconnecting to your Mac… Accepted jobs keep running. Keep the Mac awake and on the same Wi-Fi.</div>{/if}
    {#if resetWarning}<div class="connection-banner" role="alert">{resetWarning}</div>{/if}
    {#if ready}{#if codeOpen && !isWeb}<CodeView />{:else if active==='image'||active==='video'}<StudioView modality={active} onNavigate={(modality) => active = modality} />{:else}<ChatView modality={active} onNavigate={(modality) => active = modality} />{/if}
    {:else}<div class="flex-1 grid place-items-center text-bench-400 mono text-[12px]"><div>{error || 'Connecting to local models…'}{#if error}<button class="block mt-4 text-signal" onclick={start}>Try again</button>{/if}</div></div>{/if}
    {#if ready && isWeb}<UpdateNotice />{/if}
    <QueueBar />
  {/if}
</div>
 {#if settingsOpen}<StudioSettings modality={active==='video'?'video':'image'} {modeChange} onDismiss={()=>settingsOpen=false} onHistory={()=>{settingsOpen=false;historyOpen=true}} onUnpair={async()=>{await webRequest('/api/logout',{});disconnect();window.location.reload()}}/>{/if}
{#if historyOpen}<HistorySettings onDismiss={() => historyOpen = false} />{/if}
{#if phoneOpen}<PhoneAccess onDismiss={() => phoneOpen = false} />{/if}

{#if ready}<DirectorPreview onNavigate={(modality) => active = modality} />{/if}

<style>.experience-switch.phone-hidden{display:none}.history-button{font-size:20px;line-height:1;padding:6px;color:#b7c1ce;border-radius:6px}.history-button:hover{background:#303845}.experience-switch{display:flex;gap:2px;border:1px solid #39424e;border-radius:8px;padding:2px}.experience-switch button{font-size:12px;padding:6px 10px;color:#9ba7b8;border-radius:5px}.experience-switch button[aria-pressed=true]{background:#343027;color:#f1d69b}@media(max-width:700px){.experience-switch button{font-size:10px;padding:5px}.brand{display:none}}</style>
