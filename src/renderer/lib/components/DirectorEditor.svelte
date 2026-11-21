<script lang="ts">
  import { onMount } from 'svelte'
  import { DIRECTOR_PROFILES, directorProfiles, type DirectorConfig, type DirectorProfile } from '@shared/director'
  import { directorFlow as director } from '../stores/director.svelte'
  let { modality, onDismiss, initialId, editOnly = false }: { initialId?: string; editOnly?: boolean; modality: 'image' | 'video'; onDismiss: () => void } = $props()
  let dialog = $state<HTMLDialogElement>()
  let config = $state<DirectorConfig>($state.snapshot(director.info.config))
  let id = $state(''), name = $state(''), instructions = $state('')
  let original = $state<DirectorProfile>(), isNew = $state(false)
  let busy = $state(false), error = $state(''), message = $state(''), confirmRemove = $state(false)
  let pending = $state<(() => void) | undefined>()
  let pendingPanel = $state<HTMLDivElement>()
  $effect(() => { if (pending && pendingPanel) pendingPanel.focus() })
  let removed = $state<DirectorProfile>()
  const profiles = $derived(directorProfiles(config))
  const builtIn = $derived(DIRECTOR_PROFILES.find((p) => p.id === id))
  const overridden = $derived(!!builtIn && config.profiles.some((p) => p.id === id))
  const dirty = $derived(isNew || name !== original?.name || instructions !== original?.instructions)
  const valid = $derived(!!name.trim() && !!instructions.trim() && name.length <= 80 && instructions.length <= 8000)
  function load(profile: DirectorProfile, fresh = false) {
    id = profile.id; name = profile.name; instructions = profile.instructions
    original = { ...profile }; isNew = fresh; error = ''; message = ''; confirmRemove = false
  }
  function guard(action: () => void) {
    if (busy) return
    confirmRemove = false
    if (dirty) pending = action
    else action()
  }
  function create(copy = false) {
    const profile = { id: crypto.randomUUID(), name: copy ? `${name.slice(0, 75)} copy` : '', instructions: copy ? instructions : '' }
    guard(() => load(profile, true))
  }
  async function save(): Promise<boolean> {
    if (!valid || busy) return false
    busy = true; error = ''; message = ''
    try {
      const next = $state.snapshot(config), profile = { id, name: name.trim(), instructions: instructions.trim() }
      next.profiles = [...next.profiles.filter((p) => p.id !== id), profile]
      await director.configure(next)
      config = $state.snapshot(director.info.config); load(profile)
      message = 'Director saved on the Mac.'
      return true
    } catch (e) { error = e instanceof Error ? e.message : String(e); return false }
    finally { busy = false }
  }
  async function reload() {
    busy = true; error = ''
    try {
      await director.reload(); config = $state.snapshot(director.info.config)
      load(directorProfiles(config).find((p) => p.id === id) ?? directorProfiles(config)[0])
      message = 'Library refreshed.'
    } catch (e) { error = e instanceof Error ? e.message : String(e) }
    finally { busy = false }
  }
  async function remove() {
    busy = true; error = ''
    try {
      const next = $state.snapshot(config), deleted = next.profiles.find((p) => p.id === id)
      next.profiles = next.profiles.filter((p) => p.id !== id)
      if (!builtIn) for (const m of ['image', 'video'] as const) if (next.defaults[m].preset === id) next.defaults[m].preset = m === 'image' ? 'faithful' : 'motion'
      const wasBuiltIn = !!builtIn
      await director.configure(next); config = $state.snapshot(director.info.config)
      removed = deleted
      load(directorProfiles(config).find((p) => p.id === id) ?? directorProfiles(config)[0])
      message = wasBuiltIn ? 'Original director restored.' : 'Director deleted. You can undo this below.'
    } catch (e) { error = e instanceof Error ? e.message : String(e) }
    finally { busy = false; confirmRemove = false }
  }
  async function undo() {
    if (!removed) return
    busy = true; error = ''
    try {
      const profile = $state.snapshot(removed), next = $state.snapshot(config)
      next.profiles = [...next.profiles.filter((p) => p.id !== profile.id), profile]
      await director.configure(next); config = $state.snapshot(director.info.config); removed = undefined
      load(profile); message = 'Change undone.'
    } catch (e) { error = e instanceof Error ? e.message : String(e) }
    finally { busy = false }
  }
  async function use() {
    if (dirty && !await save()) return
    director.choose(modality, 'preset', id)
    if (director.choices[modality].mode === 'off') director.choose(modality, 'mode', 'preview')
    onDismiss()
  }
  onMount(() => {
    load(profiles.find((p) => p.id === (initialId ?? director.choices[modality].preset)) ?? profiles[0])
    dialog?.showModal()
    void reload()
  })
</script>
<dialog bind:this={dialog} class="director-editor" aria-labelledby="editor-title" oncancel={(e) => { e.preventDefault(); guard(onDismiss) }}>
  <header>
    <div><h2 id="editor-title">Director editor</h2><p>Create reusable instructions for how your prompts should be rewritten.</p></div>
    <button type="button" aria-label="Close director editor" disabled={busy} onclick={() => guard(onDismiss)}>✕</button>
  </header>
      {#if pending}
        <div class="confirmation unsaved" role="group" aria-label="Unsaved director changes" tabindex="-1" bind:this={pendingPanel}>
          <p>Save your changes before continuing?</p>
          <button type="button" disabled={busy || !valid} onclick={async () => { const action = pending; if (await save()) { pending = undefined; action?.() } }}>Save & continue</button>
          <button type="button" disabled={busy} onclick={() => { const action = pending; pending = undefined; action?.() }}>Discard changes</button>
          <button type="button" disabled={busy} onclick={() => pending = undefined}>Keep editing</button>
        </div>
      {/if}
  <div class="editor-layout">
    <aside aria-label="Director library">
      <button type="button" class="new" disabled={busy} onclick={() => create()}>+ New director</button>
      <p class="eyebrow">Your directors</p>
      <nav aria-label="Directors">
        {#each profiles as profile (profile.id)}
          <button type="button" class:selected={id === profile.id} aria-current={id === profile.id ? 'true' : undefined} disabled={busy}
            onclick={() => guard(() => load(profile))}>
            <span>{profile.name}</span><small>{DIRECTOR_PROFILES.some((p) => p.id === profile.id) ? config.profiles.some((p) => p.id === profile.id) ? 'Built-in · customized' : 'Built-in' : 'Custom'}</small>
          </button>
        {/each}
        {#if isNew}<div class="draft"><span>{name || 'Untitled director'}</span><small>Unsaved director</small></div>{/if}
      </nav>
      <button type="button" class="quiet" disabled={busy} onclick={() => guard(() => { void reload() })}>Reload library</button>
    </aside>
    <section class="editing" aria-label="Edit director">
      <div class="editor-toolbar"><span>{isNew ? 'New director' : overridden ? 'Customized built-in' : builtIn ? 'Built-in director' : 'Custom director'}{dirty ? ' · Unsaved changes' : ''}</span>
        <button type="button" disabled={busy || !name.trim()} onclick={() => create(true)}>Duplicate</button></div>
      <label for="director-name">Director name</label>
      <input id="director-name" bind:value={name} maxlength="80" disabled={busy} placeholder="e.g. Natural portrait photographer" />
      <div class="instruction-heading"><label for="director-instructions">Director instructions</label><span>{instructions.length.toLocaleString()} / 8,000</span></div>
      <textarea id="director-instructions" bind:value={instructions} maxlength="8000" disabled={busy} spellcheck="true" placeholder="Describe this director’s style, what to preserve, what details to add, and how to write the final prompt.\n\nExample: Use natural photographic language. Preserve the subject’s identity and clothing. Favor soft directional light and simple compositions. Keep edits focused on the requested change."></textarea>
      <p class="hint">These instructions guide the rewrite alongside your request, creative freedom and model settings. Identity protection and the app’s output format still apply.</p>
      {#if builtIn}<p class="hint">Saving customizes this built-in director. You can restore its original instructions later.</p>{/if}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      {#if message && !dirty}<p class="notice" role="status">{message}</p>{/if}
      {#if removed}<button type="button" class="quiet" disabled={busy} onclick={() => guard(() => { void undo() })}>Undo last removal</button>{/if}
      {#if confirmRemove}
        <div class="confirmation" role="group" aria-label="Confirm director removal">
          <p>{builtIn ? 'Restore the original name and instructions?' : `Delete “${name}”? Selections and defaults using it will fall back to a built-in director.`}</p>
          <button type="button" disabled={busy} onclick={remove}>{builtIn ? 'Restore original' : 'Delete director'}</button>
          <button type="button" disabled={busy} onclick={() => confirmRemove = false}>Keep director</button>
        </div>
      {/if}
      <footer>
        {#if !isNew && (!builtIn || overridden)}<button type="button" class="remove" disabled={busy} onclick={() => guard(() => confirmRemove = true)}>{builtIn ? 'Restore original…' : 'Delete…'}</button>{/if}
        <div class="save-actions"><button type="button" disabled={busy || !dirty || !valid} onclick={() => save()}>{busy ? 'Saving…' : 'Save director'}</button>
          {#if !editOnly}<button type="button" class="primary" disabled={busy || !valid} onclick={use}>{dirty ? 'Save & use' : 'Use director'} for {modality === 'image' ? 'images' : 'video'}</button>{/if}</div>
      </footer>
    </section>
  </div>
</dialog>
<style>
  dialog { margin:auto; padding:0; width:980px; max-width:calc(100vw - 24px); max-height:calc(100dvh - 24px); overflow:auto; border:1px solid #39424e; border-radius:14px; background:#101317; color:#e2e7ee; }
  dialog::backdrop { background:#000b; } header { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; padding:22px 24px; border-bottom:1px solid #303640; } h2 { font-size:21px; font-weight:600; } header p { color:#9ba7b8; margin-top:5px; font-size:13px; }
  button { border:1px solid #39424e; border-radius:7px; padding:9px 12px; font-size:12px; cursor:pointer; } button:hover:enabled { background:#262d38; } button:disabled { opacity:.45; cursor:default; } button:focus-visible,input:focus-visible,textarea:focus-visible { outline:2px solid #d8a657; outline-offset:2px; }
  .editor-layout { display:grid; grid-template-columns:220px minmax(0,1fr); } aside { padding:18px 14px; background:#0c0f13; border-right:1px solid #303640; } .new { width:100%; border-color:#806539; color:#e0b571; } .eyebrow { font-size:10px; color:#8490a1; text-transform:uppercase; letter-spacing:.1em; margin:22px 8px 8px; } nav { display:flex; flex-direction:column; gap:5px; } nav button,.draft { text-align:left; border-color:transparent; padding:10px; overflow-wrap:anywhere; } nav button.selected,.draft { border:1px solid #806539; background:#272218; border-radius:7px; } nav span,.draft span { display:block; } small { display:block; color:#929eaf; margin-top:4px; font-size:10px; } .quiet { color:#d8a657; border-color:transparent; margin-top:12px; }
  .editing { padding:20px 24px; min-width:0; } .editor-toolbar { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:20px; font-size:11px; color:#a4afbd; } label { display:block; font-size:12px; margin-bottom:8px; } input,textarea { width:100%; border:1px solid #39424e; border-radius:7px; padding:12px; background:#090b0e; color:#e2e7ee; font-size:14px; } textarea { min-height:clamp(180px, 32dvh, 320px); line-height:1.65; resize:vertical; } .instruction-heading { display:flex; align-items:baseline; justify-content:space-between; gap:8px; margin-top:22px; } .instruction-heading span { font-size:10px; color:#8490a1; } .hint { font-size:11px; line-height:1.6; color:#929eaf; margin-top:9px; } footer { display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; margin-top:22px; } .save-actions { margin-left:auto; display:flex; gap:8px; flex-wrap:wrap; } .primary { background:#d8a657; border-color:#d8a657; color:#101317; } .primary:hover:enabled { background:#e5b974; } .remove { color:#e8a39a; border-color:transparent; } .error { color:#f09491; font-size:12px; margin-top:14px; } .notice { color:#9ec5a1; font-size:12px; margin-top:14px; } .confirmation { margin-top:16px; padding:12px; border:1px solid #806539; background:#221e17; border-radius:8px; } .confirmation p { font-size:13px; margin-bottom:10px; } .confirmation button { margin:3px; }
  .unsaved { margin:16px 24px; }
  @media(max-width:640px) { dialog { max-width:calc(100vw - 16px); max-height:calc(100dvh - 16px); } header { padding:16px; } header p { font-size:12px; } .editor-layout { grid-template-columns:minmax(0,1fr); } aside { padding:12px; border-right:0; border-bottom:1px solid #303640; } .eyebrow { margin-top:12px; } nav { flex-direction:row; overflow-x:auto; padding-bottom:5px; } nav button,.draft { flex:0 0 148px; } .editing { padding:16px; } textarea { min-height:260px; font-size:16px; } input { font-size:16px; } button { min-height:42px; } .editor-toolbar { margin-bottom:12px; } }
</style>
