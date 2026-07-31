<script lang="ts">
  import type { Modality, AdapterInfo, ParamSpec } from '@shared/types'
  import { store } from '../stores/lab.svelte'

  let { modality }: { modality: Modality } = $props()
  const chosen = $derived(
    store.selected[modality]
      .map((id) => store.adapters.find((a) => a.id === id))
      .filter((a): a is AdapterInfo => Boolean(a))
  )
  let showAdvanced = $state<Record<string, boolean>>({})

  function set(id: string, p: ParamSpec, raw: string | boolean) {
    let v: unknown = raw
    if (p.type === 'int') v = raw === '' ? null : parseInt(String(raw), 10)
    else if (p.type === 'float') v = raw === '' ? null : parseFloat(String(raw))
    else if (p.type === 'seed') v = raw === '' ? null : parseInt(String(raw), 10)
    if (typeof v === 'number' && Number.isNaN(v)) v = null
    store.setParam(id, p.key, v)
  }
</script>

<div class="p-3 border-b border-bench-700">
  <div class="mono text-[10px] tracking-widest text-bench-400">SETTINGS</div>
</div>

{#if !chosen.length}
  <p class="p-3 text-[12px] text-bench-600 leading-relaxed">
    Select a model to configure it. Pick several to run the same prompt across all of them.
  </p>
{/if}

{#each chosen as a}
  {@const basic = a.params.filter((p) => !p.advanced)}
  {@const adv = a.params.filter((p) => p.advanced)}
  <section class="border-b border-bench-700 p-3">
    <div class="text-[12px] text-bench-100 mb-2">{a.label}</div>

    {#each basic as p}
      {@render field(a, p)}
    {/each}

    {#if adv.length}
      <button class="mono text-[10px] text-bench-500 hover:text-bench-300 mt-1"
              onclick={() => (showAdvanced[a.id] = !showAdvanced[a.id])}>
        {showAdvanced[a.id] ? '− advanced' : '+ advanced'}
      </button>
      {#if showAdvanced[a.id]}
        <div class="mt-2 space-y-2">
          {#each adv as p}{@render field(a, p)}{/each}
        </div>
      {/if}
    {/if}
  </section>
{/each}

{#snippet field(a: AdapterInfo, p: ParamSpec)}
  {@const val = store.param(a, p.key)}
  <label class="block mb-2">
    <span class="mono text-[10px] text-bench-400 block mb-1">{p.label}</span>
    {#if p.type === 'select'}
      <select class="w-full rounded bg-bench-900 border border-bench-700 px-2 py-1 text-[12px]"
              value={String(val ?? '')}
              onchange={(e) => set(a.id, p, e.currentTarget.value)}>
        {#each p.options ?? [] as o}<option value={o.value}>{o.label}</option>{/each}
      </select>
    {:else if p.type === 'bool'}
      <input type="checkbox" checked={Boolean(val)}
             onchange={(e) => set(a.id, p, e.currentTarget.checked)} />
    {:else if p.type === 'string'}
      <input class="w-full rounded bg-bench-900 border border-bench-700 px-2 py-1 text-[12px]"
             value={String(val ?? '')}
             oninput={(e) => set(a.id, p, e.currentTarget.value)} />
    {:else}
      <input class="w-full mono rounded bg-bench-900 border border-bench-700 px-2 py-1 text-[12px]"
             type="number" min={p.min} max={p.max} step={p.step ?? 1}
             placeholder={p.type === 'seed' ? 'random' : ''}
             value={val ?? ''}
             oninput={(e) => set(a.id, p, e.currentTarget.value)} />
    {/if}
    {#if p.help}<span class="text-[10px] text-bench-600 leading-snug block mt-0.5">{p.help}</span>{/if}
  </label>
{/snippet}
