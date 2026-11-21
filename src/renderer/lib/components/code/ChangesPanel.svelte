<script lang="ts">
  import { RefreshCw, X, ChevronRight } from '@lucide/svelte'
  import { diffHtml } from '../../code/markdown'
  import { code } from '../../code/store.svelte'

  let open = $state<Record<string, boolean>>({})
  const totals = $derived(code.changes?.files.reduce((t, f) => ({ add: t.add + f.additions, del: t.del + f.deletions }), { add: 0, del: 0 }))
  const STATUS: Record<string, string> = { added: 'A', deleted: 'D', modified: 'M', untracked: 'U' }
</script>

<aside class="changes">
  <header>
    <span class="h">Changes</span>
    {#if code.changes?.branch}<span class="mono branch">{code.changes.branch}</span>{/if}
    {#if totals}<span class="mono tot"><span class="a">+{totals.add}</span> <span class="d">−{totals.del}</span></span>{/if}
    <div class="flex-1"></div>
    <button title="Refresh" aria-label="Refresh changes" onclick={() => code.loadChanges()}><RefreshCw size={12} class={code.changesLoading ? 'spin' : ''} /></button>
    <button title="Close" aria-label="Close changes" onclick={() => code.changesOpen = false}><X size={13} /></button>
  </header>
  <div class="files">
    {#if !code.changes}
      <p class="empty">Loading…</p>
    {:else if !code.changes.repo}
      <p class="empty">This folder isn't a git repository, so there's no diff to show. Run <code>git init</code> there (and commit) to track the agent's edits.</p>
    {:else if code.changes.error}
      <p class="empty err">{code.changes.error}</p>
    {:else if !code.changes.files.length}
      <p class="empty">No uncommitted changes in this folder.</p>
    {:else}
      {#each code.changes.files as f (f.path)}
        <div class="file">
          <button class="fh" onclick={() => open[f.path] = !open[f.path]} aria-expanded={!!open[f.path]}>
            <span class="chev" class:rot={open[f.path]}><ChevronRight size={12} /></span>
            <span class="st mono {f.status}">{STATUS[f.status] ?? '?'}</span>
            <span class="p mono" title={f.path}>{f.path}</span>
            <span class="mono n"><span class="a">+{f.additions}</span> <span class="d">−{f.deletions}</span></span>
          </button>
          {#if open[f.path]}<pre class="mono">{@html diffHtml(f.patch)}</pre>{/if}
        </div>
      {/each}
    {/if}
  </div>
</aside>

<style>
  .changes { width: min(440px, 42%); flex-shrink: 0; border-left: 1px solid #1a1f27; display: flex; flex-direction: column; background: #0a0c0f; }
  header { height: 38px; display: flex; align-items: center; gap: 8px; padding: 0 10px 0 14px; border-bottom: 1px solid #1a1f27; flex-shrink: 0; }
  header button { padding: 4px; color: #8d99a8; border-radius: 5px; } header button:hover { color: #dfe5ec; background: #161a20; }
  .h { font-weight: 600; font-size: 12.5px; }
  .branch { font-size: 10.5px; color: #8d99a8; border: 1px solid #2a323d; border-radius: 4px; padding: 0 5px; }
  .tot { font-size: 11px; }
  .a { color: #8fc27a; } .d { color: #e08583; }
  .files { flex: 1; overflow: auto; padding: 6px; }
  .empty { font-size: 12px; color: #8d99a8; padding: 10px; line-height: 1.55; }
  .empty.err { color: #e08583; }
  .empty code { background: #1a1f27; border-radius: 4px; padding: 0 4px; }
  .file { border-radius: 6px; }
  .fh { width: 100%; display: flex; align-items: center; gap: 7px; padding: 5px 6px; border-radius: 6px; text-align: left; }
  .fh:hover { background: #141920; }
  .chev { color: #6b7787; transition: transform .12s; } .chev.rot { transform: rotate(90deg); }
  .st { font-size: 10px; width: 14px; text-align: center; border-radius: 3px; }
  .st.added, .st.untracked { color: #8fc27a; } .st.deleted { color: #e08583; } .st.modified { color: #d8a657; }
  .p { flex: 1; min-width: 0; font-size: 11.5px; color: #c3ccd7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: ltr; }
  .n { font-size: 10.5px; flex-shrink: 0; }
  pre { font-size: 11px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; margin: 2px 4px 8px 26px; padding: 8px; background: #0e1115; border: 1px solid #1a1f27; border-radius: 6px; color: #c3ccd7; max-height: 480px; overflow: auto; }
  pre :global(.d-add) { color: #8fc27a; } pre :global(.d-del) { color: #e08583; } pre :global(.d-hunk) { color: #7aa2c7; }
</style>
