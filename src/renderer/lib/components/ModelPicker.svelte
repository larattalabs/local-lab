<script lang="ts">
  import type { Modality } from '@shared/types'
  import { store } from '../stores/lab.svelte'

  let { modality }: { modality: Modality } = $props()
  const adapters = $derived(store.forModality(modality))
  const families = $derived([...new Set(adapters.map((a) => a.family))])
</script>

<div class="p-3 border-b border-bench-700 shrink-0">
  <div class="mono text-[10px] tracking-widest text-bench-400">MODELS</div>
  <div class="mono text-[10px] text-bench-600 mt-0.5">
    {store.selected[modality].length} of {adapters.length} selected
  </div>
</div>

<div class="flex-1 overflow-y-auto p-2 space-y-3 min-h-0">
  {#if !adapters.length}
    <p class="text-bench-400 text-[12px] p-2 leading-relaxed">
      No {modality} models found.
      {#if modality === 'text'}
        Pull one with <code class="mono text-bench-300">ollama pull …</code> and reopen the app.
      {/if}
    </p>
  {/if}

  {#each families as fam}
    <div>
      <div class="mono text-[10px] text-bench-600 px-1 mb-1">{fam}</div>
      <div class="space-y-1">
        {#each adapters.filter((a) => a.family === fam) as a}
          {@const on = store.selected[modality].includes(a.id)}
          {@const ok = store.isAvailable(a.id)}
          <button
            class="w-full text-left rounded px-2 py-1.5 border transition-colors
                   {on ? 'border-signal/60 bg-bench-800' : 'border-transparent hover:bg-bench-800'}
                   {ok ? '' : 'opacity-40'}"
            disabled={!ok}
            title={ok ? a.notes : store.unavailableReason(a.id)}
            onclick={() => store.toggle(modality, a.id)}
          >
            <div class="flex items-center gap-2">
              <span class="size-1.5 rounded-full shrink-0 {on ? 'bg-signal' : 'bg-bench-600'}"></span>
              <span class="text-[12px] truncate {on ? 'text-bench-100' : 'text-bench-300'}">{a.label}</span>
              {#if a.approxPeakGb}
                <span class="mono text-[10px] text-bench-600 ml-auto shrink-0">{a.approxPeakGb}GB</span>
              {/if}
            </div>
            {#if a.notes}
              <div class="text-[10.5px] text-bench-600 leading-snug mt-0.5 pl-3.5">{a.notes}</div>
            {/if}
            {#if !ok}
              <div class="mono text-[10px] text-fault/70 leading-snug mt-0.5 pl-3.5 break-all">
                {store.unavailableReason(a.id)}
              </div>
            {/if}
          </button>
        {/each}
      </div>
    </div>
  {/each}
</div>
