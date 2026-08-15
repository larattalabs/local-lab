<script lang="ts">
  import { MODALITIES, type Modality, type RunRecord } from '@shared/types'

  let runs = $state<RunRecord[]>([])
  let filter = $state<Modality | 'all'>('all')
  let loading = $state(true)

  async function refresh() {
    loading = true
    runs = await window.lab.listHistory()
    loading = false
  }
  $effect(() => { refresh() })

  const visible = $derived(filter === 'all' ? runs : runs.filter((r) => r.modality === filter))

  function fileUrl(p: string): string {
    return 'labfile://f/' + encodeURIComponent(p)
  }
  function when(r: RunRecord): string {
    return new Date(r.finishedAt ?? r.queuedAt).toLocaleString(undefined,
      { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  }
  function took(r: RunRecord): string {
    if (!r.startedAt || !r.finishedAt) return ''
    return `${((r.finishedAt - r.startedAt) / 1000).toFixed(0)}s`
  }
  async function remove(r: RunRecord) {
    await window.lab.deleteRun(r.dir)
    runs = runs.filter((x) => x.dir !== r.dir)
  }
</script>

<div class="flex-1 min-h-0 flex flex-col">
  <div class="flex items-center gap-1 px-3 py-2 border-b border-bench-700 shrink-0">
    {#each [{ id: 'all', label: 'All' }, ...MODALITIES] as m}
      <button
        class="px-2.5 py-1 rounded text-[11.5px] transition-colors
               {filter === m.id ? 'bg-bench-700 text-bench-100' : 'text-bench-400 hover:text-bench-100'}"
        onclick={() => (filter = m.id as Modality | 'all')}
      >{m.label}</button>
    {/each}
    <div class="flex-1"></div>
    <span class="mono text-[10px] text-bench-600">{visible.length} runs</span>
    <button class="mono text-[11px] text-bench-400 hover:text-bench-100 px-2 py-1"
            onclick={() => window.lab.openRuns()}>folder&nbsp;↗</button>
  </div>

  <div class="flex-1 overflow-y-auto p-3 min-h-0">
    {#if loading}
      <div class="h-full grid place-items-center mono text-[11px] text-bench-600">reading runs…</div>
    {:else if !visible.length}
      <div class="h-full grid place-items-center text-center">
        <p class="text-bench-400 text-[13px]">Nothing here yet — everything you generate lands in history automatically.</p>
      </div>
    {:else}
      <div class="grid gap-3" style="grid-template-columns: repeat(auto-fill, minmax(320px, 1fr))">
        {#each visible as r (r.dir)}
          <article class="rounded border border-bench-700 bg-bench-850 overflow-hidden flex flex-col">
            <header class="flex items-center gap-2 px-2.5 py-1.5 border-b border-bench-700 shrink-0">
              <span class="size-1.5 rounded-full shrink-0 {r.state === 'done' ? 'bg-live' : 'bg-fault'}"></span>
              <span class="text-[12px] truncate">{r.adapterLabel}</span>
              <span class="mono text-[10px] text-bench-600 ml-auto shrink-0">{when(r)}</span>
            </header>

            <div class="relative bg-bench-950 min-h-[120px] grid place-items-center">
              {#if r.outputPath}
                {#if r.modality === 'image'}
                  <img src={fileUrl(r.outputPath)} alt={r.prompt} loading="lazy" class="w-full h-auto block" />
                {:else if r.modality === 'video'}
                  <!-- svelte-ignore a11y_media_has_caption -->
                  <video src={fileUrl(r.outputPath)} controls preload="metadata" class="w-full block"></video>
                {:else if r.modality === 'music'}
                  <audio src={fileUrl(r.outputPath)} controls preload="metadata" class="w-full p-3"></audio>
                {/if}
              {:else if r.textPreview}
                <pre class="w-full max-h-56 overflow-y-auto p-3 text-[11.5px] leading-relaxed
                            whitespace-pre-wrap text-bench-100">{r.textPreview}</pre>
              {:else}
                <span class="mono text-[11px] text-bench-600">{r.state}</span>
              {/if}
            </div>

            {#if r.prompt}
              <p class="px-2.5 py-1.5 text-[11px] text-bench-400 leading-snug line-clamp-2" title={r.prompt}>{r.prompt}</p>
            {/if}

            <footer class="flex items-center gap-2 px-2.5 py-1.5 border-t border-bench-700 mono text-[10px] shrink-0">
              {#if r.params?.seed != null && r.params.seed !== ''}
                <span class="text-bench-600">seed {r.params.seed}</span>
              {/if}
              {#if took(r)}<span class="text-bench-600">{took(r)}</span>{/if}
              <div class="flex-1"></div>
              <button class="text-bench-400 hover:text-bench-100"
                      onclick={() => r.outputPath && window.lab.reveal(r.outputPath)}>reveal</button>
              <button class="text-bench-400 hover:text-fault" onclick={() => remove(r)}>delete</button>
            </footer>
          </article>
        {/each}
      </div>
    {/if}
  </div>
</div>
