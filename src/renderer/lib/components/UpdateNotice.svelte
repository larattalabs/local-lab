<script lang="ts">
  import { onMount } from 'svelte'
  import { RefreshCw, X } from '@lucide/svelte'
  import { webRequest } from '../api'
  import { basicFlow } from '../stores/basic.svelte'
  import { directorFlow } from '../stores/director.svelte'
  let available=$state(false), hidden=$state(false),checking=$state(false)
  let initial='', latest='', dismissed=''
  const loadedBundle = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src
  const pending=$derived(basicFlow.busy||!!directorFlow.session)
  async function check(){
    if(checking||document.visibilityState==='hidden')return;checking=true
    try{const data=await webRequest('/api/version');if((loadedBundle && data.bundle && new URL(data.bundle,location.href).href!==loadedBundle)||(initial&&data.version!==initial)){available=true;latest=data.version;hidden=dismissed===latest}else if(!initial)initial=data.version}catch{/* The connection banner owns connectivity errors. */}finally{checking=false}
  }
  onMount(()=>{void check();const timer=setInterval(()=>void check(),60000);const visible=()=>void check();window.addEventListener('focus',visible);document.addEventListener('visibilitychange',visible);return()=>{clearInterval(timer);window.removeEventListener('focus',visible);document.removeEventListener('visibilitychange',visible)}})
</script>
{#if available&&!hidden}<div class="update-notice" role="status"><RefreshCw size={16}/><span>Local Lab has an update.{#if pending} Finish this prompt first.{:else} Your saved drafts will stay.{/if}</span><button disabled={pending} onclick={()=>window.location.reload()}>Refresh</button><button aria-label="Dismiss update notice" onclick={()=>{hidden=true;dismissed=latest}}><X size={16}/></button></div>{/if}
<style>.update-notice{display:flex;align-items:center;gap:10px;padding:10px 16px;background:#30291e;color:#e4c58f;font-size:13px;flex-shrink:0}.update-notice span{flex:1}.update-notice button{padding:6px 9px;border-radius:6px;background:#443721;font-size:12px}.update-notice button:disabled{opacity:.4}@media(max-width:800px){.update-notice{font-size:12px;padding:8px 10px}.update-notice button{min-height:40px}}</style>
