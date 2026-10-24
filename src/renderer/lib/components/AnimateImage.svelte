<script lang="ts">
  import type { Modality } from '@shared/types'
  import { untrack } from 'svelte'
  import { store } from '../stores/lab.svelte'
  import { fileUrl } from '../api'
  import ModelSettings from './ModelSettings.svelte'

  let { image, onDismiss, onNavigate }: {
    image: string
    onDismiss: () => void
    onNavigate: (modality: Modality) => void
  } = $props()
  const models = $derived(store.forModality('video').filter((a) => a.acceptsImages))
  let modelId = $state(untrack(() => models.find((a) => store.selected.video.includes(a.id) && store.isAvailable(a.id))?.id
    ?? models.find((a) => store.isAvailable(a.id))?.id ?? ''))
  const adapter = $derived(models.find((a) => a.id === modelId))
  let drafts = $state<Record<string, Record<string, unknown>>>(untrack(() => Object.fromEntries(
    models.map((a) => [a.id, store.resolvedParams(a)]))))
  let prompt = $state('')
  let busy = $state(false)
  let error = $state('')
  let dialog: HTMLDialogElement
  $effect(() => { if (!dialog.open) dialog.showModal() })

  function matchSource(event: Event) {
    const image = event.currentTarget as HTMLImageElement
    const ratio = image.naturalWidth / image.naturalHeight
    for (const model of models) {
      if (store.params[model.id]?.resolution != null) continue
      const setting = model.params.find((p) => p.key === 'resolution')
      const current = String(drafts[model.id]?.resolution ?? '').split('x').map(Number)
      const area = current[0] * current[1]
      if (!Number.isFinite(ratio) || !area) continue
      const choices = (setting?.options ?? []).map((option) => {
        const [w, h] = option.value.split('x').map(Number)
        return { value: option.value, score: Math.abs(Math.log(w / h / ratio))
          + 0.1 * Math.abs(Math.log(w * h / area)) }
      }).filter((choice) => Number.isFinite(choice.score)).sort((a, b) => a.score - b.score)
      if (choices[0]) drafts[model.id] = { ...drafts[model.id], resolution: choices[0].value }
    }
  }

  async function generate(event: SubmitEvent) {
    event.preventDefault()
    if (busy || !adapter || !prompt.trim()) return
    busy = true
    error = ''
    try {
      await store.generateVideoFromImage(image, prompt, adapter.id, drafts[adapter.id])
      onDismiss()
      onNavigate('video')
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally { busy = false }
  }
</script>

<dialog bind:this={dialog} aria-labelledby="animate-title" onclose={onDismiss}
        oncancel={(event) => { if (busy) event.preventDefault() }}
        class="m-auto w-[720px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-48px)] overflow-y-auto
               rounded-xl border border-bench-600 bg-bench-850 text-bench-100 p-0 shadow-2xl">
  <form onsubmit={generate}>
    <header class="flex items-center justify-between border-b border-bench-700 px-5 py-3">
      <h2 id="animate-title" class="text-[15px] font-medium">Animate image</h2>
      <button type="button" aria-label="Close animation settings" disabled={busy}
              class="text-bench-400 hover:text-bench-100" onclick={onDismiss}>✕</button>
    </header>
    <div class="grid grid-cols-[220px_minmax(0,1fr)] gap-5 p-5">
      <div>
        <img src={fileUrl(image)} alt="Starting frame for the video" onload={matchSource} class="w-full rounded border border-bench-700" />
        <p class="text-[11px] text-bench-500 mt-2 leading-relaxed">This image becomes the starting frame.</p>
      </div>
      <div>
        <label class="block text-[12px] mb-3">
          Motion prompt
          <textarea class="mt-1 w-full rounded bg-bench-900 border border-bench-700 p-2 text-[12px] resize-y"
                    rows="3" required bind:value={prompt} disabled={busy}
                    placeholder="Describe the movement, camera and what should stay the same…"></textarea>
        </label>
        <label class="block text-[12px] mb-3">
          Video model
          <select class="mt-1 w-full rounded bg-bench-900 border border-bench-700 px-2 py-1.5"
                  bind:value={modelId} disabled={busy || !models.length}>
            {#each models as model}
              <option value={model.id} disabled={!store.isAvailable(model.id)}>
                {model.label}{store.isAvailable(model.id) ? '' : ' — unavailable'}
              </option>
            {/each}
          </select>
        </label>
        {#if adapter}
          <p class="text-[11px] text-bench-500 leading-relaxed mb-3">{adapter.notes}</p>
          {#key adapter.id}
            <ModelSettings {adapter} values={drafts[adapter.id]}
                           onchange={(key, value) => drafts[adapter!.id] = { ...drafts[adapter!.id], [key]: value }} />
          {/key}
        {:else}
          <p class="text-[12px] text-bench-400">No image-to-video model is installed. Set up a video model and reopen Local Lab.</p>
        {/if}
      </div>
    </div>
    {#if error}<p role="alert" class="px-5 pb-3 text-[12px] text-fault">{error}</p>{/if}
    <footer class="flex items-center gap-3 border-t border-bench-700 px-5 py-3">
      <p class="text-[11px] text-bench-500 flex-1">Opens a new Video chat. Runs queue one at a time.</p>
      <button type="button" disabled={busy} class="text-[12px] text-bench-400 hover:text-bench-100"
              onclick={onDismiss}>Cancel</button>
      <button type="submit" disabled={busy || !adapter || !store.isAvailable(modelId) || !prompt.trim()}
              class="rounded bg-signal px-4 py-1.5 text-[12px] font-medium text-bench-950 disabled:opacity-40">
        {busy ? 'Starting…' : 'Generate video'}
      </button>
    </footer>
  </form>
</dialog>

<style>dialog::backdrop { background: rgb(0 0 0 / 0.65); }</style>
