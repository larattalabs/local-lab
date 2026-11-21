<script lang="ts">
  import { onMount } from 'svelte'
  import type { HistoryPreview } from '@shared/history-reset'
  import { lab } from '../api'
  let { onDismiss }: { onDismiss: () => void } = $props()
  let dialog: HTMLDialogElement
  let preview = $state<HistoryPreview>(), confirmation = $state(''), loading = $state(false), clearing = $state(false), error = $state('')
  const size = (bytes: number) => bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`
  async function refresh() {
    loading = true; error = ''; confirmation = ''; preview = undefined
    try { preview = await lab.historyPreview() } catch(e) { error = e instanceof Error ? e.message : String(e) } finally { loading = false }
  }
  async function clear() {
    if (!preview || confirmation !== 'CLEAR' || clearing) return
    clearing = true; error = ''
    try {
      await lab.historyClear({ token: preview.token, confirmation })
      // The reset notification reloads all connected clients. Reload here as a fallback.
      window.location.reload()
    } catch(e) { error = e instanceof Error ? e.message : String(e); clearing = false; confirmation = '' }
  }
  onMount(() => { dialog.showModal(); void refresh() })
</script>
<dialog bind:this={dialog} aria-labelledby="history-title" oncancel={(e) => { e.preventDefault(); if (!clearing) onDismiss() }} class="history-dialog">
    <header><div><p class="eyebrow">SETTINGS</p><h2 id="history-title">History & storage</h2></div><button class="close" aria-label="Close history settings" disabled={clearing} onclick={onDismiss}>×</button></header>
    <h3>Start fresh</h3>
    <p>Clear all chats, generated images, videos, audio, uploaded references, favorites and unfinished drafts on this Mac and its paired phones.</p>
    {#if preview}<div class="summary"><span><strong>{preview.chats}</strong> chats</span><span><strong>{preview.images}</strong> images</span><span><strong>{preview.videos}</strong> videos</span>{#if preview.audio}<span><strong>{preview.audio}</strong> audio files</span>{/if}<span><strong>{size(preview.bytes)}</strong> total</span></div>{/if}
    <p class="kept">Your models, identity adapters, presets, directors, moods, intensity settings and phone pairing stay saved. Preset thumbnails and character portraits will be cleared.</p>
    <p>Files move to the <strong>Mac’s Trash</strong>. Empty Trash to reclaim the space. Copies saved elsewhere and your training images stay where they are.</p>
    {#if preview?.busy}<p class="notice" role="status">Wait for generation, prompt preparation and uploads to finish, or cancel them first. Then refresh the summary.</p>{/if}
    {#if error}<p class="notice" role="alert">{error}</p>{/if}
    <label for="clear-confirmation">Type <strong>CLEAR</strong> to confirm for all devices</label>
    <input id="clear-confirmation" bind:value={confirmation} autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="CLEAR" disabled={clearing || loading || !preview || preview.busy} />
    <footer><button class="secondary" disabled={clearing || loading} onclick={refresh}>{loading ? 'Checking…' : 'Refresh summary'}</button><button class="danger" disabled={!preview || preview.busy || loading || clearing || confirmation !== 'CLEAR'} onclick={clear}>{clearing ? 'Moving to Trash…' : 'Move history to Trash'}</button></footer>
</dialog>
<style>
  .history-dialog::backdrop{background:#080b10cc;backdrop-filter:blur(8px)}
  .history-dialog{margin:auto;width:calc(100% - 24px);max-width:560px;max-height:calc(100dvh - 40px);overflow:auto;background:#171d26;border:1px solid #394451;border-radius:20px;padding:26px;box-shadow:0 24px 80px #0008;color:#dfe5ed;font-size:14px;line-height:1.6}
  header{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}.eyebrow{font-size:10px;letter-spacing:2px;color:#bda675;margin:0}h2{font-size:23px;font-weight:600;margin:2px 0 0}h3{font-size:17px;font-weight:600;margin:0 0 8px}p{margin:12px 0;color:#afbaca}.close{font-size:28px;padding:0 8px;color:#b8c2d0}.summary{display:flex;gap:12px;flex-wrap:wrap;background:#10151d;border:1px solid #303b48;border-radius:12px;padding:14px;margin:18px 0}.summary span{white-space:nowrap;color:#9eacbd;font-size:12px}.summary strong{color:#e6ebf1}.kept{border-left:2px solid #bda675;padding-left:12px}.notice{color:#f2ba98;background:#412b2422;padding:10px;border:1px solid #795443;border-radius:8px}label{display:block;font-size:12px;margin-top:22px}input{display:block;width:100%;background:#0e141c;color:#edf1f7;border:1px solid #475363;border-radius:9px;padding:10px 12px;margin-top:8px;font-size:15px}footer{display:flex;gap:10px;justify-content:space-between;margin-top:18px}footer button{border-radius:9px;padding:10px 13px;font-size:12px;font-weight:600}.secondary{border:1px solid #465261}.danger{background:#a3423d;color:white}button:disabled{opacity:.4;cursor:not-allowed}button:focus-visible,input:focus-visible{outline:2px solid #e2b865;outline-offset:3px}@media(max-width:500px){.history-dialog{padding:20px;max-height:calc(100dvh - 24px)}footer{flex-direction:column-reverse}footer button{width:100%}}
</style>
