<script lang="ts">
  import type { Modality } from '@shared/types'
  import { store } from '../stores/lab.svelte'

  let { modality }: { modality: Modality } = $props()

  let open = $state(false)
  const adapters = $derived(store.forModality(modality))
  const families = $derived([...new Set(adapters.map((a) => a.family))])
  const chosen = $derived(store.selected[modality])

  const label = $derived.by(() => {
    if (!chosen.length) return 'choose model…'
    if (chosen.length === 1) {
      return adapters.find((a) => a.id === chosen[0])?.label ?? chosen[0]
    }
    return `${chosen.length} models`
  })
</script>

<div class="relative">
  {#if open}
    <!-- click-away backdrop; the popover sits above it -->
    <button class="fixed inset-0 z-10 cursor-default" aria-label="close"
            onclick={() => (open = false)}></button>

    <div class="absolute bottom-full left-0 z-20 mb-2 w-[340px] max-h-[420px] overflow-y-auto
                rounded-lg border border-bench-600 bg-bench-850 shadow-xl shadow-black/50 p-2 space-y-3">
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
          <div class="space-y-0.5">
            {#each adapters.filter((a) => a.family === fam) as a}
              {@const on = chosen.includes(a.id)}
              {@const ok = store.isAvailable(a.id)}
              <label class="flex items-start gap-2 rounded px-2 py-1.5 cursor-pointer transition-colors
                            {on ? 'bg-bench-800' : 'hover:bg-bench-800/60'} {ok ? '' : 'opacity-40'}"
                     title={ok ? a.notes : store.unavailableReason(a.id)}>
                <input type="checkbox" class="mt-0.5 accent-[var(--color-signal,#e2b34d)]"
                       checked={on} disabled={!ok}
                       onchange={() => store.toggle(modality, a.id)} />
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-2">
                    <span class="text-[12px] truncate {on ? 'text-bench-100' : 'text-bench-300'}">{a.label}</span>
                    {#if a.requiresImage}
                      <span class="mono text-[9px] uppercase tracking-wide text-amber-500/80 border border-amber-500/30 rounded px-1 shrink-0"
                            title="This model edits an input image — it cannot run from a prompt alone.">img in</span>
                    {/if}
                    {#if a.requiresAudio}
                      <span class="mono text-[9px] uppercase tracking-wide text-amber-500/80 border border-amber-500/30 rounded px-1 shrink-0"
                            title="This model transforms a source audio file — attach a song before running.">aud in</span>
                    {/if}
                    {#if a.approxPeakGb}
                      <span class="mono text-[10px] text-bench-600 ml-auto shrink-0">{a.approxPeakGb}GB</span>
                    {/if}
                  </span>
                  {#if a.notes}
                    <span class="block text-[10.5px] text-bench-600 leading-snug mt-0.5">{a.notes}</span>
                  {/if}
                </span>
              </label>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <button
    class="flex items-center gap-1.5 rounded border border-bench-700 px-2.5 py-1 text-[12px]
           transition-colors hover:border-bench-600
           {chosen.length ? 'text-bench-100' : 'text-bench-500'}"
    onclick={() => (open = !open)}
  >
    <span class="size-1.5 rounded-full {chosen.length ? 'bg-signal' : 'bg-bench-600'}"></span>
    <span class="max-w-[220px] truncate">{label}</span>
    <span class="text-bench-600 text-[10px]">{open ? '▾' : '▴'}</span>
  </button>
</div>
