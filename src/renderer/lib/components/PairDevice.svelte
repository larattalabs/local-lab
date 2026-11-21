<script lang="ts">
  import { onMount } from 'svelte'
  import { webRequest } from '../api'
  let { onPaired }: { onPaired: () => void } = $props()
  let code = $state(''), name = $state('My iPhone'), error = $state(''), waiting = $state(false), busy = $state(false)
  onMount(() => { void webRequest('/api/pair').then((v) => { if (v.paired) onPaired(); else if (v.pending) waiting = true }).catch(() => {}) })
  $effect(() => {
    if (!waiting) return
    const timer = setInterval(async () => {
      try { const v = await webRequest('/api/pair'); if (v.paired) { waiting = false; onPaired() } }
      catch (e) { error = e instanceof Error ? e.message : String(e); waiting = false }
    }, 1500)
    return () => clearInterval(timer)
  })
  async function pair(e: SubmitEvent) {
    e.preventDefault(); busy = true; error = ''
    try { await webRequest('/api/pair', { code: code.trim(), name }); waiting = true }
    catch (e) { error = e instanceof Error ? e.message : String(e) }
    finally { busy = false }
  }
</script>
<main class="pair-page">
  <img src="/icon.png" alt="" width="80" height="80" />
  <h1>Local Lab</h1><p>Your Mac’s models, on your phone.</p>
  {#if waiting}<h2>Approve this device on your Mac</h2><p>Open Phone access in Local Lab and approve “{name}”. Keep this page open.</p>
  {:else}<form onsubmit={pair}>
    <p>On your Mac, open <b>Phone access → Pair a device</b>.</p>
    <label>Device name<input autocomplete="off" maxlength="60" required bind:value={name} /></label>
    <label>Six-digit pairing code<input inputmode="numeric" pattern={'[0-9]{6}'} maxlength="6" autocomplete="one-time-code" required bind:value={code} /></label>
    <button disabled={busy}>{busy ? 'Connecting…' : 'Request pairing'}</button>
  </form>{/if}
  {#if error}<p role="alert" class="text-fault">{error}</p>{/if}
  <p class="hint">Stay on the same Wi-Fi. Keep Local Lab open on the Mac. Add this page to your Home Screen from Safari’s Share menu.</p>
</main>
<style>
  main { width:100%; max-width:460px; margin:auto; padding:32px 24px; overflow:auto; } img { border-radius:20px; margin-bottom:20px; } h1 { font-size:30px; font-weight:600; } h2 { font-size:20px; margin-top:24px; } p { color:#97a3b4; margin:14px 0; line-height:1.6; } label { display:block; margin:18px 0; } input { display:block; width:100%; border:1px solid #333c48; background:#161a20; border-radius:10px; padding:12px; margin-top:6px; font-size:18px; } button { background:#d8a657; color:#08090b; padding:14px; border-radius:10px; width:100%; font-weight:600; } .hint { font-size:13px; margin-top:30px; }
</style>
