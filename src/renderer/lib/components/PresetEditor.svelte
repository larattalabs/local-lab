<script lang="ts">
  import { onMount } from 'svelte'
  import type { BasicPreset } from '@shared/basic'
  import { directorProfiles } from '@shared/director'
  import { directorFlow } from '../stores/director.svelte'
  import { basicFlow } from '../stores/basic.svelte'
  import { store } from '../stores/lab.svelte'
  import { lab, fileUrl } from '../api'
  import ModelSettings from './ModelSettings.svelte'
  let { existing, adapterId, params, thumbnail, directorId, moodId, intensityId, onDismiss }: { existing?: BasicPreset; adapterId?: string; params?: Record<string, unknown>; thumbnail?: string; directorId?: string; moodId?: string; intensityId?: string; onDismiss: () => void } = $props()
  let dialog = $state<HTMLDialogElement>()
  let draft = $state<BasicPreset>()
  let busy = $state(false), error = $state(''), confirmDelete = $state(false)
  const adapter = $derived(store.adapters.find((a) => a.id === draft?.adapterId))
  onMount(() => {
    const a = store.adapters.find((a) => a.id === (existing?.adapterId ?? adapterId))
    if (a) draft = existing ? structuredClone($state.snapshot(existing)) : {
      id: '', version: 0, name: '', adapterId: a.id,
      workflow: a.modality === 'video' ? 'animate' : a.promptOptional ? 'upscale' : a.requiresImage ? 'edit' : 'create',
      params: structuredClone($state.snapshot(params ?? store.resolvedParams(a))), exposed: [],
      mood: moodId ?? 'glamour', intensity: intensityId ?? 'low',
      director: directorId ?? (a.modality === 'video' ? 'motion' : a.requiresImage ? 'edit' : 'faithful'), thumbnail,
    }
    dialog?.showModal()
  })
  async function save() {
    if (!draft) return
    busy = true; error = ''
    try { await basicFlow.save(draft); onDismiss() }
    catch (e) { error = e instanceof Error ? e.message : String(e) }
    finally { busy = false }
  }
</script>
<dialog bind:this={dialog} aria-labelledby="preset-title" oncancel={(e) => { if (busy) e.preventDefault(); else onDismiss() }}>
  <header><div><h2 id="preset-title">{existing ? 'Edit preset' : 'Save as preset'}</h2><p>Shared between your Mac and paired phones.</p></div><button aria-label="Close preset editor" disabled={busy} onclick={onDismiss}>✕</button></header>
  {#if draft && adapter}
    <section>
      <label>Name<input bind:value={draft.name} maxlength="80" placeholder="e.g. Soft daylight portraits" /></label>
      <p class="hint">{adapter.label} · {draft.workflow}</p>
      <div class="thumbnail">
        {#if draft.thumbnail}<img src={fileUrl(draft.thumbnail)} alt="Preset preview" />{/if}
        <button disabled={busy} onclick={async () => { try { const images = await lab.pickImages(); if (images[0] && draft) draft.thumbnail = images[0] } catch (e) { error = String(e) } }}>Choose thumbnail</button>
        {#if draft.thumbnail}<button onclick={() => { if (draft) draft.thumbnail = undefined }}>Remove thumbnail</button>{/if}
      </div>
      <label>Prompt director<select bind:value={draft.director}>{#each directorProfiles(directorFlow.info.config) as director}<option value={director.id}>{director.name}</option>{/each}</select></label>
      {#if draft.director === 'adult'}
        <label>Default mood<select value={draft.mood ?? 'glamour'} onchange={(e) => { if (draft) draft.mood = e.currentTarget.value }}>{#each basicFlow.catalog.modifiers.moods as option}<option value={option.id}>{option.name}</option>{/each}</select></label>
        <label>Default intensity<select value={draft.intensity ?? 'low'} onchange={(e) => { if (draft) draft.intensity = e.currentTarget.value }}>{#each basicFlow.catalog.modifiers.intensities as option}<option value={option.id}>{option.name}</option>{/each}</select></label>
        <p class="hint">Basic starts with these choices. Later edits to their instructions apply to new generations; existing results keep their original instructions.</p>
      {/if}
      <details><summary>Saved model settings</summary><ModelSettings {adapter} values={draft.params} onchange={(key, value) => { if (draft) draft.params = { ...draft.params, [key]: value } }} /></details>
      <fieldset><legend>Controls to show in Basic mode</legend><p class="hint">Leave unchecked to keep a setting fixed. Choose up to 12.</p>
        <div class="controls">{#each adapter.params as param}<label><input type="checkbox" checked={draft.exposed.includes(param.key)} disabled={!draft.exposed.includes(param.key) && draft.exposed.length >= 12} onchange={(e) => { if (draft) draft.exposed = e.currentTarget.checked ? [...draft.exposed, param.key] : draft.exposed.filter((key) => key !== param.key) }} />{param.label}</label>{/each}</div>
      </fieldset>
      {#if error}<p role="alert" class="error">{error}</p>{/if}
      {#if confirmDelete}<p class="hint">Remove this preset? Existing results and settings stay saved.</p><button disabled={busy} onclick={async () => { busy = true; try { await basicFlow.remove(draft!); onDismiss() } catch (e) { error = String(e) } finally { busy = false } }}>Remove preset</button><button onclick={() => confirmDelete = false}>Keep preset</button>{/if}
    </section>
    <footer>{#if existing}<button disabled={busy} onclick={() => confirmDelete = true}>Delete…</button>{/if}<button class="primary" disabled={busy || !draft.name.trim()} onclick={save}>{busy ? 'Saving…' : 'Save preset'}</button></footer>
  {:else}<p class="error">This model is no longer registered.</p>{/if}
</dialog>
<style>
dialog{margin:auto;padding:0;width:640px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);overflow:auto;border:1px solid #39424e;border-radius:14px;background:#10161e;color:#e4eaf2}dialog::backdrop{background:#000b}header,footer{display:flex;justify-content:space-between;gap:16px;padding:18px 22px;border-bottom:1px solid #303640}h2{font-size:20px}header p,.hint{font-size:12px;color:#9ba7b8;margin:7px 0}section{padding:20px 22px}label{display:block;font-size:12px}input:not([type=checkbox]),select{display:block;width:100%;margin:8px 0 14px;padding:10px;background:#090e15;border:1px solid #39424e;border-radius:8px;color:#e4eaf2}button{padding:8px 10px;border:1px solid #39424e;border-radius:8px;font-size:12px}button:disabled{opacity:.5}.primary{margin-left:auto;background:#d8a657;color:#10161e}.thumbnail{display:flex;gap:8px;align-items:center;margin:14px 0}.thumbnail img{height:70px;width:70px;object-fit:contain}details,fieldset{margin-top:18px}summary,legend{font-size:13px;margin-bottom:12px}.controls{display:grid;grid-template-columns:1fr 1fr;gap:10px}.controls label{display:flex;gap:8px;align-items:center}.error{color:#f09491;font-size:12px;margin:12px}footer{border-top:1px solid #303640;border-bottom:0}@media(max-width:640px){input:not([type=checkbox]),select{font-size:16px}.controls{grid-template-columns:1fr}section{padding:16px}}
</style>
