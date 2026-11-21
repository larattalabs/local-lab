<script lang="ts">
  import { ArrowUp, FolderOpen, Plus, Square, Trash2, LoaderCircle, RefreshCw, Paperclip, X, GitCompare, Shrink, Settings2, CornerDownRight } from '@lucide/svelte'
  import { onMount, tick } from 'svelte'
  import type { CodeApprovalMode, CodeBackend, CodeHarness, CodeModel, CodeThinking } from '@shared/code'
  import { fileUrl } from '../../api'
  import { code, codeApi } from '../../code/store.svelte'
  import CodeItem from './CodeItem.svelte'
  import ChangesPanel from './ChangesPanel.svelte'
  import CodeSettingsDialog from './CodeSettingsDialog.svelte'

  const BACKEND_LABEL: Record<CodeBackend, string> = {
    omlx: 'oMLX', ollama: 'Ollama', ds4: 'DwarfStar', 'ds4-ablit': 'DwarfStar abliterated', 'ds4-v41': 'DwarfStar V4.1 (SSD streaming)',
  }
  const MODES: { id: CodeApprovalMode; label: string; hint: string }[] = [
    { id: 'ask', label: 'Ask before edits', hint: 'Reads run freely; file edits and commands wait for you.' },
    { id: 'edit', label: 'Auto-accept edits', hint: 'Reads and edits run freely; commands wait for you.' },
    { id: 'auto', label: 'Full auto', hint: 'Everything runs without asking. Use in folders you can restore.' },
  ]

  let text = $state('')
  let scroller: HTMLDivElement | undefined = $state()
  let input: HTMLTextAreaElement | undefined = $state()
  let renaming = $state(false)
  let titleDraft = $state('')
  let dragging = $state(false)
  let slashIndex = $state(0)

  onMount(() => { void code.init() })

  const harness = $derived<CodeHarness>(code.session?.harness ?? code.draft.harness)
  const modelId = $derived(code.session?.modelId ?? code.draft.modelId)
  const mode = $derived<CodeApprovalMode>(code.session?.mode ?? code.draft.mode)
  const leanTools = $derived(code.session?.leanTools ?? code.draft.leanTools)
  const thinking = $derived<CodeThinking>(code.session?.thinking ?? code.draft.thinking ?? 'default')
  const agent = $derived(code.session?.agent ?? code.draft.agent ?? 'build')
  const cwd = $derived(code.session?.cwd ?? code.draft.cwd)
  const model = $derived(code.model(modelId))
  const thinkingOptions = $derived<{ id: CodeThinking; label: string }[]>(
    model?.thinking === 'toggle' ? [{ id: 'default', label: 'Thinking: default' }, { id: 'on', label: 'Thinking: on' }, { id: 'off', label: 'Thinking: off' }]
    : model?.thinking === 'effort' ? [{ id: 'default', label: 'Thinking: default' }, { id: 'off', label: 'Thinking: off' }, { id: 'low', label: 'Thinking: low' }, { id: 'medium', label: 'Thinking: medium' }, { id: 'high', label: 'Thinking: high' }]
    : [])
  const groups = $derived.by(() => {
    const g = new Map<CodeBackend, CodeModel[]>()
    for (const m of code.models) (g.get(m.backend) ?? g.set(m.backend, []).get(m.backend)!).push(m)
    return [...g.entries()]
  })
  const folders = $derived.by(() => {
    const g = new Map<string, typeof code.sessions>()
    for (const s of code.sessions) (g.get(s.cwd) ?? g.set(s.cwd, []).get(s.cwd)!).push(s)
    return [...g.entries()]
  })
  const busy = $derived(['backend', 'running', 'approval'].includes(code.status.state))
  const ctx = $derived(code.transcript.context)
  const ctxPct = $derived(ctx && ctx.window ? Math.min(100, Math.round((ctx.tokens / ctx.window) * 100)) : 0)
  const kTok = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}K` : String(n))
  const slashQuery = $derived(/^\/[\w:-]*$/.test(text) ? text.slice(1).toLowerCase() : null)
  const slashMatches = $derived(slashQuery === null ? [] : code.commands.filter((c) => c.name.toLowerCase().startsWith(slashQuery)).slice(0, 8))

  $effect(() => { if (code.ready && harness === 'opencode' && !code.agents.length) void code.loadAgents() })

  // Keep the newest output in view unless the user scrolled up to read.
  let pinned = true
  function onScroll() {
    if (!scroller) return
    pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80
  }
  $effect(() => {
    void code.transcript.items.length
    void code.transcript.items.at(-1)
    if (pinned) void tick().then(() => scroller?.scrollTo({ top: scroller.scrollHeight }))
  })

  async function submit(delivery?: 'queue' | 'steer') {
    const msg = text
    if (!msg.trim() || code.sending) return
    text = ''
    pinned = true
    await code.send(msg, delivery)
    if (code.error) text = text || msg
  }
  function pickSlash(name: string) { text = `/${name} `; slashIndex = 0; input?.focus() }
  function keydown(e: KeyboardEvent) {
    if (slashMatches.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); slashIndex = (slashIndex + 1) % slashMatches.length; return }
      if (e.key === 'ArrowUp') { e.preventDefault(); slashIndex = (slashIndex + slashMatches.length - 1) % slashMatches.length; return }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); pickSlash(slashMatches[Math.min(slashIndex, slashMatches.length - 1)].name); return }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      void submit(busy ? (e.metaKey || e.ctrlKey ? 'steer' : 'queue') : undefined)
    }
  }
  function onPaste(e: ClipboardEvent) {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
    if (!files.length) return
    e.preventDefault()
    if (!model?.vision) { code.error = 'This model cannot see images. Pick a vision model to attach them.'; return }
    void code.attachFiles(files)
  }
  function onDrop(e: DragEvent) {
    dragging = false
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'))
    if (!files.length) return
    e.preventDefault()
    if (!model?.vision) { code.error = 'This model cannot see images. Pick a vision model to attach them.'; return }
    void code.attachFiles(files)
  }
  function startRename() { if (!code.session) return; titleDraft = code.session.title; renaming = true }
  async function finishRename(save: boolean) { renaming = false; if (save) await code.rename(titleDraft) }
  const short = (p: string) => p.replace(/^\/Users\/[^/]+/, '~')
  /** Keep the end of a long path (the folder name is the useful part). */
  const tail = (p: string, n = 52) => { const s = short(p); return s.length > n ? '…' + s.slice(s.length - n + 1) : s }
  const ago = (t: number) => {
    const s = (Date.now() - t) / 1000
    return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`
  }
  const modelOption = (m: CodeModel) => `${m.label} · ${m.ramGB ? m.ramGB + ' GB' : '?'}${m.uncensored ? ' · uncensored' : ''}${m.vision ? ' · vision' : ''}${m.slow ? ' · slow' : ''}`
  const statusText = $derived(
    code.status.state === 'backend' ? code.status.detail
    : code.status.state === 'running' ? (code.status.detail ?? 'Working… Enter queues a message for after this turn; ⌘Enter steers it now.')
    : code.status.state === 'approval' ? 'Waiting for your approval'
    : code.status.state === 'error' ? code.status.detail : '')
</script>

<div class="code-layout flex-1 min-h-0 flex">
  <aside class="sidebar">
    <div class="side-top">
      <button class="new" onclick={() => { code.newSession(); input?.focus() }}><Plus size={14} /> New session</button>
      <button class="gear" title="Code settings: models, harnesses, servers" aria-label="Code settings" onclick={() => code.settingsOpen = true}><Settings2 size={15} /></button>
    </div>
    <div class="list">
      {#each folders as [folder, list] (folder)}
        <div class="folder mono" title={folder}>{tail(folder, 36)}</div>
        {#each list as s (s.id)}
          <div class="row" class:active={s.id === code.activeId}>
            <button class="pick" onclick={() => code.select(s.id)} title={s.title}>
              <span class="dot {s.status.state}"></span>
              <span class="t">{s.title}</span>
              <span class="when mono">{s.harness === 'omp' ? 'omp' : 'oc'} · {ago(s.updatedAt)}</span>
            </button>
            <button class="del" title="Delete session" aria-label="Delete session" onclick={() => code.remove(s.id)}><Trash2 size={12} /></button>
          </div>
        {/each}
      {:else}
        <p class="empty">Sessions you start appear here, grouped by folder.</p>
      {/each}
    </div>
    <div class="backends mono">
      <div class="bk-title">Model servers <button title="Refresh" aria-label="Refresh model servers" onclick={() => { void code.refreshBackends(); void code.refreshCatalog() }}><RefreshCw size={11} /></button></div>
      {#each Object.keys(BACKEND_LABEL) as b}
        {@const up = code.backends.up.includes(b as CodeBackend)}
        <div class="bk"><span class="dot {up ? 'running' : ''}"></span>{BACKEND_LABEL[b as CodeBackend]}
          {#if up}<button class="bk-stop" disabled={code.stoppingBackend !== null} title={b === 'ollama' ? 'Unload Ollama models to free memory' : 'Stop this server to free memory'} onclick={() => code.stopBackend(b as CodeBackend)}>{code.stoppingBackend === b ? 'stopping…' : b === 'ollama' ? 'unload' : 'stop'}</button>{/if}
        </div>
      {/each}
    </div>
  </aside>

  <main class="flex-1 min-w-0 flex flex-col">
    <header class="top">
      {#if renaming}
        <!-- svelte-ignore a11y_autofocus -->
        <input class="title-input" bind:value={titleDraft} autofocus onblur={() => finishRename(true)}
          onkeydown={(e) => { if (e.key === 'Enter') finishRename(true); if (e.key === 'Escape') finishRename(false) }} />
      {:else}
        <button class="title" title={code.session ? 'Rename' : ''} ondblclick={startRename} onclick={() => { if (code.session) startRename() }}>{code.session?.title ?? 'New session'}</button>
      {/if}
      {#if cwd}<button class="cwd mono" title={`${cwd} — open in Finder`} onclick={() => codeApi().reveal(cwd)}>{tail(cwd)}</button>{/if}
      <div class="flex-1"></div>
      {#if ctx}
        <div class="ctx mono" title={`Context: ${ctx.tokens.toLocaleString()} of ${ctx.window.toLocaleString()} tokens`}>
          <div class="ctx-bar"><div class="ctx-fill" class:warn={ctxPct >= 75} style:width={`${ctxPct}%`}></div></div>
          {kTok(ctx.tokens)} / {kTok(ctx.window)}
        </div>
      {/if}
      {#if code.session}
        <button class="tool-btn mono" title="Summarize the conversation now to free context" disabled={busy} onclick={() => code.compact()}><Shrink size={13} /> Compact</button>
        <button class="tool-btn mono" class:on={code.changesOpen} title="Uncommitted changes in this folder (git)" onclick={() => code.toggleChanges()}>
          <GitCompare size={13} /> Changes{#if code.changes?.files.length}<span class="badge">{code.changes.files.length}</span>{/if}
        </button>
      {/if}
    </header>

    <div class="body">
      <div class="convo">
        <div class="scroll" bind:this={scroller} onscroll={onScroll}>
          <div class="feed">
            {#if !code.ready}
              <div class="placeholder">{code.error || 'Loading…'}</div>
            {:else if !code.activeId}
              <div class="start">
                <h2>Code with a local model</h2>
                <p>Pick a folder and a model, then describe the change. The agent reads, edits and runs commands in that folder through {harness === 'omp' ? 'omp (Oh My Pi)' : 'opencode'}; only one model server runs at a time, and Local Lab stops the others first.</p>
                <div class="setup">
                  <span class="lbl">Folder</span>
                  <button class="folder-pick mono" onclick={() => code.pickFolder()}><FolderOpen size={14} /><span class="fp" title={code.draft.cwd}>{code.draft.cwd ? tail(code.draft.cwd, 64) : 'Choose a folder…'}</span></button>
                  <span class="lbl">Harness</span>
                  <div class="seg">
                    {#each ['omp', 'opencode'] as h}
                      <button aria-pressed={code.draft.harness === h} disabled={!code.harnesses[h as CodeHarness]} onclick={() => { code.draft.harness = h as CodeHarness; code.savePrefs() }}>{h === 'omp' ? 'omp' : 'opencode'}</button>
                    {/each}
                  </div>
                </div>
              </div>
            {:else}
              {#each code.transcript.items as item, i (item.id)}
                <CodeItem {item} last={i === code.transcript.items.length - 1} />
              {/each}
            {/if}
          </div>
        </div>

        <div class="composer-wrap">
          {#if statusText || code.error}
            <div class="status mono" class:err={code.status.state === 'error' || !!code.error}>
              {#if busy}<LoaderCircle size={12} class="spin" />{/if}
              <span>{code.error || statusText}</span>
              {#if code.transcript.usage}<span class="usage">{code.transcript.usage.input.toLocaleString()} in · {code.transcript.usage.output.toLocaleString()} out</span>{/if}
            </div>
          {/if}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="composer-box" class:dragging ondragover={(e) => { e.preventDefault(); dragging = true }} ondragleave={() => dragging = false} ondrop={onDrop}>
            {#if slashMatches.length}
              <div class="slash mono" role="listbox">
                {#each slashMatches as c, i}
                  <button role="option" aria-selected={i === slashIndex} class:sel={i === slashIndex} onmousedown={(e) => { e.preventDefault(); pickSlash(c.name) }}>
                    <span class="sn">/{c.name}</span><span class="sd">{c.description ?? ''}</span>
                  </button>
                {/each}
              </div>
            {/if}
            {#if code.attachments.length}
              <div class="atts">
                {#each code.attachments as a (a)}
                  <div class="att"><img src={fileUrl(a)} alt="attachment" /><button aria-label="Remove attachment" onclick={() => code.attachments = code.attachments.filter((x) => x !== a)}><X size={11} /></button></div>
                {/each}
              </div>
            {/if}
            <textarea bind:this={input} bind:value={text} onkeydown={keydown} onpaste={onPaste} rows="3"
              placeholder={busy ? 'Queue a message for after this turn (⌘Enter to steer now)…' : code.activeId ? 'Reply, ask for the next change, or type / for commands…' : 'Describe what you want built or changed…'}></textarea>
            <div class="controls">
              <select class="mono" title={model?.note} value={modelId} disabled={busy} onchange={(e) => code.configure({ modelId: (e.currentTarget as HTMLSelectElement).value })}>
                {#each groups as [backend, list]}
                  <optgroup label={BACKEND_LABEL[backend]}>
                    {#each list as m}<option value={m.id}>{modelOption(m)}</option>{/each}
                  </optgroup>
                {/each}
              </select>
              {#if thinkingOptions.length}
                <select class="mono" value={thinking} disabled={busy} title="Reasoning before answering. Off is faster; on is better for harder changes." onchange={(e) => code.configure({ thinking: (e.currentTarget as HTMLSelectElement).value as CodeThinking })}>
                  {#each thinkingOptions as t}<option value={t.id}>{t.label}</option>{/each}
                </select>
              {/if}
              <select class="mono" value={mode} disabled={busy} title={MODES.find((m) => m.id === mode)?.hint} onchange={(e) => code.configure({ mode: (e.currentTarget as HTMLSelectElement).value as CodeApprovalMode })}>
                {#each MODES as m}<option value={m.id}>{m.label}</option>{/each}
              </select>
              {#if harness === 'opencode' && code.agents.length}
                <select class="mono" value={agent} disabled={busy} title={code.agents.find((a) => a.id === agent)?.description ?? 'opencode agent'} onchange={(e) => code.configure({ agent: (e.currentTarget as HTMLSelectElement).value })}>
                  {#each code.agents as a}<option value={a.id}>Agent: {a.id}</option>{/each}
                </select>
              {/if}
              {#if harness === 'omp'}
                <label class="lean mono" title={`Lean tool set: ${code.settings.ompTools.join(', ')} (Settings → Harnesses). The full set adds ~18K prompt tokens per turn.`}>
                  <input type="checkbox" checked={leanTools} disabled={busy} onchange={(e) => code.configure({ leanTools: (e.currentTarget as HTMLInputElement).checked })} /> lean tools
                </label>
              {/if}
              {#if model?.vision}
                <button class="icon" title="Attach images (or paste / drop them)" aria-label="Attach images" onclick={() => code.pickAttachments()}><Paperclip size={14} /></button>
              {/if}
              <div class="flex-1"></div>
              {#if model?.note && !busy}<span class="note">{model.note}</span>{/if}
              {#if busy}
                {#if text.trim()}
                  <button class="send steer" title="Steer: deliver now, mid-turn (⌘Enter)" aria-label="Steer now" onclick={() => submit('steer')}><CornerDownRight size={14} /></button>
                  <button class="send" title="Queue for after this turn (Enter)" aria-label="Queue message" onclick={() => submit('queue')}><ArrowUp size={15} /></button>
                {/if}
                <button class="send stop" title="Stop" aria-label="Stop" onclick={() => code.stop()}><Square size={13} /></button>
              {:else}
                <button class="send" title="Send (Enter)" aria-label="Send" disabled={!text.trim() || code.sending} onclick={() => submit()}><ArrowUp size={15} /></button>
              {/if}
            </div>
          </div>
        </div>
      </div>
      {#if code.changesOpen && code.session}<ChangesPanel />{/if}
    </div>
  </main>
</div>

{#if code.settingsOpen}<CodeSettingsDialog onDismiss={() => code.settingsOpen = false} />{/if}

<style>
  .side-top { display: flex; align-items: center; gap: 6px; margin: 12px; }
  .side-top .new { margin: 0; flex: 1; }
  .gear { padding: 7px; border-radius: 8px; color: #97a3b4; border: 1px solid #2a323d; }
  .gear:hover { background: #161a20; color: #dfe5ec; }
  .title { text-align: left; }
  .title:hover { color: #f1d69b; }
  .title-input { font-weight: 600; font-size: 13px; background: #11151a; border: 1px solid #4a5462; border-radius: 5px; padding: 2px 6px; color: #dfe5ec; width: 40%; }
  .ctx { display: flex; align-items: center; gap: 6px; font-size: 10.5px; color: #8d99a8; }
  .ctx-bar { width: 60px; height: 5px; border-radius: 3px; background: #222831; overflow: hidden; }
  .ctx-fill { height: 100%; background: #7fb069; } .ctx-fill.warn { background: #d8a657; }
  .tool-btn { display: flex; align-items: center; gap: 5px; font-size: 11px; color: #97a3b4; border: 1px solid #2a323d; border-radius: 6px; padding: 3px 8px; }
  .tool-btn:hover:not(:disabled), .tool-btn.on { color: #dfe5ec; background: #161a20; }
  .tool-btn:disabled { opacity: .45; }
  .badge { background: #343027; color: #f1d69b; border-radius: 8px; padding: 0 5px; font-size: 10px; }
  .body { flex: 1; min-height: 0; display: flex; }
  .convo { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .composer-box { position: relative; }
  .composer-box.dragging { border-color: #d8a657; }
  .slash { position: absolute; bottom: calc(100% + 6px); left: 0; right: 0; background: #11151a; border: 1px solid #2a323d; border-radius: 10px; padding: 4px; max-height: 260px; overflow: auto; z-index: 5; box-shadow: 0 10px 30px #0008; }
  .slash button { width: 100%; display: flex; gap: 10px; text-align: left; padding: 5px 8px; border-radius: 6px; font-size: 11.5px; }
  .slash button.sel, .slash button:hover { background: #1c222b; }
  .sn { color: #d8a657; flex-shrink: 0; } .sd { color: #8d99a8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .atts { display: flex; gap: 8px; padding: 10px 12px 0; flex-wrap: wrap; }
  .att { position: relative; width: 56px; height: 56px; border-radius: 8px; overflow: hidden; border: 1px solid #2a323d; }
  .att img { width: 100%; height: 100%; object-fit: cover; }
  .att button { position: absolute; top: 2px; right: 2px; background: #000a; border-radius: 50%; padding: 2px; color: #fff; }
  .icon { padding: 4px; color: #8d99a8; border-radius: 6px; } .icon:hover { color: #dfe5ec; background: #161a20; }
  .send.steer { background: #2a3a2a; color: #a6d18f; }
  .sidebar { width: 264px; flex-shrink: 0; display: flex; flex-direction: column; border-right: 1px solid #1a1f27; background: #090b0e; }
  .new { display: flex; align-items: center; gap: 6px; margin: 12px; padding: 7px 10px; border: 1px solid #2a323d; border-radius: 8px; color: #dfe5ec; font-size: 12.5px; }
  .new:hover { background: #161a20; }
  .list { flex: 1; overflow: auto; padding: 0 6px 12px; }
  .folder { font-size: 10.5px; color: #6b7787; padding: 12px 8px 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row { display: flex; align-items: center; border-radius: 6px; }
  .row:hover, .row.active { background: #161a20; }
  .pick { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; padding: 6px 8px; text-align: left; }
  .pick .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; color: #c3ccd7; }
  .row.active .t { color: #f1f4f8; }
  .when { font-size: 10px; color: #6b7787; }
  .del { opacity: 0; padding: 4px 6px; color: #8d99a8; }
  .row:hover .del { opacity: 1; } .del:hover { color: #e08583; }
  .empty { font-size: 12px; color: #6b7787; padding: 8px 10px; line-height: 1.5; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #333c48; flex-shrink: 0; }
  .dot.running, .dot.backend { background: #7fb069; box-shadow: 0 0 6px #7fb06988; }
  .dot.approval { background: #d8a657; } .dot.error { background: #d16a68; }
  .backends { border-top: 1px solid #1a1f27; padding: 10px 14px 12px; font-size: 10.5px; color: #8d99a8; display: grid; gap: 4px; }
  .bk-title { display: flex; justify-content: space-between; text-transform: uppercase; letter-spacing: .06em; color: #6b7787; margin-bottom: 2px; }
  .bk { display: flex; align-items: center; gap: 7px; }
  .bk-stop { margin-left: auto; font-size: 10px; color: #8d99a8; border: 1px solid #2a323d; border-radius: 4px; padding: 0 6px; }
  .bk-stop:hover { color: #e08583; border-color: #5a2f2f; }
  .top { height: 44px; flex-shrink: 0; display: flex; align-items: center; gap: 10px; padding: 0 18px; border-bottom: 1px solid #1a1f27; }
  .title { font-weight: 600; font-size: 13px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; max-width: 40%; }
  .cwd { font-size: 11px; color: #97a3b4; border: 1px solid #2a323d; border-radius: 5px; padding: 2px 7px; min-width: 0; max-width: 45%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .meta { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .cwd:hover { color: #dfe5ec; }
  .meta { font-size: 11px; color: #6b7787; }
  .scroll { flex: 1; min-height: 0; overflow: auto; }
  .feed { max-width: 860px; margin: 0 auto; padding: 22px 24px 28px; display: flex; flex-direction: column; gap: 12px; }
  .placeholder { color: #6b7787; text-align: center; margin-top: 30vh; }
  .start { margin-top: 12vh; }
  .start h2 { font-size: 20px; font-weight: 600; margin-bottom: 8px; }
  .start p { color: #97a3b4; line-height: 1.6; max-width: 620px; margin-bottom: 20px; }
  .setup { display: grid; grid-template-columns: 80px 1fr; gap: 10px 14px; align-items: center; max-width: 620px; }
  .setup .lbl { font-size: 12px; color: #8d99a8; }
  .folder-pick { display: flex; align-items: center; gap: 8px; border: 1px solid #2a323d; border-radius: 8px; padding: 7px 10px; font-size: 12px; color: #dfe5ec; justify-self: start; max-width: 100%; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .folder-pick :global(svg) { flex-shrink: 0; }
  .fp { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .folder-pick:hover { background: #161a20; }
  .seg { display: flex; gap: 2px; border: 1px solid #2a323d; border-radius: 8px; padding: 2px; justify-self: start; }
  .seg button { font-size: 12px; padding: 5px 12px; border-radius: 6px; color: #9ba7b8; }
  .seg button[aria-pressed='true'] { background: #343027; color: #f1d69b; }
  .seg button:disabled { opacity: .4; }
  .composer-wrap { flex-shrink: 0; padding: 0 24px 16px; max-width: 908px; width: 100%; margin: 0 auto; }
  .status { display: flex; align-items: center; gap: 7px; font-size: 11px; color: #97a3b4; padding: 0 4px 7px; }
  .status.err { color: #e08583; }
  .usage { margin-left: auto; color: #6b7787; }
  .composer-box { border: 1px solid #2a323d; border-radius: 12px; background: #11151a; }
  .composer-box:focus-within { border-color: #4a5462; }
  textarea { width: 100%; resize: none; background: transparent; padding: 12px 14px 4px; outline: none; line-height: 1.5; color: #dfe5ec; max-height: 40vh; }
  textarea::placeholder { color: #6b7787; }
  .controls { display: flex; align-items: center; gap: 8px; padding: 6px 8px 8px 10px; }
  select { background: #161a20; border: 1px solid #2a323d; border-radius: 6px; font-size: 11px; padding: 4px 6px; color: #c3ccd7; max-width: 300px; }
  .lean { display: flex; align-items: center; gap: 5px; font-size: 11px; color: #8d99a8; white-space: nowrap; flex-shrink: 0; }
  .note { font-size: 11px; color: #6b7787; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; min-width: 0; }
  .send { width: 30px; height: 30px; flex-shrink: 0; border-radius: 8px; display: grid; place-items: center; background: #d8a657; color: #17130b; }
  .send:disabled { background: #2a323d; color: #6b7787; }
  .send.stop { background: #39424e; color: #f1f4f8; }
</style>
