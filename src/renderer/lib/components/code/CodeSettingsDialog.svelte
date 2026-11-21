<script lang="ts">
  import { X, LoaderCircle, Check, Trash2, Search } from '@lucide/svelte'
  import { onMount } from 'svelte'
  import { ALL_OMP_TOOLS, DEFAULT_OMP_TOOLS, type CodeBackend, type CodeCatalogEntry, type CodeCheckResult, type CodeDiscovered, type CodeModel, type CodeServerSettings } from '@shared/code'
  import { code, codeApi, errText } from '../../code/store.svelte'

  let { onDismiss }: { onDismiss: () => void } = $props()
  type Tab = 'models' | 'harnesses' | 'servers'
  let tab = $state<Tab>('models')
  let error = $state('')
  let notice = $state('')

  const BACKENDS: { id: CodeBackend; label: string }[] = [
    { id: 'omlx', label: 'oMLX' }, { id: 'ollama', label: 'Ollama' }, { id: 'ds4', label: 'DwarfStar (:8000)' },
    { id: 'ds4-ablit', label: 'DwarfStar abliterated (:8002)' }, { id: 'ds4-v41', label: 'DwarfStar V4.1 (:8003)' },
  ]

  // ---- Models ---------------------------------------------------------------------------------
  let discovered = $state<CodeDiscovered[] | null>(null)
  let discovering = $state(false)
  let checking = $state<string | null>(null)
  let checkLine = $state('')
  let results = $state<Record<string, CodeCheckResult>>({})
  let manual = $state<{ backend: CodeBackend; model: string }>({ backend: 'omlx', model: '' })

  async function discover() {
    discovering = true; error = ''
    try { discovered = await codeApi().discover() } catch (e) { error = errText(e) } finally { discovering = false }
  }

  function entryOf(m: CodeModel): CodeCatalogEntry {
    return { backend: m.backend, model: m.model, label: m.label, note: m.note, ramGB: m.ramGB, contextWindow: m.contextWindow,
      maxOutput: m.maxOutput, reasoning: m.reasoning, uncensored: m.uncensored, vision: m.vision, slow: m.slow }
  }

  async function save(entry: CodeCatalogEntry) {
    error = ''
    try { const r = await codeApi().saveModel(entry); code.models = r.models } catch (e) { error = errText(e) }
  }

  async function remove(m: CodeModel) {
    error = ''
    try { const r = await codeApi().removeModel(m.id); code.models = r.models; if (discovered) void discover() } catch (e) { error = errText(e) }
  }

  /** Bring the server up, run the tool-call check, and add the model when it passes (or when forced). */
  async function checkAndAdd(backend: CodeBackend, model: string, contextWindow?: number, force = false) {
    const key = `${backend}/${model}`
    error = ''; notice = ''
    if (!force) {
      checking = key; checkLine = 'Starting…'
      const off = codeApi().onCheckStatus((l) => checkLine = l)
      try { results = { ...results, [key]: await codeApi().checkModel(backend, model) } } catch (e) { error = errText(e); return } finally { off(); checking = null }
      if (!results[key].ok) return
    }
    await save({ backend, model, label: model.split('/').pop()?.replace(/:.*$/, '') ?? model, contextWindow: contextWindow ?? 32768,
      note: force ? 'Added without a passing tool-call check.' : `Tool calls checked ${new Date().toLocaleDateString()}.` })
    notice = `Added ${model}. Set its flags (reasoning, vision, uncensored) and memory size in the list above.`
    if (discovered) void discover()
  }

  // ---- Harnesses -----------------------------------------------------------------------------
  let tools = $state<string[]>([...code.settings.ompTools])
  let extra = $state(code.settings.appendSystemPrompt)
  let savedHarness = $state(false)
  async function saveHarness() {
    error = ''; savedHarness = false
    try { await code.saveSettings({ ompTools: tools, appendSystemPrompt: extra }); savedHarness = true } catch (e) { error = errText(e) }
  }

  // ---- Servers -------------------------------------------------------------------------------
  let servers = $state<CodeServerSettings | null>(null)
  let caps = $state<Record<string, string>>({})
  let idle = $state(String(code.settings.idleUnloadMinutes))
  let savingCap = $state<string | null>(null)
  async function loadServers() {
    try {
      servers = await codeApi().serverSettings()
      caps = Object.fromEntries(servers.omlx.map((m) => [m.model, m.maxContext ? String(m.maxContext) : '']))
    } catch (e) { error = errText(e) }
  }
  async function saveCap(model: string) {
    error = ''; notice = ''; savingCap = model
    const v = caps[model].trim()
    try {
      servers = await codeApi().setOmlxContext(model, v ? Number(v) : null)
      await code.refreshCatalog()
      notice = `Saved. oMLX restarts with the new limit on its next request; the Code catalog and omp's models.yml were updated to match.`
    } catch (e) { error = errText(e) } finally { savingCap = null }
  }
  async function saveIdle() {
    error = ''
    try { await code.saveSettings({ idleUnloadMinutes: Number(idle) || 0 }); notice = 'Saved.' } catch (e) { error = errText(e) }
  }

  onMount(() => { void loadServers(); void code.refreshCatalog() })
  const fmt = (n?: number | null) => (n ? (n >= 1024 ? `${Math.round(n / 1024)}K` : String(n)) : '—')
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="shade" onclick={onDismiss}></div>
<div class="dialog" role="dialog" aria-label="Code settings">
  <header>
    <h2>Code settings</h2>
    <nav>
      {#each [['models', 'Models'], ['harnesses', 'Harnesses'], ['servers', 'Servers']] as [id, label]}
        <button aria-pressed={tab === id} onclick={() => { tab = id as Tab; error = ''; notice = '' }}>{label}</button>
      {/each}
    </nav>
    <button class="close" aria-label="Close" onclick={onDismiss}><X size={16} /></button>
  </header>

  <div class="content">
    {#if error}<p class="msg err">{error}</p>{/if}
    {#if notice}<p class="msg ok">{notice}</p>{/if}

    {#if tab === 'models'}
      <p class="lead">Models offered in the Code tab. Each one should pass a tool-call check through its server; a model that can't call tools can't edit files or run commands. The list is stored privately in <code>~/AI/local-lab-private/code-models.json</code>.</p>
      <table class="cat">
        <thead><tr><th>Name</th><th>Model</th><th>Context</th><th>GB</th><th title="Thinking model">Think</th><th>Vision</th><th>Uncens.</th><th></th></tr></thead>
        <tbody>
          {#each code.models as m (m.id)}
            {@const e = entryOf(m)}
            <tr>
              <td><input class="name" value={m.label} onchange={(ev) => save({ ...e, label: (ev.currentTarget as HTMLInputElement).value })} /></td>
              <td class="mono id" title={m.id}><span class="be">{m.backend}</span> {m.model}</td>
              <td><input class="num mono" type="number" min="2048" step="1024" value={m.contextWindow} onchange={(ev) => save({ ...e, contextWindow: Number((ev.currentTarget as HTMLInputElement).value) })} /></td>
              <td><input class="num small mono" type="number" min="0" value={m.ramGB} onchange={(ev) => save({ ...e, ramGB: Number((ev.currentTarget as HTMLInputElement).value) })} /></td>
              <td><input type="checkbox" checked={m.reasoning} onchange={(ev) => save({ ...e, reasoning: (ev.currentTarget as HTMLInputElement).checked })} /></td>
              <td><input type="checkbox" checked={m.vision} onchange={(ev) => save({ ...e, vision: (ev.currentTarget as HTMLInputElement).checked })} /></td>
              <td><input type="checkbox" checked={m.uncensored} onchange={(ev) => save({ ...e, uncensored: (ev.currentTarget as HTMLInputElement).checked })} /></td>
              <td><button class="del" title="Remove from the Code tab" aria-label="Remove model" onclick={() => remove(m)}><Trash2 size={13} /></button></td>
            </tr>
          {/each}
        </tbody>
      </table>

      <h3>Add models</h3>
      <div class="row">
        <button class="btn" onclick={discover} disabled={discovering}>{#if discovering}<LoaderCircle size={13} class="spin" />{:else}<Search size={13} />{/if} Find models on Ollama and oMLX</button>
        <span class="hint">A check loads the model, stopping other model servers first.</span>
      </div>
      {#if discovered}
        {@const fresh = discovered.filter((d) => !d.inCatalog)}
        {#if !fresh.length}<p class="hint">Every model those servers report is already in the list.</p>{/if}
        {#each fresh as d (d.backend + d.model)}
          {@const key = `${d.backend}/${d.model}`}
          <div class="disc">
            <span class="mono be">{d.backend}</span>
            <span class="mono dm" title={d.model}>{d.model}</span>
            <span class="mono ctxv">{fmt(d.contextWindow)}</span>
            {#if checking === key}
              <span class="checking mono"><LoaderCircle size={12} class="spin" /> {checkLine}</span>
            {:else if results[key] && !results[key].ok}
              <span class="fail" title={results[key].detail}>No tool call ({results[key].seconds}s)</span>
              <button class="btn small ghost" onclick={() => checkAndAdd(d.backend, d.model, d.contextWindow, true)}>Add anyway</button>
            {:else if results[key]?.ok}
              <span class="pass"><Check size={12} /> {results[key].seconds}s</span>
            {:else}
              <button class="btn small" disabled={checking !== null} onclick={() => checkAndAdd(d.backend, d.model, d.contextWindow)}>Check & add</button>
            {/if}
          </div>
          {#if results[key] && !results[key].ok}<p class="detail mono">{results[key].detail}</p>{/if}
        {/each}
      {/if}
      <div class="row manual">
        <select bind:value={manual.backend}>{#each BACKENDS as b}<option value={b.id}>{b.label}</option>{/each}</select>
        <input class="mono" placeholder="model id the server expects" bind:value={manual.model} />
        <button class="btn" disabled={!manual.model.trim() || checking !== null} onclick={() => checkAndAdd(manual.backend, manual.model.trim())}>Check & add</button>
      </div>
      {#if checking === `${manual.backend}/${manual.model.trim()}`}<p class="hint mono"><LoaderCircle size={12} class="spin" /> {checkLine}</p>{/if}
      {#if results[`${manual.backend}/${manual.model.trim()}`]}
        {@const r = results[`${manual.backend}/${manual.model.trim()}`]}
        <p class="detail mono" class:passd={r.ok}>{r.ok ? 'Passed' : 'Failed'} in {r.seconds}s — {r.detail}</p>
      {/if}

    {:else if tab === 'harnesses'}
      <h3>omp lean tool set</h3>
      <p class="lead">Sessions with “lean tools” on send only these tools. Every tool's schema rides along with every request, so the full set (~19 tools) costs ~18K prompt tokens per turn on a local model.</p>
      <div class="tools mono">
        {#each ALL_OMP_TOOLS as t}
          <label><input type="checkbox" checked={tools.includes(t)} onchange={(e) => tools = (e.currentTarget as HTMLInputElement).checked ? [...tools, t] : tools.filter((x) => x !== t)} /> {t}</label>
        {/each}
      </div>
      <button class="link" onclick={() => tools = [...DEFAULT_OMP_TOOLS]}>Reset to default</button>

      <h3>Extra instructions</h3>
      <p class="lead">Appended to the system prompt of every Code session: omp gets it via <code>--append-system-prompt</code>, opencode via an instructions file in its generated config. Project rules still come from each folder's AGENTS.md.</p>
      <textarea rows="6" bind:value={extra} placeholder="e.g. Prefer small diffs. Run the tests after every change."></textarea>
      <div class="row">
        <button class="btn primary" onclick={saveHarness}>Save</button>
        {#if savedHarness}<span class="hint">Saved. Idle sessions pick it up on their next message; a running turn keeps its current setup.</span>{/if}
      </div>
      <h3>Harnesses</h3>
      <p class="lead">omp {code.harnesses.omp ? 'is installed' : 'is not installed'} (uses your <code>~/.omp</code> setup: models.yml, AGENTS.md, LSP, memory). opencode {code.harnesses.opencode ? 'is installed' : 'is not installed (brew install opencode)'}; its config is generated by Local Lab, so <code>~/.config/opencode</code> is never changed.</p>

    {:else}
      <h3>Unload idle DeepSeek servers</h3>
      <p class="lead">DwarfStar servers hold 86–93 GB until stopped. Stop them after this many idle minutes (0 = never). oMLX unloads idle models itself after 5 minutes; Ollama after its keep-alive.</p>
      <div class="row">
        <input class="num mono" type="number" min="0" max="240" bind:value={idle} />
        <span class="hint">minutes</span>
        <button class="btn" onclick={saveIdle}>Save</button>
      </div>

      <h3>oMLX context windows</h3>
      <p class="lead">The longest prompt oMLX accepts per model (<code>~/.omlx/model_settings.json</code>). Blank uses the model's native maximum. Longer contexts take more memory for the KV cache, and oMLX refuses prompts past its 85 GB memory guard. Saving restarts oMLX on its next request.</p>
      {#if servers}
        <table class="cat">
          <thead><tr><th>Model</th><th>Native</th><th>Limit</th><th></th></tr></thead>
          <tbody>
            {#each servers.omlx as m (m.model)}
              <tr>
                <td class="mono id">{m.model}</td>
                <td class="mono">{fmt(m.native)}</td>
                <td><input class="num mono" type="number" min="4096" step="4096" placeholder="native" bind:value={caps[m.model]} /></td>
                <td><button class="btn small" disabled={savingCap !== null || (caps[m.model] ?? '') === (m.maxContext ? String(m.maxContext) : '')} onclick={() => saveCap(m.model)}>{savingCap === m.model ? 'Saving…' : 'Save'}</button></td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}<p class="hint">Loading…</p>{/if}
    {/if}
  </div>
</div>

<style>
  .shade { position: fixed; inset: 0; background: #0009; z-index: 40; }
  .dialog { position: fixed; z-index: 41; top: 6vh; left: 50%; transform: translateX(-50%); width: min(920px, 92vw); max-height: 86vh; display: flex; flex-direction: column; background: #0e1115; border: 1px solid #2a323d; border-radius: 14px; box-shadow: 0 30px 80px #000c; }
  header { display: flex; align-items: center; gap: 16px; padding: 14px 18px; border-bottom: 1px solid #1a1f27; }
  h2 { font-size: 15px; font-weight: 600; }
  nav { display: flex; gap: 2px; border: 1px solid #2a323d; border-radius: 8px; padding: 2px; }
  nav button { font-size: 12px; padding: 5px 12px; border-radius: 6px; color: #9ba7b8; }
  nav button[aria-pressed='true'] { background: #343027; color: #f1d69b; }
  .close { margin-left: auto; color: #8d99a8; padding: 4px; border-radius: 6px; } .close:hover { background: #161a20; color: #dfe5ec; }
  .content { overflow: auto; padding: 16px 20px 22px; }
  h3 { font-size: 12.5px; font-weight: 600; margin: 18px 0 6px; }
  h3:first-child { margin-top: 0; }
  .lead { font-size: 12px; color: #97a3b4; line-height: 1.55; margin-bottom: 10px; max-width: 760px; }
  .lead code { background: #1a1f27; border-radius: 4px; padding: 0 4px; font-size: 11px; }
  .msg { font-size: 12px; padding: 7px 10px; border-radius: 6px; margin-bottom: 10px; }
  .msg.err { background: #2a1416; color: #f0a3a1; } .msg.ok { background: #16210f; color: #b6dba2; }
  table.cat { width: 100%; border-collapse: collapse; font-size: 12px; }
  .cat th { text-align: left; font-weight: 500; color: #6b7787; font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; padding: 4px 6px; border-bottom: 1px solid #1a1f27; }
  .cat td { padding: 4px 6px; border-bottom: 1px solid #14181e; vertical-align: middle; }
  .id { font-size: 11px; color: #97a3b4; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .be { font-size: 10px; color: #d8a657; }
  input, select, textarea { background: #161a20; border: 1px solid #2a323d; border-radius: 6px; font-size: 12px; padding: 4px 7px; color: #dfe5ec; }
  input.name { width: 100%; min-width: 140px; }
  input.num { width: 96px; } input.num.small { width: 56px; }
  input[type='checkbox'] { padding: 0; }
  textarea { width: 100%; line-height: 1.5; resize: vertical; }
  .del { color: #8d99a8; padding: 4px; border-radius: 5px; } .del:hover { color: #e08583; background: #1c1416; }
  .row { display: flex; align-items: center; gap: 10px; margin: 8px 0; }
  .row.manual input { flex: 1; }
  .btn { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; padding: 5px 11px; border-radius: 7px; border: 1px solid #39424e; color: #dfe5ec; }
  .btn:hover:not(:disabled) { background: #1c222b; } .btn:disabled { opacity: .45; }
  .btn.small { font-size: 11px; padding: 3px 9px; }
  .btn.primary { background: #d8a657; border-color: #d8a657; color: #17130b; font-weight: 600; }
  .btn.ghost { border-color: transparent; color: #97a3b4; }
  .hint { font-size: 11.5px; color: #8d99a8; display: flex; align-items: center; gap: 6px; }
  .disc { display: flex; align-items: center; gap: 10px; padding: 5px 6px; border-bottom: 1px solid #14181e; font-size: 12px; }
  .dm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; }
  .ctxv { font-size: 11px; color: #8d99a8; width: 52px; }
  .checking { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #97a3b4; max-width: 300px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .fail { font-size: 11px; color: #e08583; } .pass { display: flex; align-items: center; gap: 4px; font-size: 11px; color: #8fc27a; }
  .detail { font-size: 11px; color: #e0b46a; margin: 2px 6px 8px; white-space: pre-wrap; } .detail.passd { color: #8fc27a; }
  .tools { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 6px 12px; font-size: 11.5px; color: #c3ccd7; }
  .tools label { display: flex; align-items: center; gap: 6px; }
  .link { font-size: 11.5px; color: #d8a657; margin-top: 6px; }
</style>
