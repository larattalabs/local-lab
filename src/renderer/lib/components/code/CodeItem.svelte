<script lang="ts">
  import { Check, ChevronRight, LoaderCircle, X, TriangleAlert, Info } from '@lucide/svelte'
  import type { CodeItem } from '@shared/code'
  import { diffHtml, looksLikeDiff, markdown } from '../../code/markdown'
  import { code } from '../../code/store.svelte'
  import { fileUrl } from '../../api'

  let { item, last = false }: { item: CodeItem; last?: boolean } = $props()
  let open = $state(false)

  function summary(input: string): string {
    try {
      const j = JSON.parse(input)
      const v = j.command ?? j.cmd ?? j.path ?? j.file_path ?? j.filePath ?? j.file ?? j.pattern ?? j.query ?? j.url
      if (typeof v === 'string') return v.split('\n')[0]
      // omp's hashline edit sends one `input` blob whose first line names the file.
      if (typeof j.input === 'string') return j.input.split('\n').find((l: string) => l.trim())?.replace(/^[@#*\s]+/, '') ?? 'edit'
      if (Array.isArray(j.todos)) return `${j.todos.length} items`
      return Object.keys(j).slice(0, 3).join(', ')
    } catch { return input.split('\n')[0] }
  }
</script>

{#if item.kind === 'user'}
  <div class="flex justify-end">
    <div class="user-bubble">
      {#if item.images?.length}<div class="imgs">{#each item.images as p (p)}<img src={fileUrl(p)} alt="attachment" />{/each}</div>{/if}
      {item.text}
      {#if item.delivery}<div class="delivery mono">{item.delivery === 'steer' ? 'steered mid-turn' : 'queued for after the turn'}</div>{/if}
    </div>
  </div>
{:else if item.kind === 'assistant'}
  <div class="assistant">
    {#if item.thinking}
      <details class="thinking" open={last && !item.text}>
        <summary class="mono">{last && !item.text ? 'Thinking…' : 'Thought process'}</summary>
        <div class="thinking-body">{item.thinking}</div>
      </details>
    {/if}
    {#if item.text}<div class="md">{@html markdown(item.text)}</div>{/if}
  </div>
{:else if item.kind === 'tool'}
  <div class="tool" class:error={item.state === 'error'}>
    <button class="tool-head" onclick={() => open = !open} aria-expanded={open}>
      <span class="tool-icon">
        {#if item.state === 'running'}<LoaderCircle size={13} class="spin" />{:else if item.state === 'error'}<X size={13} />{:else}<Check size={13} />{/if}
      </span>
      <span class="mono tool-name">{item.name}</span>
      <span class="mono tool-summary">{summary(item.input)}</span>
      <span class="chev" class:rot={open}><ChevronRight size={13} /></span>
    </button>
    {#if open}
      <div class="tool-body">
        {#if item.input}<div class="label">Input</div><pre class="mono">{item.input}</pre>{/if}
        {#if item.output}
          <div class="label">Output</div>
          {#if looksLikeDiff(item.output)}<pre class="mono">{@html diffHtml(item.output)}</pre>{:else}<pre class="mono">{item.output}</pre>{/if}
        {/if}
      </div>
    {/if}
  </div>
{:else if item.kind === 'approval'}
  <div class="approval" class:done={item.state !== 'pending'}>
    <div class="approval-title">{item.title}</div>
    {#if item.detail}
      {#if looksLikeDiff(item.detail)}<pre class="mono">{@html diffHtml(item.detail)}</pre>{:else}<pre class="mono">{item.detail}</pre>{/if}
    {/if}
    {#if item.state === 'pending'}
      <div class="approval-actions">
        <button class="approve" onclick={() => code.answer(item.id, true)}>Allow</button>
        <button class="deny" onclick={() => code.answer(item.id, false)}>Deny</button>
      </div>
    {:else}
      <div class="mono approval-state">{item.state === 'approved' ? 'Allowed' : 'Denied'}</div>
    {/if}
  </div>
{:else if item.kind === 'notice'}
  <div class="notice {item.level}">
    {#if item.level === 'info'}<Info size={13} />{:else}<TriangleAlert size={13} />{/if}
    <span>{item.text}</span>
  </div>
{/if}

<style>
  .user-bubble { max-width: 78%; white-space: pre-wrap; background: #1c222b; border: 1px solid #2a323d; border-radius: 12px; padding: 9px 13px; line-height: 1.5; }
  .imgs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
  .imgs img { max-width: 160px; max-height: 120px; border-radius: 6px; border: 1px solid #2a323d; object-fit: cover; }
  .delivery { font-size: 10px; color: #8d99a8; margin-top: 4px; }
  .assistant { line-height: 1.6; color: #dfe5ec; }
  .thinking { margin-bottom: 6px; }
  .thinking summary { cursor: pointer; font-size: 11px; color: #8d99a8; list-style: none; }
  .thinking summary::before { content: '▸ '; }
  .thinking[open] summary::before { content: '▾ '; }
  .thinking-body { white-space: pre-wrap; font-size: 12px; color: #8d99a8; border-left: 2px solid #2a323d; padding: 4px 0 4px 10px; margin-top: 4px; max-height: 260px; overflow: auto; }
  .md :global(p) { margin: 0 0 8px; }
  .md :global(p:last-child) { margin-bottom: 0; }
  .md :global(code) { font-family: 'SF Mono', ui-monospace, Menlo, monospace; font-size: 12px; background: #1a1f27; border-radius: 4px; padding: 1px 4px; }
  .md :global(pre.md-code) { background: #0e1115; border: 1px solid #222831; border-radius: 8px; padding: 10px 12px; overflow: auto; margin: 6px 0 10px; }
  .md :global(pre.md-code code) { background: none; padding: 0; font-size: 12px; line-height: 1.5; }
  .md :global(ul), .md :global(ol) { margin: 0 0 8px 20px; }
  .md :global(ul) { list-style: disc; } .md :global(ol) { list-style: decimal; }
  .md :global(h3), .md :global(h4), .md :global(h5), .md :global(h6) { font-weight: 600; margin: 10px 0 6px; }
  .md :global(.md-link) { color: #d8a657; }
  .tool { border: 1px solid #222831; border-radius: 8px; background: #0e1115; overflow: hidden; }
  .tool.error { border-color: #5a2f2f; }
  .tool-head { width: 100%; display: flex; align-items: center; gap: 8px; padding: 6px 10px; text-align: left; }
  .tool-head:hover { background: #141920; }
  .tool-icon { display: grid; place-items: center; color: #7fb069; width: 14px; }
  .tool.error .tool-icon { color: #d16a68; }
  .tool-name { font-size: 11.5px; color: #d8a657; flex-shrink: 0; }
  .tool-summary { font-size: 11.5px; color: #97a3b4; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; flex: 1; }
  .chev { color: #6b7787; transition: transform .12s; } .chev.rot { transform: rotate(90deg); }
  .tool-body { border-top: 1px solid #1a1f27; padding: 8px 10px; }
  .label { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: #6b7787; margin: 2px 0 4px; }
  pre { font-size: 11.5px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow: auto; margin: 0 0 6px; color: #c3ccd7; }
  pre :global(.d-add) { color: #8fc27a; } pre :global(.d-del) { color: #e08583; } pre :global(.d-hunk) { color: #7aa2c7; }
  .approval { border: 1px solid #6b5326; background: #16130d; border-radius: 8px; padding: 10px 12px; }
  .approval.done { border-color: #2a323d; background: #0e1115; }
  .approval-title { font-weight: 600; margin-bottom: 6px; white-space: pre-wrap; }
  .approval pre { background: #0b0d10; border-radius: 6px; padding: 8px; }
  .approval-actions { display: flex; gap: 8px; margin-top: 8px; }
  .approve { background: #d8a657; color: #17130b; font-weight: 600; border-radius: 6px; padding: 5px 14px; }
  .approve:hover { background: #e6b76a; }
  .deny { border: 1px solid #39424e; border-radius: 6px; padding: 5px 14px; color: #c3ccd7; }
  .deny:hover { background: #1c222b; }
  .approval-state { font-size: 11px; color: #8d99a8; }
  .notice { display: flex; gap: 6px; align-items: flex-start; font-size: 12px; color: #97a3b4; white-space: pre-wrap; }
  .notice :global(svg) { flex-shrink: 0; margin-top: 2px; }
  .notice.warning { color: #e0b46a; } .notice.error { color: #e08583; }
  :global(.spin) { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
