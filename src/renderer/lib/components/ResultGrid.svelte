<script lang="ts">
  import type { Job, Modality } from '@shared/types'
  import { store } from '../stores/lab.svelte'

  let { modality }: { modality: Modality } = $props()
  const jobs = $derived(store.jobsFor(modality))
  let openLog = $state<string | null>(null)

  /**
   * Served over the app's own `labfile://` scheme — see src/main/index.ts for
   * why plain file:// does not work here, and why the whole path goes in as a
   * single encoded segment rather than as URL path components.
   */
  function fileUrl(p: string): string {
    return 'labfile://f/' + encodeURIComponent(p)
  }

  function duration(j: Job): string {
    if (!j.startedAt) return ''
    const end = j.finishedAt ?? Date.now()
    return `${((end - j.startedAt) / 1000).toFixed(1)}s`
  }
</script>

<div class="flex-1 overflow-y-auto p-3 min-h-0">
  {#if !jobs.length}
    <div class="h-full grid place-items-center text-center">
      <div class="max-w-sm">
        <p class="text-bench-400 text-[13px]">Nothing run yet.</p>
        <p class="text-bench-600 text-[12px] mt-1 leading-relaxed">
          Pick two or more models on the left, write a prompt, and compare what comes back.
          Fix the seed to make it a fair fight.
        </p>
      </div>
    </div>
  {/if}

  <div class="grid gap-3" style="grid-template-columns: repeat(auto-fill, minmax(320px, 1fr))">
    {#each jobs as j (j.id)}
      <article class="rounded border border-bench-700 bg-bench-850 overflow-hidden flex flex-col">
        <header class="flex items-center gap-2 px-2.5 py-1.5 border-b border-bench-700 shrink-0">
          <span class="size-1.5 rounded-full shrink-0
            {j.state === 'running' ? 'bg-live animate-pulse'
             : j.state === 'done' ? 'bg-live'
             : j.state === 'error' ? 'bg-fault'
             : j.state === 'queued' ? 'bg-signal' : 'bg-bench-600'}"></span>
          <span class="text-[12px] truncate">{j.adapterLabel}</span>
          <span class="mono text-[10px] text-bench-600 ml-auto shrink-0">{duration(j)}</span>
        </header>

        <div class="relative bg-bench-950 min-h-[160px] grid place-items-center">
          {#if j.state === 'done' && j.outputPath}
            {#if modality === 'image'}
              <img src={fileUrl(j.outputPath)} alt={j.prompt} class="w-full h-auto block" />
            {:else if modality === 'video'}
              <!-- svelte-ignore a11y_media_has_caption -->
              <video src={fileUrl(j.outputPath)} controls loop class="w-full block"></video>
            {:else if modality === 'music'}
              <audio src={fileUrl(j.outputPath)} controls class="w-full p-3"></audio>
            {/if}
          {:else if j.state === 'done' || (j.state === 'running' && j.text)}
            <pre class="w-full max-h-72 overflow-y-auto p-3 text-[11.5px] leading-relaxed
                        whitespace-pre-wrap text-bench-100">{j.text ?? ''}</pre>
          {:else if j.state === 'error'}
            <pre class="w-full max-h-48 overflow-y-auto p-3 mono text-[10.5px] text-fault
                        whitespace-pre-wrap">{j.error}</pre>
          {:else if j.state === 'running'}
            <span class="mono text-[11px] text-bench-400">generating…</span>
          {:else if j.state === 'queued'}
            <span class="mono text-[11px] text-bench-600">queued</span>
          {:else}
            <span class="mono text-[11px] text-bench-600">{j.state}</span>
          {/if}
        </div>

        <footer class="flex items-center gap-2 px-2.5 py-1.5 border-t border-bench-700 mono text-[10px] shrink-0">
          {#if j.params.seed != null && j.params.seed !== ''}
            <span class="text-bench-600">seed {j.params.seed}</span>
          {/if}
          <div class="flex-1"></div>
          <button class="text-bench-500 hover:text-bench-100"
                  onclick={() => (openLog = openLog === j.id ? null : j.id)}>log</button>
          {#if j.outputPath && j.state === 'done'}
            <button class="text-bench-500 hover:text-bench-100"
                    onclick={() => window.lab.reveal(j.outputPath!)}>reveal</button>
          {/if}
          {#if j.state === 'running' || j.state === 'queued'}
            <button class="text-fault hover:underline"
                    onclick={() => window.lab.cancel(j.id)}>cancel</button>
          {/if}
        </footer>

        {#if openLog === j.id}
          <pre class="max-h-56 overflow-y-auto bg-bench-950 border-t border-bench-700 p-2.5
                      mono text-[10px] text-bench-400 whitespace-pre-wrap">{j.log}</pre>
        {/if}
      </article>
    {/each}
  </div>
</div>
