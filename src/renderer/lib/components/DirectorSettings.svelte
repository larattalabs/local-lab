<script lang="ts">
  import { directorProfiles, type DirectorChoice, type DirectorConfig } from '@shared/director'
  import ModifierEditor from './ModifierEditor.svelte'
  import DirectorEditor from './DirectorEditor.svelte'
  import { directorFlow as director } from '../stores/director.svelte'
  let { modality }: { modality: 'image' | 'video' } = $props()
  const choice = $derived(director.choices[modality])
  const profiles = $derived(directorProfiles(director.info.config))
  let editorOpen = $state(false), modifiersOpen = $state(false)
  let advanced = $state(false), busy = $state(false), message = $state('')
  let model = $state(''), terms = $state(''), keepWarm = $state(true)
  function edit() {
    advanced = !advanced
    if (advanced) { model = director.info.config.model; terms = director.info.config.protectedTerms.join(', '); keepWarm = director.info.config.keepWarm ?? true }
  }
  function choose(key: keyof DirectorChoice, value: string) {
    director.choose(modality, key, value); message = ''
  }
  async function save() {
    busy = true; message = ''
    try {
      const config: DirectorConfig = $state.snapshot(director.info.config)
      config.model = model || config.model
      config.keepWarm = keepWarm
      config.protectedTerms = terms.split(',').map((s) => s.trim()).filter(Boolean)
      config.defaults = $state.snapshot(director.choices)
      await director.configure(config)
      for (const m of ['image', 'video'] as const) director.choose(m, 'preset', config.defaults[m].preset)
      message = 'Saved on the Mac.'
    } catch (e) { message = e instanceof Error ? e.message : String(e) }
    finally { busy = false }
  }
</script>
<section class="director-settings">
  <h3>Prompt Director</h3>
  <label>Mode<select value={choice.mode} onchange={(e) => choose('mode', e.currentTarget.value)}>
    <option value="off">Off — use original</option><option value="preview">Preview rewrite</option><option value="auto">Automatic rewrite</option>
  </select></label>
  {#if choice.mode !== 'off'}
    <label>Director preset<select value={choice.preset} onchange={(e) => choose('preset', e.currentTarget.value)}>
      {#each profiles as p}<option value={p.id}>{p.name}</option>{/each}
    </select></label>
    <label>Creative freedom<select value={choice.freedom} onchange={(e) => choose('freedom', e.currentTarget.value)}>
      <option value="low">Low — preserve intent</option><option value="medium">Medium — add detail</option><option value="high">High — enrich the scene</option>
    </select></label>
    <label>Model comparison<select value={choice.comparison} onchange={(e) => choose('comparison', e.currentTarget.value)}>
      <option value="same">Same prompt for every model</option><option value="per-model">Adapt prompt per model</option>
    </select></label>
    <p>{choice.mode === 'preview' ? 'Review and edit the rewrite before generation.' : 'The Mac rewrites and queues generation automatically, even if this device disconnects.'}</p>
    {#if director.info.error}<p role="alert">{director.info.error}</p>{/if}
  {/if}
  <button type="button" class="edit-directors" onclick={() => editorOpen = true}>Edit directors…</button>
  <button type="button" class="edit-directors" onclick={() => modifiersOpen = true}>Edit moods & intensity…</button>
  <button type="button" onclick={edit}>{advanced ? '−' : '+'} Model & defaults</button>
  {#if advanced}
    <label>Rewriting model<select bind:value={model}>
      <option value="">Choose an installed model…</option>
      {#each director.info.models as m}<option value={m.id}>{m.label}{m.vision ? ' · vision' : ' · text only'}</option>{/each}
    </select></label>
    <button type="button" onclick={async () => { await director.reload(); model = director.info.config.model }}>Refresh local models/settings</button>
    <label>Preview speed<select bind:value={keepWarm}>
      <option value={true}>Keep model warm for 2 minutes</option>
      <option value={false}>Unload after every rewrite</option>
    </select></label>
    <p>Faster repeat previews use model memory briefly. The model is released before image, video, music or text generation. Automatic rewrites always release it.</p>
    <label>Protected words<input bind:value={terms} placeholder="Identity trigger, exact text" /></label>
    <p>Comma-separated. Terms present in your request must survive the rewrite exactly.</p>
    <button type="button" disabled={busy} onclick={save}>Save model & defaults</button>

  {/if}
  {#if message}<p role="status">{message}</p>{/if}
</section>
{#if editorOpen}<DirectorEditor {modality} onDismiss={() => editorOpen = false} />{/if}
{#if modifiersOpen}<ModifierEditor onDismiss={() => modifiersOpen = false}/>{/if}
<style>
  .edit-directors { border:1px solid #6a5736; border-radius:6px; padding:8px 10px; margin:12px 0 4px; width:100%; text-align:center; }
  section { padding:12px; border-bottom:1px solid #333c48; } h3 { font-size:13px; color:#d8a657; margin-bottom:10px; } label { display:block; font-size:11px; color:#97a3b4; margin:10px 0; } select,input { display:block; width:100%; min-width:0; background:#0b0d10; border:1px solid #333c48; border-radius:5px; color:#dfe5ec; padding:6px; margin-top:5px; font-size:12px; } p { font-size:11px; color:#97a3b4; line-height:1.5; margin:8px 0; } button { font-size:11px; color:#d8a657; padding:6px 0; display:block; text-align:left; } button:disabled { opacity:.4; }
</style>
