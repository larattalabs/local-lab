import { readProfile, profileIssues, unavailable } from './profile-config'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { AI_ROOT } from '../env'
import type { ParamSpec } from '@shared/types'
import type { Spawn } from './types'

interface NativeRuntime { python: string; script: string; engine: string }
const configPath = process.env.LOCALLAB_QWEN_RUNTIME ?? join(AI_ROOT, 'local-lab-private', 'qwen-runtime.json')
let runtime = readProfile<NativeRuntime | undefined>(configPath,undefined,'qwen-native-runtime')
if (runtime && !['python', 'script', 'engine'].every((k) => {
  const v = runtime![k as keyof NativeRuntime]
  return typeof v === 'string' && isAbsolute(v)
})) { profileIssues.set('qwen-native-runtime','Invalid Qwen runtime configuration in '+configPath); runtime = undefined }
if (runtime && !Object.values(runtime).every(p=>existsSync(p))) { profileIssues.set('qwen-native-runtime','Missing configured mlx-serve INT8 runtime.'); runtime=undefined }

export const nativeQwenConfigured = Boolean(runtime)
export const qwenEngineParam: ParamSpec = {
  key: 'image_engine', label: 'Generation engine', type: 'select', default: 'mlx-serve-int8',
  options: [{ value: 'mlx-serve-int8', label: 'mlx-serve INT8' }, { value: 'mflux', label: 'mflux (reference)' }],
  help: 'INT8 evaluates every step with faster, lower-precision kernels. Fine details can differ. Editing uses mflux.',
}
export function mfluxOnly(p: ParamSpec): ParamSpec {
  return { ...p, visibleWhen: { key: 'image_engine', value: 'mflux' } }
}
export function usesNativeQwen(params: Record<string, unknown>): boolean {
  const selected = params.image_engine ?? (runtime ? 'mlx-serve-int8' : 'mflux')
  if (!['mlx-serve-int8', 'mflux'].includes(String(selected))) throw new Error('Unknown Qwen generation engine.')
  if (selected === 'mlx-serve-int8' && !runtime) throw new Error('mlx-serve INT8 is not configured.')
  return selected === 'mlx-serve-int8'
}
export function qwenSpawn(reference: Spawn, params: Record<string, unknown>): Spawn {
  if (!usesNativeQwen(params)) return reference
  for (const path of [runtime!.python, runtime!.script, runtime!.engine]) {
    if (!existsSync(path)) throw new Error('mlx-serve INT8 is missing. Restore its runtime or select mflux (reference).')
  }
  if (reference.args.includes('--image-path') || reference.args.includes('--image-paths')) {
    throw new Error('Use the matching Qwen editor for reference images, or select mflux for image-strength generation.')
  }
  if (!reference.args.includes('--model')) throw new Error('Qwen INT8 needs an installed local model path.')
  return { bin: runtime!.python, args: [runtime!.script, '--engine', runtime!.engine, ...reference.args] }
}
