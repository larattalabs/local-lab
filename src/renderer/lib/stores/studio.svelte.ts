import { emptyStudio, studioProjects, type StudioChange, type MediaItem } from '@shared/studio'
import { lab } from '../api'
import { store } from './lab.svelte'
class StudioStore {
  data=$state(emptyStudio())
  error=$state('')
  page=$state<'create'|'library'>('create')
  selected=$state<string|null>(null)
  private sequence=0
  private initialized=false
  projects = $derived(studioProjects(store.chats,store.unfiled,[],this.data.titles))
  items = $derived(this.projects.flatMap((p)=>p.items).sort((a,b)=>b.at-a.at))
  async reload(){const seq=++this.sequence;try{const data=await lab.studioInfo();if(seq===this.sequence){this.data=data;this.error=''}}catch(e){this.error=String(e)}}
  async init(){await this.reload();if(!this.initialized){this.initialized=true;lab.onStudioUpdate(()=>{void this.reload()});lab.onSync?.(()=>{void this.reload()})}}
  async update(change:StudioChange){try{await lab.studioUpdate(change);await this.reload()}catch(e){this.error=e instanceof Error?e.message:String(e)}}
  favorite(item:MediaItem){if(item.message.outputPath)void this.update({kind:'favorite',path:item.message.outputPath,value:!this.data.favorites.includes(item.message.outputPath)})}
  select(item:MediaItem){this.selected=item.id;this.page='create';if(item.chatId)store.openChat(item.modality,item.chatId);else store.newChat(item.modality)}
}
export const studio=new StudioStore()
