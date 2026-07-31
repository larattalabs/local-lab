<script lang="ts">
  import type { Modality } from '@shared/types'
  import { store } from '../stores/lab.svelte'
  import ModelPicker from './ModelPicker.svelte'
  import ParamPanel from './ParamPanel.svelte'
  import ResultGrid from './ResultGrid.svelte'

  let { modality }: { modality: Modality } = $props()

  const adapters = $derived(store.forModality(modality))
  const selected = $derived(store.selected[modality])
  const runnable = $derived(
    selected.filter((id) => store.isAvailable(id)).length > 0 &&
      store.prompts[modality].trim().length > 0
  )
  const wantsImages = $derived(
    selected.some((id) => adapters.find((a) => a.id === id)?.acceptsImages)
  )

  function onKey(e: KeyboardEvent) {
    // Cmd-Enter runs, because you will do this hundreds of times.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && runnable) store.run(modality)
  }
</script>

<div class="flex flex-1 min-h-0">
  <!-- Left rail: what to run -->
  <aside class="w-[300px] shrink-0 border-r border-bench-700 bg-bench-850 flex flex-col min-h-0">
    <ModelPicker {modality} />
  </aside>

  <!-- Centre: prompt + results -->
  <main class="flex-1 flex flex-col min-h-0">
    <div class="border-b border-bench-700 bg-bench-900 p-3 shrink-0">
      <textarea
        class="w-full resize-none rounded bg-bench-850 border border-bench-700 p-2.5 text-[13px]
               leading-relaxed outline-none focus:border-bench-600 placeholder:text-bench-600"
        rows="3"
        placeholder={modality === 'text'
          ? 'Ask the models something…'
          : `Describe what you want ${modality === 'music' ? 'to hear' : 'to see'}…`}
        bind:value={store.prompts[modality]}
        onkeydown={onKey}
      ></textarea>

      <div class="flex items-center gap-2 mt-2">
        {#if wantsImages}
          <button
            class="mono text-[11px] px-2 py-1 rounded border border-bench-700 text-bench-300
                   hover:border-bench-600 hover:text-bench-100"
            onclick={async () => (store.images = await window.lab.pickImages())}
          >
            {store.images.length ? `${store.images.length} image(s)` : 'attach images'}
          </button>
          {#if store.images.length}
            <button class="mono text-[11px] text-bench-400 hover:text-fault"
                    onclick={() => (store.images = [])}>clear</button>
          {/if}
        {/if}
        <div class="flex-1"></div>
        <span class="mono text-[11px] text-bench-600">⌘↩</span>
        <button
          class="px-4 py-1.5 rounded text-[12px] font-medium transition-colors
                 {runnable
                   ? 'bg-signal text-bench-950 hover:brightness-110'
                   : 'bg-bench-800 text-bench-600 cursor-not-allowed'}"
          disabled={!runnable}
          onclick={() => store.run(modality)}
        >
          Run {selected.filter((id) => store.isAvailable(id)).length || ''}
        </button>
      </div>
    </div>

    <ResultGrid {modality} />
  </main>

  <!-- Right rail: how to run it -->
  <aside class="w-[300px] shrink-0 border-l border-bench-700 bg-bench-850 overflow-y-auto">
    <ParamPanel {modality} />
  </aside>
</div>
