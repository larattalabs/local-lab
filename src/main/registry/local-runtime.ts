import { readProfile, profileIssues, unavailable } from './profile-config'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { AI_ROOT } from '../env'

interface RuntimeProfile { model?: string; encoder?: string; script?: string }
const path = process.env.LOCALLAB_RUNTIME_PROFILES ?? join(AI_ROOT, 'local-lab-private', 'runtime-profiles.json')
const profiles: { models?: Record<string, RuntimeProfile> } = readProfile(path, {}, 'runtime-profiles')

/** Private, model-specific component views; stock files and public defaults stay intact. */
export function runtimeProfile(id: string): RuntimeProfile {
  const globalIssue = profileIssues.get('runtime-profiles')
  if (globalIssue) profileIssues.set(id,globalIssue)
  const profile = profiles.models?.[id] ?? {}
  for (const [key, value] of Object.entries(profile)) {
    if (!['model', 'encoder', 'script'].includes(key) || typeof value !== 'string' || !isAbsolute(value)) {
      profileIssues.set(id,`Invalid local runtime profile for ${id} in ${path}`); return {}
    }
  }
  return profile
}
