<script lang="ts">
 import { onMount } from 'svelte'
 import { isWeb } from '../api'
 import { basicFlow } from '../stores/basic.svelte'
 import DirectorEditor from './DirectorEditor.svelte'
 import ModifierEditor from './ModifierEditor.svelte'
 import PresetEditor from './PresetEditor.svelte'
 import type { BasicPreset } from '@shared/basic'
 let {modality,onDismiss,onHistory,onUnpair,modeChange}:{modality:'image'|'video';onDismiss:()=>void;onHistory:()=>void;onUnpair:()=>Promise<void>;modeChange:(mode:'basic'|'advanced')=>void}=$props()
 let dialog:HTMLDialogElement,editor=$state(''),preset=$state<BasicPreset>()
 const build=document.querySelector<HTMLScriptElement>('script[type=module][src]')?.src.split('/').pop()?.replace(/^index-|\.js$/g,'')??'development'
 onMount(()=>dialog.showModal())
</script>
<dialog class="studio-settings" bind:this={dialog} oncancel={onDismiss}><header><h2>Studio settings</h2><button onclick={onDismiss}>Close</button></header>
<h3>Workspace</h3>{#each ['basic','advanced'] as m}<button aria-pressed={basicFlow.mode===m} onclick={()=>modeChange(m as 'basic'|'advanced')}>{m==='basic'?'Basic':'Advanced'}</button>{/each}
<h3>Prompt settings</h3>{#each ['Directors','Moods','Intensity'] as name}<button onclick={()=>editor=name}>{name}</button>{/each}
<h3>Saved presets</h3>{#each basicFlow.catalog.presets as p}<button onclick={()=>preset=p}>{p.name}</button>{:else}<p>Save a result’s settings from its actions menu.</p>{/each}
<h3>Storage & devices</h3><button onclick={onHistory}>History & storage</button>{#if isWeb}<button onclick={onUnpair}>Unpair this device</button>{/if}
<p style="margin-top:16px;opacity:.65;font-size:12px">Local Lab · build {build}</p></dialog>
{#if editor==='Directors'}<DirectorEditor {modality} onDismiss={()=>editor=''}/>{:else if editor}<ModifierEditor initialKind={editor==='Moods'?'moods':'intensities'} onDismiss={()=>editor=''}/>{/if}
{#if preset}<PresetEditor existing={preset} onDismiss={()=>preset=undefined}/>{/if}
