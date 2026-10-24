<script lang="ts">
  import type { Modality, AdapterInfo } from '@shared/types'
  import { store } from '../stores/lab.svelte'
  import ModelSettings from './ModelSettings.svelte'
  let { modality }: { modality: Modality } = $props()
  const chosen = $derived(store.selected[modality]
    .map((id) => store.adapters.find((a) => a.id === id))
    .filter((a): a is AdapterInfo => Boolean(a)))
</script>

<div class="p-3 border-b border-bench-700">
  <div class="mono text-[10px] tracking-widest text-bench-400">SETTINGS</div>
</div>
{#if !chosen.length}
  <p class="p-3 text-[12px] text-bench-600 leading-relaxed">
    Select a model to configure it. Pick several to run the same prompt across all of them.
  </p>
{/if}
{#each chosen as a (a.id)}
  <section class="border-b border-bench-700 p-3">
    <div class="text-[12px] text-bench-100 mb-2">{a.label}</div>
    <ModelSettings adapter={a} values={store.resolvedParams(a)}
                   onchange={(key, value) => store.setParam(a.id, key, value)} />
  </section>
{/each}
