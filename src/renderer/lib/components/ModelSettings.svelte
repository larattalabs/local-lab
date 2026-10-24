<script lang="ts">
  import type { AdapterInfo, ParamSpec } from '@shared/types'
  let { adapter, values, onchange }: {
    adapter: AdapterInfo
    values: Record<string, unknown>
    onchange: (key: string, value: unknown) => void
  } = $props()
  let advanced = $state(false)
  const basic = $derived(adapter.params.filter((p) => !p.advanced))
  const extra = $derived(adapter.params.filter((p) => p.advanced))
  function set(p: ParamSpec, raw: string | boolean) {
    let value: unknown = raw
    if (p.type === 'int' || p.type === 'seed') value = raw === '' ? null : parseInt(String(raw), 10)
    if (p.type === 'float') value = raw === '' ? null : parseFloat(String(raw))
    if (typeof value === 'number' && Number.isNaN(value)) value = null
    onchange(p.key, value)
  }
</script>

{#each basic as p}{@render field(p)}{/each}
{#if extra.length}
  <button type="button" class="mono text-[10px] text-bench-500 hover:text-bench-300 mt-1"
          aria-expanded={advanced} onclick={() => (advanced = !advanced)}>
    {advanced ? '− advanced' : '+ advanced'}
  </button>
  {#if advanced}<div class="mt-2 space-y-2">{#each extra as p}{@render field(p)}{/each}</div>{/if}
{/if}

{#snippet field(p: ParamSpec)}
  {@const value = Object.hasOwn(values, p.key) ? values[p.key] : p.default}
  <label class="block mb-2">
    <span class="mono text-[10px] text-bench-400 block mb-1">{p.label}</span>
    {#if p.type === 'select'}
      <select class="w-full rounded bg-bench-900 border border-bench-700 px-2 py-1 text-[12px]"
              value={String(value ?? '')} onchange={(e) => set(p, e.currentTarget.value)}>
        {#each p.options ?? [] as o}<option value={o.value}>{o.label}</option>{/each}
      </select>
    {:else if p.type === 'bool'}
      <input type="checkbox" checked={Boolean(value)} onchange={(e) => set(p, e.currentTarget.checked)} />
    {:else if p.type === 'string'}
      <input class="w-full rounded bg-bench-900 border border-bench-700 px-2 py-1 text-[12px]"
             value={String(value ?? '')} oninput={(e) => set(p, e.currentTarget.value)} />
    {:else}
      <input class="w-full mono rounded bg-bench-900 border border-bench-700 px-2 py-1 text-[12px]"
             type="number" min={p.min} max={p.max} step={p.step ?? 1}
             placeholder={p.type === 'seed' ? 'random' : ''} value={value ?? ''}
             oninput={(e) => set(p, e.currentTarget.value)} />
    {/if}
    {#if p.help}<span class="text-[10px] text-bench-600 leading-snug block mt-0.5">{p.help}</span>{/if}
  </label>
{/snippet}
