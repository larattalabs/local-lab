import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, realpathSync } from 'node:fs'
import { join, extname, sep } from 'node:path'
import { emptyStudio, type StudioChange, type StudioData } from '@shared/studio'
export class StudioService {
  private data:StudioData
  private file:string
  private listeners=new Set<()=>void>()
  constructor(settings:string,private runs:string){mkdirSync(settings,{recursive:true});this.file=join(settings,'studio.json');this.data=existsSync(this.file)?{...emptyStudio(),...JSON.parse(readFileSync(this.file,'utf8'))}:emptyStudio()}
  resetHistory(){
    const next={...emptyStudio(),presetFavorites:[...this.data.presetFavorites]}
    writeFileSync(this.file+'.tmp',JSON.stringify(next,null,2),{mode:0o600});renameSync(this.file+'.tmp',this.file);this.data=next;for(const fn of this.listeners)fn()
  }
  info(){return structuredClone(this.data)}
  onChange(fn:()=>void){this.listeners.add(fn);return()=>this.listeners.delete(fn)}
  private media(path:string,imageOnly=false){const real=realpathSync(path);if(!real.startsWith(realpathSync(this.runs)+sep)||!(imageOnly?['.png','.jpg','.jpeg','.webp']:['.png','.jpg','.jpeg','.webp','.mp4']).includes(extname(real).toLowerCase()))throw new Error('Choose media in the library.');return real}
  update(input:StudioChange){
    if(!input||typeof input!=='object')throw new Error('Invalid library change.')
    const next=this.info()
    if(input.kind==='favorite'){
      if(typeof input.value!=='boolean'||typeof input.path!=='string')throw new Error('Invalid favorite.')
      const path=this.media(input.path);next.favorites=next.favorites.filter((p)=>p!==path);if(input.value)next.favorites.push(path)
    }else if(input.kind==='title'){
      if(!/^[a-z0-9-]{1,100}$/i.test(input.id)||typeof input.title!=='string'||!input.title.trim()||input.title.length>100)throw new Error('Use a project name of 1–100 characters.')
      next.titles[input.id]=input.title.trim()
    }else if(input.kind==='presetFavorite'){
      if(!/^[a-z0-9-]{1,100}$/i.test(input.id)||typeof input.value!=='boolean')throw new Error('Invalid preset favorite.')
      next.presetFavorites=next.presetFavorites.filter((id)=>id!==input.id);if(input.value)next.presetFavorites.push(input.id)
    }else if(input.kind==='subjectImage'){
      if(!/^[a-z0-9-]{1,100}$/i.test(input.id)||typeof input.thumbnail!=='string')throw new Error('Invalid character portrait.')
      const thumbnail=this.media(input.thumbnail,true);next.subjectImages=[...next.subjectImages.filter((v)=>v.id!==input.id),{id:input.id,thumbnail}]
    }else throw new Error('Unknown library change.')
    if(next.favorites.length>5000||Object.keys(next.titles).length>5000||next.presetFavorites.length>100||next.subjectImages.length>100)throw new Error('Library limit reached.')
    writeFileSync(this.file+'.tmp',JSON.stringify(next,null,2),{mode:0o600});renameSync(this.file+'.tmp',this.file);this.data=next;for(const fn of this.listeners)fn();return this.info()
  }
}
