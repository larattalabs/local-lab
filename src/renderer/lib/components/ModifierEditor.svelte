<script lang="ts">
  import { onMount } from 'svelte'
  import { Plus, Copy, RotateCcw, Trash2, X } from '@lucide/svelte'
  import { defaultModifiers, type ModifierConfig, type ModifierKind } from '@shared/modifiers'
  import { basicFlow as basic } from '../stores/basic.svelte'
  let { initialKind = 'moods', onDismiss }: { initialKind?: ModifierKind; onDismiss: () => void } = $props()
  let dialog = $state<HTMLDialogElement>()
  let draft = $state<ModifierConfig>(defaultModifiers())
  let kind = $state<ModifierKind>('moods'), selected = $state('')
  let loading = $state(true), busy = $state(false), error = $state(''), baseline = $state('')
  let confirm = $state<'close' | 'reload' | 'delete' | null>(null)
  const current = $derived(draft[kind].find((p) => p.id === selected))
  const builtIn = $derived(defaultModifiers()[kind].find((p) => p.id === selected))
  const dirty = $derived(!loading && !!baseline && JSON.stringify(draft) !== baseline)
  const stale = $derived(!loading && basic.catalog.modifiers.revision !== draft.revision)
  async function load() {
    loading = true; error = ''; confirm = null
    try {
      await basic.reload(); draft = structuredClone($state.snapshot(basic.catalog.modifiers))
      baseline = JSON.stringify(draft)
      if (!draft[kind].some((p) => p.id === selected)) selected = draft[kind][0].id
    } catch (e) { error = String(e) } finally { loading = false }
  }
  onMount(() => { kind = initialKind; dialog?.showModal(); void load() })
  function switchKind(next: ModifierKind) { kind = next; selected = draft[next][0].id; confirm = null }
  function create(duplicate = false) {
    const id = crypto.randomUUID()
    draft[kind].push(duplicate && current ? { ...current, id, name: (current.name + ' copy').slice(0, 60) } : { id, name: '', description: '', instructions: '', motionInstructions: '' })
    selected = id; confirm = null
  }
  function close() { if (busy) return; if (dirty) confirm = 'close'; else onDismiss() }
  async function save() {
    busy = true; error = ''; confirm = null
    try { await basic.configureModifiers(draft); onDismiss() }
    catch (e) { error = e instanceof Error ? e.message : String(e) }
    finally { busy = false }
  }
</script>
<dialog bind:this={dialog} aria-labelledby="modifier-title" oncancel={(e) => { e.preventDefault(); close() }} class="modifier-editor">
  <header><div><h2 id="modifier-title">Moods & intensity</h2><p>Shared options for Basic 18+ and presets using the Adult editorial director.</p></div><button aria-label="Close mood and intensity editor" disabled={busy} onclick={close}><X size={20}/></button></header>
  <nav aria-label="Modifier editors"><button aria-pressed={kind === 'moods'} disabled={loading || busy} onclick={() => switchKind('moods')}>Moods</button><button aria-pressed={kind === 'intensities'} disabled={loading || busy} onclick={() => switchKind('intensities')}>Intensity levels</button></nav>
  {#if loading}<p role="status" class="message">Loading saved options…</p>{:else}
    <div class="editor-body"><fieldset disabled={busy || !baseline}>
      <div class="editor-picker"><label>{kind === 'moods' ? 'Mood to edit' : 'Intensity to edit'}<select value={selected} onchange={(e) => { selected = e.currentTarget.value; confirm = null }}>{#each draft[kind] as p}<option value={p.id}>{p.name || 'Untitled option'}</option>{/each}</select></label><button disabled={draft[kind].length >= 30} onclick={() => create()}><Plus size={16}/>New</button><button disabled={!current || draft[kind].length >= 30} onclick={() => create(true)}><Copy size={16}/>Duplicate</button></div>
      {#if current}
        <label>Name<input bind:value={current.name} maxlength="60" placeholder={kind === 'moods' ? 'e.g. Vintage studio' : 'e.g. Medium · Bold'}/></label>
        <label>Short description<input bind:value={current.description} maxlength="240" placeholder="Describe how this option should feel"/></label>
        <label>Prompt instructions<textarea bind:value={current.instructions} rows="5" maxlength="2000" placeholder="Leave blank to add no extra instructions."></textarea></label>
        <p class="hint">Added to image, edit, and video requests before prompt assistance. These instructions also apply when assistance is off. Keep wardrobe and requested action explicit.</p>
        <label>Additional video instructions<textarea bind:value={current.motionInstructions} rows="3" maxlength="1000" placeholder="Optional direction for movement, camera, and timing."></textarea></label>
        <p class="hint">Intensity changes presentation; creative freedom remains a separate director setting. Built-in Low starts with blank instructions to preserve the existing treatment.</p>
        <div class="entry-actions">{#if builtIn}<button onclick={() => { draft[kind] = draft[kind].map((p) => p.id === selected ? { ...builtIn! } : p) }}><RotateCcw size={15}/>Restore built-in</button>{:else}<button onclick={() => confirm = 'delete'}><Trash2 size={15}/>Delete option…</button>{/if}</div>
      {/if}
    </fieldset></div>
  {/if}
  {#if stale}<p class="message" role="status">Saved options changed on another device. Reload before saving; your edits are still here.</p>{/if}
  {#if error}<p class="message error" role="alert">{error}</p>{/if}
  {#if confirm}<div class="confirmation"><p>{confirm === 'delete' ? 'Remove this custom option? Existing results retain their saved instructions.' : 'Discard unsaved changes?'}</p><button disabled={busy} onclick={() => { if (confirm === 'delete') { draft[kind] = draft[kind].filter((p) => p.id !== selected); selected = draft[kind][0].id; confirm = null } else if (confirm === 'reload') void load(); else onDismiss() }}>{confirm === 'delete' ? 'Remove option' : 'Discard changes'}</button><button onclick={() => confirm = null}>Keep editing</button></div>{/if}
  <footer><button disabled={busy || loading} onclick={() => dirty ? confirm = 'reload' : void load()}>Reload saved</button><span>{dirty ? 'Unsaved changes' : 'Saved on your Mac'}</span><button class="primary" disabled={busy || loading || !dirty || stale || [...draft.moods,...draft.intensities].some((p) => !p.name.trim())} onclick={save}>{busy ? 'Saving…' : 'Save changes'}</button></footer>
</dialog>
<style>
  dialog{margin:auto;padding:0;width:760px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);overflow:auto;background:#141920;color:#e5e9ef;border:1px solid #3a4350;border-radius:16px}dialog[open]{display:flex;flex-direction:column}header,nav,footer{flex-shrink:0}header>button{align-self:flex-start;width:44px;height:44px;padding:10px;flex-shrink:0}.editor-body{overflow:auto;min-height:0;flex:1}dialog::backdrop{background:#000b;backdrop-filter:blur(5px)}header{display:flex;justify-content:space-between;gap:14px;padding:22px 24px 14px}h2{font-size:22px;font-weight:550}header p,.hint,.message,.confirmation p{font-size:13px;color:#a9b4c3;line-height:1.5;margin-top:8px}header p{max-width:550px}button{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:9px 12px;border:1px solid #3a4350;border-radius:8px;font-size:13px;color:#dec28f}button:disabled{opacity:.45}nav{display:flex;gap:8px;padding:0 24px 14px;border-bottom:1px solid #303843}nav button[aria-pressed=true]{background:#382f21;border-color:#a68850}fieldset{border:0;padding:20px 24px}label{display:block;font-size:13px;color:#c5cdd8;margin-bottom:14px}input,select,textarea{display:block;width:100%;margin-top:7px;border:1px solid #3a4350;border-radius:8px;background:#0c1118;color:#e5e9ef;padding:10px;font-size:14px}textarea{resize:vertical;line-height:1.55;min-height:75px} .hint{margin:-5px 0 18px}.editor-picker{display:flex;align-items:center;gap:8px}.editor-picker label{flex:1;min-width:0}.entry-actions{display:flex;gap:8px}.message{padding:0 24px 12px}.error{color:#f1aaa3}.confirmation{margin:0 24px 18px;padding:14px;border:1px solid #6f5634;border-radius:9px}.confirmation p{margin:0 0 12px}.confirmation button+button{margin-left:8px}footer{background:#141920;position:relative;z-index:1;display:flex;align-items:center;gap:10px;padding:16px 24px;border-top:1px solid #303843}footer span{flex:1;font-size:12px;color:#a9b4c3}.primary{background:#d6b478;color:#151922;border-color:#d6b478}@media(max-width:700px){dialog{max-width:100vw;width:100vw;max-height:90dvh;margin:auto 0 0;border-radius:18px 18px 0 0;padding-bottom:env(safe-area-inset-bottom)}header,fieldset{padding:16px}nav{padding:0 16px 12px}.editor-picker{flex-wrap:wrap;margin-bottom:16px}.editor-picker label{min-width:100%;margin:0}button{min-height:44px}footer{padding:14px 16px;flex-wrap:wrap}footer span{order:3;min-width:100%}footer .primary{margin-left:auto}.message{padding:0 16px 12px}}
</style>
