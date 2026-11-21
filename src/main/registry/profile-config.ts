import { existsSync, readFileSync } from 'node:fs'
import type { Adapter } from './types'

export const profileIssues = new Map<string,string>()
export function readProfile<T>(path:string, fallback:T, issue:string):T {
  if (!existsSync(path)) return fallback
  try {
    const value = JSON.parse(readFileSync(path,'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.')
    return value
  } catch (error) {
    profileIssues.set(issue, `Check ${path}: ${error instanceof Error ? error.message : error}`)
    return fallback
  }
}

export function unavailable(id:string, modality:'image'|'video', reason:string):Adapter {
  profileIssues.set(id, reason)
  return { id, label:id, modality, family:'Local profile', notes:reason, params:[], requires:[],
    outputExt:modality==='video'?'mp4':'png', build(){ throw new Error(reason) } }
}
