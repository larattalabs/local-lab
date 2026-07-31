<script lang="ts">
  import { MODALITIES, type Modality } from '@shared/types'
  import { store } from './lib/stores/lab.svelte'
  import Workbench from './lib/components/Workbench.svelte'
  import QueueBar from './lib/components/QueueBar.svelte'

  let active = $state<Modality>('image')
  let ready = $state(false)

  $effect(() => {
    store.init().then(() => (ready = true))
  })
</script>

<div class="flex h-full flex-col">
  <header class="titlebar flex items-center gap-1 border-b border-bench-700 bg-bench-950 pl-20 pr-3 h-11 shrink-0">
    <span class="mono text-[11px] tracking-widest text-bench-400 mr-4">LOCAL&nbsp;LAB</span>
    {#each MODALITIES as m}
      <button
        class="px-3 py-1.5 rounded text-[12px] transition-colors
               {active === m.id ? 'bg-bench-700 text-bench-100' : 'text-bench-400 hover:text-bench-100'}"
        title={m.blurb}
        onclick={() => (active = m.id)}
      >{m.label}</button>
    {/each}
    <div class="flex-1"></div>
    <button class="mono text-[11px] text-bench-400 hover:text-bench-100 px-2 py-1"
            onclick={() => window.lab.openRuns()}>runs&nbsp;↗</button>
  </header>

  {#if ready}
    <Workbench modality={active} />
  {:else}
    <div class="flex-1 grid place-items-center text-bench-400 mono text-[12px]">
      scanning for local models…
    </div>
  {/if}

  <QueueBar />
</div>
