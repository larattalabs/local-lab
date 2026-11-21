<script lang="ts">
  import { lab } from '../api'
  import type { PhoneStatus } from '@shared/types'
  let { onDismiss }: { onDismiss: () => void } = $props()
  let status = $state<PhoneStatus>({ enabled: false, pending: [], devices: [] })
  let error = $state(''), busy = $state(false)
  let dialog: HTMLDialogElement
  $effect(() => {
    dialog.showModal()
    const poll = () => lab.phoneStatus().then((s) => status = s).catch((e) => error = e.message)
    void poll(); const timer = setInterval(poll, 1500); return () => clearInterval(timer)
  })
  async function action(fn: () => Promise<PhoneStatus>) {
    if (busy) return
    busy = true; error = ''
    try { status = await fn() } catch (e) { error = e instanceof Error ? e.message : String(e) }
    finally { busy = false }
  }
</script>
<dialog bind:this={dialog} onclose={onDismiss} aria-labelledby="phone-title" class="phone-dialog">
  <header><h2 id="phone-title">Phone access</h2><button onclick={onDismiss} aria-label="Close phone access">✕</button></header>
  <p>Use Local Lab on your iPhone over the same Wi-Fi. Generation stays on this Mac. Local Lab keeps the Mac awake while Phone access is enabled. Keep the lid open.</p>
  {#if error || status.error}<p role="alert" class="text-fault">{error || status.error}</p>{/if}
  <div class="phone-actions">
    <button disabled={busy} onclick={() => action(() => status.enabled ? lab.phoneDisable() : lab.phoneEnable())}>{status.enabled ? 'Disable phone access' : 'Enable phone access'}</button>
    {#if status.enabled}<button disabled={busy} onclick={() => action(() => lab.phonePair())}>Pair a device</button>{/if}
  </div>
  {#if status.enabled}
    <div class="phone-grid">
      <section>
        <h3>Open Local Lab</h3>
        {#if status.qr}<img src={status.qr} alt="QR code to open Local Lab over HTTPS" />{/if}
        <p class="mono break-all">{status.url}</p>
        <p>After setup, open in Safari and choose Share → Add to Home Screen.</p>
      </section>
      {#if status.setupUrl}
        <section>
          <h3>First-time iPhone setup</h3>
          {#if status.setupQr}<img src={status.setupQr} alt="QR code for certificate setup instructions" />{/if}
          <p>Scan this first to install and trust this Mac’s certificate. This setup page closes after five minutes.</p>
          <p class="mono break-all">{status.setupUrl}</p>
        </section>
      {/if}
    </div>
    {#if status.code}<p>Pairing code <strong class="pair-code">{status.code}</strong> · expires in {Math.max(0, Math.ceil(((status.pairingExpires ?? 0) - Date.now()) / 60000))} min</p>{/if}
    {#each status.pending as p}
      <section class="pair-request"><h3>Allow “{p.name}”?</h3><p>{p.address} · only approve the device you are pairing.</p>
        <button disabled={busy} onclick={() => action(() => lab.phoneApprove(p.id, true))}>Approve device</button>
        <button disabled={busy} onclick={() => action(() => lab.phoneApprove(p.id, false))}>Decline</button>
      </section>
    {/each}
    <details><summary>Certificate and connection help</summary>
      <p>Settings → Profile Downloaded → Install. Then General → About → Certificate Trust Settings → enable full trust for “Local Lab private Wi-Fi CA”. Compare the certificate’s SHA-256 fingerprint before trusting:</p>
      <code class="break-all">{status.fingerprint}</code>
      <p><button onclick={() => lab.phoneCertificate()}>Show certificate in Finder</button> to AirDrop it instead.</p>
      <p>If the .local hostname does not resolve, use <span class="mono">{status.ipUrl}</span> after certificate setup.</p>
      <p>If the page cannot open, use the same Wi-Fi (not a guest network), allow Local Lab through the Mac firewall if prompted, and keep the Mac awake. After changing networks, disable and re-enable Phone access.</p>
      <p>Safari and a newly added Home Screen app may need separate pairing. Pairing lasts 90 days. Revoking a device disconnects it immediately.</p>
    </details>
  {/if}
  <h3>Paired devices</h3>
  {#each status.devices as d}<div class="device"><span>{d.name}<small>Last seen {new Date(d.lastSeen).toLocaleString()}</small></span><button disabled={busy} onclick={() => action(() => lab.phoneRevoke(d.id))}>Revoke</button></div>
  {:else}<p>No devices paired yet.</p>{/each}
</dialog>
<style>
  dialog { margin:auto; width:680px; max-width:calc(100vw - 32px); max-height:calc(100dvh - 40px); padding:24px; border:1px solid #333c48; border-radius:16px; background:#101317; color:#dfe5ec; overflow:auto; }
  dialog::backdrop { background:#000b; } header,.phone-actions,.device { display:flex; justify-content:space-between; align-items:center; gap:12px; } h2 { font-size:21px; } h3 { font-size:15px; margin:18px 0 8px; } p { color:#97a3b4; line-height:1.55; margin:12px 0; } button { border:1px solid #555; border-radius:8px; padding:9px 14px; } button:hover { border-color:#d8a657; } button:disabled { opacity:.4; } .phone-actions { justify-content:flex-start; } .phone-grid { display:grid; grid-template-columns:1fr 1fr; gap:24px; } img { width:180px; border-radius:8px; } .pair-code { font-size:28px; letter-spacing:5px; color:#d8a657; } .pair-request { padding:12px; border:1px solid #d8a657; border-radius:8px; } small { display:block; color:#97a3b4; } .device { margin:12px 0; } details { margin:16px 0; } summary { cursor:pointer; } code { font-size:11px; }
</style>
