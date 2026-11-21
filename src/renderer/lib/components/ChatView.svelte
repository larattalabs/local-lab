<script lang="ts">
  import type { ChatMessage, Job, Modality, RunRecord } from '@shared/types'
  import { directorFlow } from '../stores/director.svelte'
  import { store } from '../stores/lab.svelte'
  import { fileUrl, lab, isWeb } from '../api'
  import ModelDropdown from './ModelDropdown.svelte'
  import ParamPanel from './ParamPanel.svelte'
  import AnimateImage from './AnimateImage.svelte'
  import BasicComposer from './BasicComposer.svelte'
  import PresetEditor from './PresetEditor.svelte'
  import { basicFlow } from '../stores/basic.svelte'
  import { basicDefaults } from '@shared/basic'
  let presetMessage = $state<ChatMessage>()

  let { modality, onNavigate, basic = false, composerOnly = false, onAccepted }: { onAccepted?:()=>void; composerOnly?: boolean; basic?: boolean; modality: Modality; onNavigate: (m: Modality) => void } = $props()
  let mobilePanel = $state<'chats' | 'settings' | null>(null)
  let sending = $state(false)
  let animationSource = $state<string | null>(null)
  let sendError = $state('')
  let promptInput = $state<HTMLTextAreaElement | null>(null)
  const imageTurn = $derived(!basic && modality === 'image' ? store.imageTurn() : undefined)

  const chats = $derived(store.chatsFor(modality))
  const chat = $derived(store.currentChat(modality))
  const unfiled = $derived(store.unfiled.filter((r) => r.modality === modality))
  const viewingUnfiled = $derived(store.viewingUnfiled[modality])

  const selectedCount = $derived(
    store.selected[modality].filter((id) => store.isAvailable(id)).length
  )
  const promptOptional = $derived(selectedCount > 0 && store.selected[modality]
    .filter((id) => store.isAvailable(id))
    .every((id) => store.adapters.find((a) => a.id === id)?.promptOptional))
  const runnable = $derived(selectedCount > 0 &&
    (store.prompts[modality].trim().length > 0 || promptOptional) && !imageTurn?.error)
  const wantsImages = $derived(
    store.selected[modality].some(
      (id) => { const a = store.adapters.find((a) => a.id === id); return a?.acceptsImages || a?.imageEditAdapterId }
    )
  )
  const wantsAudio = $derived(
    store.selected[modality].some(
      (id) => store.adapters.find((a) => a.id === id)?.acceptsAudio
    )
  )
  const contextOn = $derived(chat ? chat.contextOn : store.contextDraft[modality])

  function toggleContext() {
    if (chat) chat.contextOn = !chat.contextOn
    else store.contextDraft[modality] = !store.contextDraft[modality]
  }

  /**
   * Right-click menu for a sidebar conversation. Positioned at the cursor and
   * clamped upward near the bottom edge so the menu can't open off-screen.
   */
  let menu = $state<{ x: number; y: number; id: string; title: string } | null>(null)

  function openMenu(e: MouseEvent, c: { id: string; title: string }) {
    e.preventDefault()
    menu = {
      x: Math.min(e.clientX, window.innerWidth - 240),
      y: Math.min(e.clientY, window.innerHeight - 110),
      id: c.id,
      title: c.title,
    }
  }

  async function removeChat(id: string) {
    menu = null
    await store.removeChat(modality, id)
  }

  function liveJob(m: ChatMessage): Job | undefined {
    return m.jobId ? store.jobs.find((j) => j.id === m.jobId) : undefined
  }

  function editImage(path: string) {
    if (basic) basicFlow.source('image', path, 'edit')
    else store.selectImageForEdit(path)
    sendError = ''
    promptInput?.focus()
  }

  function animate(path: string) {
    if (basic) { basicFlow.animate(path); onNavigate('video') }
    else animationSource = path
  }

  async function send() {
    if (sending) return
    sending = true
    sendError = ''
    try { if (await store.send(modality)) onAccepted?.() }
    catch (error) { sendError = error instanceof Error ? error.message : String(error) }
    finally { sending = false }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !isWeb) {
      e.preventDefault()
      if (runnable) void send()
    }
  }

  function when(t: number): string {
    return new Date(t).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    })
  }

  // Keep the newest message in view as generations stream in.
  let logEl = $state<HTMLElement | null>(null)
  const lastState = $derived(chat?.messages.at(-1)?.state)
  $effect(() => {
    void chat?.messages.length
    void lastState
    if (logEl) logEl.scrollTop = logEl.scrollHeight
  })

  let logText = $state('')
  async function showLog(message:string, jobId:string) {
    if (openLog===message) { openLog=null;return }
    openLog=message;logText='Loading…'
    try { const text=await lab.jobLog?.(jobId);if(openLog===message)logText=text||'No output yet.' }
    catch(error) { if(openLog===message)logText=String(error) }
  }
  let openLog = $state<string | null>(null)
</script>

{#snippet advancedComposer()}
      <div class="composer border-t border-bench-700 bg-bench-900 p-3 shrink-0">
        {#if imageTurn?.images.length}
          <div class="mb-2 flex items-center gap-3 rounded border border-bench-700 p-2 text-[12px]">
            {#if imageTurn.images[0].startsWith(store.runsDir + '/')}
              <img src={fileUrl(imageTurn.images[0])} alt="Source for the next edit"
                   class="h-14 w-14 rounded object-contain bg-bench-950" />
            {/if}
            <div>
              <p class="text-bench-200">{imageTurn.fromSelection ? 'Selected image' : imageTurn.fromContext ? 'Previous image' : 'Attached image'}
                → {[...new Set(imageTurn.routes.map(({ target }) => target?.label).filter(Boolean))].join(', ')}</p>
              <p class="text-bench-500">Your next prompt will use {imageTurn.images.length === 1 ? 'this image' : `these ${imageTurn.images.length} images`}.</p>
            </div>
            {#if imageTurn.fromSelection}
              <button class="ml-auto shrink-0 text-signal hover:text-bench-100"
                      onclick={() => store.clearImageEditSource()}>{contextOn ? 'Use latest image' : 'Clear selection'}</button>
            {/if}
          </div>
        {/if}
        {#if imageTurn?.error || sendError}
          <p role="alert" class="mb-2 text-[12px] text-fault">{imageTurn?.error || sendError}</p>
        {/if}
        <textarea bind:this={promptInput}
          class="w-full resize-none rounded bg-bench-850 border border-bench-700 p-2.5 text-[13px]
                 leading-relaxed outline-none focus:border-bench-600 placeholder:text-bench-600"
          rows="2"
          placeholder={promptOptional ? 'Optional note for this upscale…' : modality === 'text'
            ? 'Ask something… (Enter to send, Shift+Enter for a new line)'
            : `Describe what you want ${modality === 'music' ? 'to hear' : 'to see'}…`}
          bind:value={store.prompts[modality]}
          onkeydown={onKey}
        ></textarea>

        <div class="composer-actions flex items-center gap-2 mt-2">
          <ModelDropdown {modality} />

          <button
            class="flex items-center gap-1.5 rounded border px-2.5 py-1 mono text-[11px] transition-colors
                   {contextOn
                     ? 'border-signal/50 text-signal'
                     : 'border-bench-700 text-bench-500 hover:border-bench-600'}"
            title={contextOn
              ? 'Context on: text models see the conversation; image follow-ups use the previous image and a matching editor when available. Click for fresh one-offs.'
              : 'Context off: every message runs fresh.'}
            onclick={toggleContext}
          >
            <span class="size-1.5 rounded-full {contextOn ? 'bg-signal' : 'bg-bench-600'}"></span>
            context
          </button>

          {#if wantsImages || wantsAudio}
            <button
              class="mono text-[11px] px-2 py-1 rounded border border-bench-700 text-bench-300
                     hover:border-bench-600 hover:text-bench-100"
              onclick={async () => {
                try { store.images[modality] = wantsAudio ? await lab.pickAudio() : await lab.pickImages() }
                catch (e) { sendError = e instanceof Error ? e.message : String(e) }
              }}
            >
              {store.images[modality].length
                ? wantsAudio
                  ? store.images[modality][0].split('/').pop()
                  : `${store.images[modality].length} image(s)`
                : wantsAudio
                  ? 'attach audio'
                  : 'attach'}
            </button>
            {#if store.images[modality].length}
              <button class="mono text-[11px] text-bench-400 hover:text-fault"
                      onclick={() => (store.images[modality] = [])}>clear</button>
            {/if}
          {/if}

          <div class="flex-1"></div>
          <button
            class="px-4 py-1.5 rounded text-[12px] font-medium transition-colors
                   {runnable
                     ? 'bg-signal text-bench-950 hover:brightness-110'
                     : 'bg-bench-800 text-bench-600 cursor-not-allowed'}"
            disabled={!runnable || sending}
            onclick={send}
          >
            {sending ? 'Preparing…' : (modality === 'image' || modality === 'video') && directorFlow.choices[modality].mode === 'preview' ? 'Preview prompt' : 'Send'}{selectedCount > 1 ? ` ×${selectedCount}` : ''}
          </button>
        </div>
      </div>
{/snippet}
{#if composerOnly}{@render advancedComposer()}{:else}
<div class="mobile-toolbar">
  <button onclick={() => mobilePanel = mobilePanel === 'chats' ? null : 'chats'}>☰ Chats</button>
  <span>{chat?.title ?? 'New chat'}</span>
  {#if !basic}<button onclick={() => mobilePanel = mobilePanel === 'settings' ? null : 'settings'}>Settings</button>{/if}
</div>
{#if mobilePanel}<button class="mobile-shade" aria-label="Close panel" onclick={() => mobilePanel = null}></button>{/if}
<div class="chat-layout flex flex-1 min-h-0">
  <!-- Sessions -->
  <aside class:mobile-open={mobilePanel === 'chats'} class="chat-sidebar w-[240px] shrink-0 border-r border-bench-700 bg-bench-850 flex flex-col min-h-0">
    <div class="p-2 border-b border-bench-700 shrink-0">
      <button
        class="w-full rounded border border-bench-700 px-2 py-1.5 text-[12px] text-bench-300
               hover:border-bench-600 hover:text-bench-100 transition-colors"
        onclick={() => { store.newChat(modality); if (basic) basicFlow.update(modality, basicDefaults(modality === 'video' ? 'animate' : 'create')); mobilePanel = null }}
      >+ new chat</button>
    </div>

    <div class="flex-1 overflow-y-auto p-1.5 space-y-0.5 min-h-0">
      {#each chats as c (c.id)}
        <div class="group relative">
          <button
            class="w-full text-left rounded px-2 py-1.5 transition-colors
                   {!viewingUnfiled && store.activeChat[modality] === c.id
                     ? 'bg-bench-700 text-bench-100'
                     : 'text-bench-300 hover:bg-bench-800'}"
            onclick={() => { store.openChat(modality, c.id); mobilePanel = null }}
            oncontextmenu={(e) => openMenu(e, c)}
          >
            <div class="text-[12px] truncate pr-5">{c.title}</div>
            <div class="mono text-[10px] text-bench-600 mt-0.5">{when(c.updatedAt)}</div>
          </button>
          <button
            class="absolute right-1.5 top-1.5 hidden group-hover:block mono text-[10px]
                   text-bench-500 hover:text-fault"
            title="Delete this chat. Its generations stay on disk and move to Earlier runs."
            onclick={() => removeChat(c.id)}
          >✕</button>
        </div>
      {/each}
      {#if !chats.length}
        <p class="text-[11px] text-bench-600 leading-relaxed p-2">
          No conversations yet — send a prompt to start one.
        </p>
      {/if}
    </div>

    {#if unfiled.length}
      <button
        class="shrink-0 border-t border-bench-700 px-3 py-2 text-left text-[11.5px] transition-colors
               {viewingUnfiled ? 'bg-bench-700 text-bench-100' : 'text-bench-400 hover:text-bench-100'}"
        onclick={() => { store.viewingUnfiled[modality] = true; mobilePanel = null }}
      >
        Earlier runs <span class="mono text-[10px] text-bench-600">{unfiled.length}</span>
      </button>
    {/if}
  </aside>

  <!-- Conversation -->
  <main class="min-w-0 flex-1 flex flex-col min-h-0">
    {#if viewingUnfiled}
      <div class="flex-1 overflow-y-auto p-4 min-h-0">
        <p class="text-[11px] text-bench-600 mb-3 leading-relaxed">
          Generations from before conversations existed (or whose chat was deleted).
          Read-only — start a new chat to keep generating.
        </p>
        <div class="grid gap-3" style="grid-template-columns: repeat(auto-fill, minmax(300px, 1fr))">
          {#each unfiled as r (r.dir)}
            <article class="rounded border border-bench-700 bg-bench-850 overflow-hidden flex flex-col">
              <header class="flex items-center gap-2 px-2.5 py-1.5 border-b border-bench-700">
                <span class="size-1.5 rounded-full {r.state === 'done' ? 'bg-live' : 'bg-fault'}"></span>
                <span class="text-[12px] truncate">{r.adapterLabel}</span>
                <span class="mono text-[10px] text-bench-600 ml-auto shrink-0">{when(r.finishedAt ?? r.queuedAt)}</span>
              </header>
              <div class="bg-bench-950 min-h-[100px] grid place-items-center">
                {#if r.outputPath}
                  {@render media(modality, r.outputPath, r.prompt)}
                {:else if r.textPreview}
                  <pre class="w-full max-h-48 overflow-y-auto p-3 text-[11.5px] leading-relaxed whitespace-pre-wrap text-bench-100">{r.textPreview}</pre>
                {:else}
                  <span class="mono text-[11px] text-bench-600">{r.state}</span>
                {/if}
              </div>
              {#if r.prompt}
                <p class="px-2.5 py-1.5 text-[11px] text-bench-400 leading-snug" title={r.prompt}>{r.prompt}</p>
              {/if}
              <footer class="flex items-center gap-2 px-2.5 py-1.5 border-t border-bench-700 mono text-[10px]">
                <div class="flex-1"></div>
                {#if modality === 'image' && r.state === 'done' && r.outputPath}
                  <button class="text-signal hover:text-bench-100" title="Turn this image into a video"
                          onclick={() => animate(r.outputPath!)}>animate</button>
                {/if}
                {#if r.outputPath}
                  <button class="text-bench-500 hover:text-bench-100"
                          onclick={() => basic ? lab.saveMedia(r.outputPath!) : lab.reveal(r.outputPath!)}>{basic || isWeb ? 'save' : 'reveal'}</button>
                {/if}
                {#if !isWeb}<button class="text-bench-500 hover:text-fault"
                        onclick={async () => { await lab.deleteRun(r.dir); store.refreshUnfiled() }}>delete</button>{/if}
              </footer>
            </article>
          {/each}
        </div>
      </div>
    {:else}
      <div class="flex-1 overflow-y-auto min-h-0 px-4 py-4 space-y-3" bind:this={logEl}>
        {#if !chat || !chat.messages.length}
          <div class="h-full grid place-items-center text-center">
            <div class="max-w-sm">
              <p class="text-bench-400 text-[13px]">
                {chat ? 'Empty chat.' : 'New conversation.'}
              </p>
              <p class="text-bench-600 text-[12px] mt-1 leading-relaxed">
                {#if basic}Choose a style, describe your idea, and create. Use a result’s Edit or Animate action to keep working with that exact image.{:else}Pick a model below and send a prompt. Check several models to fan the same
                prompt out and compare. With context on, each message builds on the last —
                turn it off for a fresh one-off.{/if}
              </p>
            </div>
          </div>
        {:else}
          {#each chat.messages as m (m.id)}
            {#if m.role === 'user'}
              <div class="flex justify-end">
                <div class="max-w-[70%] rounded-xl rounded-br-sm bg-bench-700 px-3.5 py-2">
                  {#if modality === 'video' && chat.sourceImage && m.images?.includes(chat.sourceImage)}
                    <img src={fileUrl(chat.sourceImage)} alt="Video starting frame" class="mb-2 max-h-40 rounded" />
                  {/if}
                  <p class="text-[13px] leading-relaxed whitespace-pre-wrap">{m.text}</p>
                  <div class="flex items-center gap-2 mt-1 mono text-[9.5px] text-bench-400 justify-end">
                    {#if m.contextOn === false}<span title="Sent without conversation context">fresh</span>{/if}
                    {#if m.images?.length}<span>{m.images.length} img in</span>{/if}
                    <span>{when(m.at)}</span>
                  </div>
                </div>
              </div>
            {:else}
              {@const j = liveJob(m)}
              {@const state = j?.state ?? m.state}
              {@const outputPath = j?.outputPath ?? m.outputPath}
              {@const text = j?.text ?? m.textOut}
              {@const error = j?.error ?? m.error}
              {@const sourceImages = j?.images ?? m.images ?? []}
              {@const editing = modality === 'image' && !!outputPath && (basic ? basicFlow.draft('image').workflow === 'edit' && basicFlow.draft('image').sourceImage === outputPath : !store.images.image.length && store.imageEditSources[chat.id] === outputPath)}
              <div class="flex">
                <article class="max-w-[70%] min-w-[280px] rounded-xl rounded-bl-sm border
                                {editing ? 'border-signal' : 'border-bench-700'} bg-bench-850 overflow-hidden">
                  <header class="flex items-center gap-2 px-2.5 py-1.5 border-b border-bench-700">
                    <span class="size-1.5 rounded-full shrink-0
                      {state === 'running' ? 'bg-live animate-pulse'
                       : state === 'done' ? 'bg-live'
                       : state === 'error' ? 'bg-fault'
                       : state === 'queued' ? 'bg-signal' : 'bg-bench-600'}"></span>
                    <span class="text-[11.5px] text-bench-300 truncate">{m.adapterLabel}</span>
                    <span class="mono text-[10px] text-bench-600 ml-auto shrink-0">
                      {#if j?.startedAt && !j.finishedAt}running{:else if m.durationMs}{(m.durationMs / 1000).toFixed(1)}s{/if}
                    </span>
                  </header>

                  {#if modality === 'image' && sourceImages.length}
                    <div class="flex items-center gap-2 border-b border-bench-700 px-2.5 py-2 text-[11px] text-bench-300">
                      {#if sourceImages[0].startsWith(store.runsDir + '/')}
                        <img src={fileUrl(sourceImages[0])} alt="Submitted edit source"
                             class="h-12 w-12 rounded object-contain bg-bench-950" />
                      {/if}
                      <span>Source used for this edit{sourceImages.length > 1 ? ` (${sourceImages.length} images)` : ''}</span>
                    </div>
                  {/if}
                  <div class="bg-bench-950 min-h-[60px] grid place-items-center">
                    {#if state === 'done' && outputPath}
                      {@render media(modality, outputPath, m.adapterLabel ?? '')}
                    {:else if text}
                      <pre class="w-full max-h-96 overflow-y-auto p-3 text-[12px] leading-relaxed whitespace-pre-wrap text-bench-100">{text}</pre>
                    {:else if state === 'error'}
                      <pre class="w-full max-h-48 overflow-y-auto p-3 mono text-[10.5px] text-fault whitespace-pre-wrap">{error}</pre>
                    {:else if state === 'running'}
                      <span class="mono text-[11px] text-bench-400 py-4">generating…</span>
                    {:else}
                      <span class="mono text-[11px] text-bench-600 py-4">{state}</span>
                    {/if}
                  </div>

                  {#if m.director || j?.director}
                    {@const d = j?.director ?? m.director!}
                    <details class="px-3 py-2 border-t border-bench-700 text-[12px]">
                      <summary class="text-signal cursor-pointer">Prompt used · {d.preset}</summary>
                      <p class="mt-2 whitespace-pre-wrap">{m.effectivePrompt ?? j?.prompt ?? d.finalPrompt}</p>
                      <p class="mt-2 text-bench-400">Original: {d.originalPrompt}</p>
                      <p class="mt-2 text-bench-400">Director: {d.model} · {d.visionUsed ? 'reference pixels inspected' : 'text only'}</p>
                    </details>
                  {/if}
                  {#if m.requestSnapshot && state === 'done' && (modality === 'image' || modality === 'video')}
                    {@const recipe = m.requestSnapshot.basic}
                    {#if recipe}<details class="px-3 py-2 border-t border-bench-700 text-[11px]"><summary class="cursor-pointer text-bench-400">Settings used · {recipe.label}</summary><p class="mt-2">{recipe.workflow} · {recipe.quality} · version {recipe.version}</p><p>{m.adapterLabel}</p>{#if recipe.modifiers}<p>{recipe.modifiers.mood.name} · {recipe.modifiers.intensity.name}</p><p class="whitespace-pre-wrap">{[recipe.modifiers.mood.instructions,recipe.modifiers.intensity.instructions,...(modality==='video'?[recipe.modifiers.mood.motionInstructions,recipe.modifiers.intensity.motionInstructions]:[])].filter(Boolean).join('\n')}</p>{/if}</details>{/if}
                    <div class="flex flex-wrap gap-3 px-3 py-2 border-t border-bench-700 text-[11px] text-signal">
                      <button disabled={basicFlow.busy} onclick={() => basicFlow.send(modality, false, m)}>Make another</button>
                      {#if basic}<button onclick={() => basicFlow.advanced(m)}>Open in Advanced</button>{/if}
                      <button onclick={() => presetMessage = m}>Save as preset…</button>
                    </div>
                  {/if}
                  <footer class="flex flex-wrap items-center gap-2 px-2.5 py-1 mono text-[10px]">
                    {#if m.seed && !basic}<span class="text-bench-600">seed {m.seed}</span>{/if}
                    <div class="flex-1"></div>
                    {#if j && !basic && !isWeb}
                      <button class="text-bench-500 hover:text-bench-100"
                              onclick={() => showLog(m.id,j!.id)}>log</button>
                    {/if}
                    {#if modality === 'image' && outputPath && state === 'done'}
                      <button class="text-signal hover:text-bench-100" aria-pressed={editing}
                              title="Use this result as the source for your next edit"
                              onclick={() => editImage(outputPath)}>{editing ? 'selected for editing' : 'edit this image'}</button>
                      <button class="text-signal hover:text-bench-100" title="Turn this image into a video"
                              onclick={() => animate(outputPath)}>animate</button>
                    {/if}
                    {#if outputPath && state === 'done'}
                      <button class="text-bench-500 hover:text-bench-100"
                              onclick={() => basic ? lab.saveMedia(outputPath!) : lab.reveal(outputPath!)}>{basic || isWeb ? 'save' : 'reveal'}</button>
                    {/if}
                    {#if j && (state === 'running' || state === 'queued')}
                      <button class="text-fault hover:underline"
                              onclick={() => lab.cancel(j.id)}>cancel</button>
                    {/if}
                  </footer>

                  {#if openLog === m.id && j}
                    <pre class="max-h-56 overflow-y-auto bg-bench-950 border-t border-bench-700 p-2.5 mono text-[10px] text-bench-400 whitespace-pre-wrap">{logText}</pre>
                  {/if}
                </article>
              </div>
            {/if}
          {/each}
        {/if}
      </div>

      <!-- Composer -->
      {#if basic}<BasicComposer {modality} />{:else}
        {@render advancedComposer()}
      {/if}
    {/if}
  </main>

  <!-- Model settings -->
  {#if !basic}
  <aside class:mobile-open={mobilePanel === 'settings'} class="settings-sidebar w-[280px] shrink-0 border-l border-bench-700 bg-bench-850 overflow-y-auto">
    <ParamPanel {modality} />
  </aside>
  {/if}
</div>
{/if}

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') menu = null }} />

{#if menu}
  {@const m = menu}
  <!-- Backdrop swallows the next click (or right-click) anywhere, matching
       ModelDropdown's dismissal behaviour. -->
  <button class="fixed inset-0 z-40 cursor-default" aria-label="Close menu"
          onclick={() => (menu = null)}
          oncontextmenu={(e) => { e.preventDefault(); menu = null }}></button>

  <div class="fixed z-50 w-[228px] rounded-lg border border-bench-600 bg-bench-850
              p-1 shadow-xl shadow-black/50"
       style="left: {m.x}px; top: {m.y}px">
    <div class="px-2 py-1 mono text-[10px] text-bench-600 truncate" title={m.title}>{m.title}</div>
    <button
      class="w-full text-left rounded px-2 py-1.5 text-[12px] text-bench-300
             hover:bg-bench-800 hover:text-fault transition-colors"
      onclick={() => removeChat(m.id)}
    >
      Delete conversation
      <span class="block text-[10px] text-bench-600 leading-snug mt-0.5">
        Generations are kept — they move to Earlier runs.
      </span>
    </button>
  </div>
{/if}

{#snippet media(m: Modality, path: string, alt: string)}
  {#if m === 'image'}
    <img src={fileUrl(path)} {alt} loading="lazy" class="w-full h-auto block" />
  {:else if m === 'video'}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video src={fileUrl(path)} playsinline controls preload="metadata" class="w-full block"></video>
  {:else if m === 'music'}
    <audio src={fileUrl(path)} controls preload="metadata" class="w-full p-3"></audio>
  {:else}
    <span class="mono text-[11px] text-bench-600">{path}</span>
  {/if}
{/snippet}

{#if animationSource}
  <AnimateImage image={animationSource} onDismiss={() => (animationSource = null)} {onNavigate} />
{/if}

{#if presetMessage?.requestSnapshot}
  {@const request = presetMessage.requestSnapshot}
  <PresetEditor moodId={request.basic?.style} intensityId={request.basic?.intensity} directorId={basicFlow.catalog.presets.find((p) => p.id === request.basic?.presetId)?.director ?? (request.basic?.adult ? 'adult' : undefined)} adapterId={request.adapterIds[0]} params={request.params[request.adapterIds[0]]} thumbnail={modality === 'image' ? presetMessage.outputPath : request.images?.[0]} onDismiss={() => presetMessage = undefined} />
{/if}
