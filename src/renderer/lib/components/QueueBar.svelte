<script lang="ts">
  import { store } from '../stores/lab.svelte'
  const running = $derived(store.running)
  const queued = $derived(store.queuedCount)

  function elapsed(j: { startedAt?: number }): string {
    if (!j.startedAt) return ''
    return `${Math.round((Date.now() - j.startedAt) / 1000)}s`
  }
  // Re-render the timer once a second while something is running.
  let tick = $state(0)
  $effect(() => {
    if (!running) return
    const t = setInterval(() => (tick += 1), 1000)
    return () => clearInterval(t)
  })
</script>

<footer class="flex items-center gap-3 border-t border-bench-700 bg-bench-950 px-3 h-9 shrink-0 mono text-[11px]">
  {#if running}
    <span class="size-2 rounded-full bg-live animate-pulse"></span>
    <span class="text-bench-100">{running.adapterLabel}</span>
    <span class="text-bench-400">{tick >= 0 ? elapsed(running) : ''}</span>
    <button class="text-fault hover:underline" onclick={() => window.lab.cancel(running.id)}>cancel</button>
  {:else}
    <span class="size-2 rounded-full bg-bench-600"></span>
    <span class="text-bench-400">idle</span>
  {/if}
  {#if queued > 0}
    <span class="text-signal">{queued} queued</span>
  {/if}
  <div class="flex-1"></div>
  <span class="text-bench-600" title="Runs are serialised on purpose — these models are 14-41GB each.">
    one at a time
  </span>
  <button class="text-bench-400 hover:text-bench-100"
          onclick={() => { window.lab.clearFinished(); store.jobs = store.jobs.filter(j => j.state === 'running' || j.state === 'queued') }}>
    clear finished
  </button>
</footer>
