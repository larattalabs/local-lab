<script lang="ts">
  import { directorFlow as director } from '../stores/director.svelte'
  import { store } from '../stores/lab.svelte'
  import { lab, fileUrl } from '../api'
  import type { Modality, SubmitTurn } from '@shared/types'
  let { onNavigate }: { onNavigate: (modality: Modality) => void } = $props()
  const session = $derived(director.session)
  const preview = $derived(session?.status.preview)
  let expanded = $state(false), previousId = $state('')
  let prompts = $state<Record<string, string>>({}), error = $state(''), busy = $state(false)
  const compact = $derived(session?.status.automatic && !expanded && !session.status.error && !director.connectionError && !session.status.result && !error)
  $effect(() => { if (session?.status.id !== previousId) { previousId = session?.status.id ?? ''; expanded = false } })
  let dialog = $state<HTMLDialogElement>()
  $effect(() => { if (session && dialog && !dialog.open) dialog.showModal() })
  $effect(() => { if (preview) prompts = { ...preview.prompts } })
  const shared = $derived(preview?.provenance.comparison === 'same')
  const keys = $derived(Object.keys(prompts))
  function update(id: string, value: string) { prompts = shared ? Object.fromEntries(keys.map((k) => [k, value])) : { ...prompts, [id]: value } }
  async function recovered(turn: SubmitTurn) {
    const result = await lab.submitTurn(turn)
    await store.resync(); store.activeChat[turn.request.modality] = result.chat.id
    director.completeRecovered(); onNavigate(turn.request.modality)
  }
  async function generate() {
    busy = true; error = ''
    try { const turn = director.approved($state.snapshot(prompts)); if (turn) await recovered(turn) }
    catch (e) { error = e instanceof Error ? e.message : String(e) }
    finally { busy = false }
  }
  async function original() {
    busy = true; error = ''
    try { const turn = await director.original(); if (turn) await recovered(turn) }
    catch (e) { error = e instanceof Error ? e.message : String(e) }
    finally { busy = false }
  }
  async function cancel() { try { await director.cancel() } catch (e) { error = String(e) } }
</script>
{#if session}
  {#if compact}<div class="director-inline" role="status"><div><strong>Preparing your prompt</strong><span>{session.status.state === 'queued' ? 'Waiting for the Mac’s queue' : 'Your director is working locally'}</span></div><button onclick={() => expanded = true}>Details</button><button onclick={cancel}>Cancel</button></div>
  {:else}
  <dialog bind:this={dialog} aria-labelledby="director-title" oncancel={(e) => { e.preventDefault(); if (!busy) void cancel() }} class="director-preview">
    <header><h2 id="director-title">{session.status.automatic ? 'Automatic Prompt Director' : 'Review prompt rewrite'}</h2><button type="button" aria-label="Close director preview" disabled={busy} onclick={cancel}>✕</button></header>
    {#if ['queued', 'running'].includes(session.status.state)}
      <p role="status">{session.status.state === 'queued' ? 'Waiting for the Mac’s generation queue…' : 'Rewriting locally on the Mac…'}</p>
      <p>The rewriting model releases its memory before image or video generation starts.</p>
    {/if}
    {#if session.status.error || director.connectionError || error}<p class="error" role="alert">{session.status.error || director.connectionError || error}</p>{/if}
    {#if preview}
      <p>{preview.provenance.preset} · {preview.provenance.freedom} creativity · {shared ? 'same prompt comparison' : 'model-specific wording'}</p>
      {#if preview.turn.request.images?.length}<div class="sources">{#each preview.turn.request.images as image}<img src={fileUrl(image)} alt="Selected generation source" />{/each}</div>{/if}
      {#each preview.warnings as warning}<p class="notice">{warning}</p>{/each}
      <h3>Your request</h3><p class="original">{preview.provenance.originalPrompt}</p>
      {#each shared ? keys.slice(0, 1) : keys as id}
        <label>{shared ? 'Prompt to use for all selected models' : store.adapters.find((a) => a.id === id)?.label ?? id}
          <textarea rows="7" value={prompts[id]} oninput={(e) => update(id, e.currentTarget.value)} disabled={busy || session.status.automatic}></textarea>
        </label>
      {/each}
      <details><summary>Director details</summary><p>{preview.provenance.model}</p><pre>{preview.provenance.systemPrompt}</pre></details>
    {/if}
    {#if session.status.automatic && session.status.result}
      <p>Generation was queued on the Mac.</p><button type="button" onclick={async () => { const result = session!.status.result!; await store.resync(); store.activeChat[result.chat.modality] = result.chat.id; onNavigate(result.chat.modality); director.completeRecovered() }}>Open generation</button>
    {:else}
      <footer>
        <button type="button" disabled={busy} onclick={cancel}>{['queued','running'].includes(session.status.state) ? 'Cancel rewrite' : 'Back to prompt'}</button>
        {#if !session.status.automatic || ['error','cancelled'].includes(session.status.state)}<button type="button" disabled={busy || (!session.input && !preview)} onclick={original}>Use original</button>{/if}
        {#if ['error','cancelled','done'].includes(session.status.state)}<button type="button" disabled={busy || (!session.input && !preview)} onclick={() => director.retry()}>Rewrite again</button>{/if}
        {#if preview && session.status.state === 'done' && !session.status.automatic}<button type="button" class="primary" disabled={busy || Object.values(prompts).some((p) => !p.trim())} onclick={generate}>Generate with this prompt</button>{/if}
      </footer>
    {/if}
  </dialog>
  {/if}
{/if}
<style>
  .director-inline{position:fixed;bottom:52px;right:20px;z-index:45;display:flex;align-items:center;gap:12px;padding:14px 16px;border:1px solid #665338;border-radius:13px;background:#24221e;box-shadow:0 8px 40px #0006;max-width:calc(100vw - 24px)}.director-inline strong{display:block;font-size:13px;color:#f0d4a6;font-weight:500}.director-inline span{display:block;font-size:12px;color:#b7b0a5;margin-top:3px}.director-inline button{font-size:12px;padding:8px;border-color:transparent;color:#e1b879}@media(max-width:600px){.director-inline{right:12px;bottom:calc(48px + env(safe-area-inset-bottom));gap:7px;padding:10px 12px}.director-inline span{font-size:11px}}
  dialog { margin:auto; padding:22px; width:760px; max-width:calc(100vw - 24px); max-height:calc(100dvh - 24px); overflow:auto; border:1px solid #333c48; border-radius:14px; background:#101317; color:#dfe5ec; } dialog::backdrop { background:#000c; } header,footer { display:flex; align-items:center; gap:12px; flex-wrap:wrap; } header { justify-content:space-between; } h2 { font-size:20px; } h3,label { display:block; font-size:13px; margin:14px 0 6px; } p { margin:12px 0; font-size:13px; line-height:1.6; color:#97a3b4; } .original { white-space:pre-wrap; color:#dfe5ec; } textarea { width:100%; background:#08090b; color:#dfe5ec; border:1px solid #333c48; border-radius:7px; padding:12px; margin-top:7px; font-size:14px; resize:vertical; } button { padding:9px 12px; border:1px solid #333c48; border-radius:7px; font-size:12px; } button:disabled { opacity:.4; } .primary { background:#d8a657; color:#08090b; margin-left:auto; } footer { margin-top:20px; } .notice { background:#29251b; padding:10px; border-radius:7px; color:#d8b478; } .error { color:#f09491; } .sources { display:flex; gap:8px; overflow:auto; margin:12px 0; } img { height:90px; max-width:120px; object-fit:contain; border-radius:6px; } summary { color:#97a3b4; font-size:12px; cursor:pointer; } pre { font-size:11px; white-space:pre-wrap; max-height:180px; overflow:auto; } @media(max-width:600px) { dialog { padding:16px; } button { min-height:42px; } }
</style>
