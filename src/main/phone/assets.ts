import { createHmac, timingSafeEqual } from 'node:crypto'
import { createReadStream, realpathSync, statSync } from 'node:fs'
import { relative, resolve, sep, extname } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const MEDIA_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a':'audio/mp4', '.aac':'audio/aac', '.ogg':'audio/ogg', '.aiff':'audio/aiff' }

export function containedPath(root: string, path: string): string {
  const target = realpathSync(path)
  if (!target.startsWith(realpathSync(root) + sep)) throw new Error('Media is outside the runs folder.')
  return target
}

export class Assets {
  constructor(private root: string, private secret: string) {}
  token(path: string) {
    let target: string
    try { target = realpathSync(path) } catch { target = resolve(path) }
    const rel = relative(realpathSync(this.root), target)
    if (rel.startsWith('..') || !rel || rel.includes('\0')) return ''
    const data = Buffer.from(rel).toString('base64url')
    const sig = createHmac('sha256', this.secret).update(data).digest('base64url')
    return `/api/assets/${data}.${sig}${extname(path)}`
  }
  path(token: string) {
    const match = /^\/api\/assets\/([\w-]+)\.([\w-]+)(?:\.[a-z0-9]+)?$/i.exec(token)
    if (!match) throw new Error('Invalid media reference.')
    const expected = createHmac('sha256', this.secret).update(match[1]).digest()
    const actual = Buffer.from(match[2], 'base64url')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Invalid media reference.')
    return containedPath(this.root, resolve(this.root, Buffer.from(match[1], 'base64url').toString()))
  }
  /** Translate only known path fields; never alter prompts or other user text. */
  wire<T>(value: T): T {
    const visit = (v: unknown, key = ''): unknown => {
      if (typeof v === 'string' && ['outputPath', 'sourceImage', 'runDir', 'dir', 'images', 'thumbnail', 'favorites'].includes(key)) return this.token(v)
      if (Array.isArray(v)) return v.map((item) => visit(item, key))
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, visit(item, k)]))
      return v
    }
    return visit(value) as T
  }
}

export function serveFile(req: IncomingMessage, res: ServerResponse, path: string, type: string, download = false) {
  const size = statSync(path).size
  const range = req.headers.range
  const bounds = mediaRange(size, range)
  if (!bounds) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end() }
  const { start, end } = bounds
  if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
  res.setHeader('Content-Type', type)
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Length', Math.max(0, end - start + 1))
  if (download) res.setHeader('Content-Disposition', `attachment; filename="local-lab${extname(path)}"`)
  res.statusCode = range ? 206 : 200
  if (req.method === 'HEAD' || size === 0) return res.end()
  const stream = createReadStream(path, { start, end })
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}

export function mediaRange(size: number, range?: string | null) {
  if (!range) return { start: 0, end: size - 1 }
  const m = /^bytes=(\d*)-(\d*)$/.exec(range)
  if (!m || !(m[1] || m[2])) return null
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end && start < size ? { start, end } : null
}
