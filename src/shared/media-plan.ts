import type { AdapterInfo } from './types'

export function editTarget(model: AdapterInfo) {
  return model.imageEditAdapterId ?? (model.acceptsImages && !model.promptOptional ? model.id : undefined)
}

export function matchResolution(model: AdapterInfo, ratio: number, preferred = '512x512') {
  const options = model.params.find(p => p.key === 'resolution')?.options ?? []
  const [width, height] = preferred.split('x').map(Number)
  const score = (value: string) => {
    const [w,h] = value.split('x').map(Number)
    return Math.abs(Math.log(w / h / ratio)) + 0.1 * Math.abs(Math.log(w*h/(width*height)))
  }
  return options.slice().sort((a,b) => score(a.value)-score(b.value))[0]?.value
}

export function motionPlan(model: AdapterInfo, ratio: number, seconds: number, fast: boolean) {
  const settings: Record<string, unknown> = {}
  const fps = model.frameRate ?? 24
  const resolution = matchResolution(model,ratio)
  if (resolution) settings.resolution = resolution
  const frames = model.params.find(p => p.key === 'frames')?.options
  if (frames?.length) settings.frames = frames.slice().sort((a,b) => Math.abs(+a.value / fps-seconds)-Math.abs(+b.value / fps-seconds))[0].value
  for (const [key,value] of Object.entries({stage1_steps:fast?'4':'8', decoder:'conv', no_audio:true, compute_precision:'float16'})) {
    const setting = model.params.find(p => p.key === key)
    if (setting && (!setting.options || setting.options.some(o=>o.value===value))) settings[key] = value
  }
  return settings
}
