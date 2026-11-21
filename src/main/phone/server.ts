import { createServer as httpsServer, type Server } from 'node:https'
import { createServer as httpServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from 'node:http'
import { randomBytes, randomInt, randomUUID, createHash } from 'node:crypto'
import { networkInterfaces, hostname } from 'node:os'
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, statSync } from 'node:fs'
import { join, resolve, extname, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import QRCode from 'qrcode'
import type { AdapterInfo, PhoneStatus, SubmitTurn } from '@shared/types'
import { Assets, MEDIA_TYPES, serveFile } from './assets'
import { certificates } from './tls'
import { validateTurn } from './validation'

interface Device { id: string; name: string; hash: string; pairedAt: number; lastSeen: number }
interface Pending { id: string; name: string; address: string; expires: number; proof: string; token?: string; rejected?: boolean }
export interface PhoneBackend {
  thumbnail?(path:string): Promise<Buffer | undefined>
  access?<T>(operation:()=>T|Promise<T>): Promise<T>
  adapters(): AdapterInfo[]
  call(method: string, arg?: unknown): unknown | Promise<unknown>
  submit(turn: SubmitTurn): unknown
  subscribe(fn: (kind: string, value: unknown) => void): () => void
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const cookie = (req: IncomingMessage, key: string) => req.headers.cookie?.split(';').map((v) => v.trim()).find((v) => v.startsWith(key + '='))?.slice(key.length + 1)
const sessionCookie = (value: string, age: number) => `__Host-lab=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${age}`
const json = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
async function body(req: IncomingMessage, limit: number) {
  const parts: Buffer[] = []; let size = 0
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('Upload is too large.'); parts.push(chunk) }
  return Buffer.concat(parts)
}
function lan() {
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (!/^(en|eth|wlan)/.test(name)) continue
    const address = addresses?.find((a) => a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address))
    if (address) return address.address
  }
  throw new Error('Connect the Mac to your private Wi-Fi or Ethernet network, then enable Phone access.')
}
function localName() {
  try { return execFileSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim() + '.local' }
  catch { return hostname().replace(/[^a-z0-9.-]/gi, '') }
}

export class PhoneServer {
  private server?: Server
  private bootstrap?: HttpServer
  private state: { enabled: boolean; secret: string; devices: Device[] }
  private pending = new Map<string, Pending>()
  private streams = new Map<ServerResponse, string>()
  private rate = new Map<string, { at: number; count: number }>()
  private unsubscribe?: () => void
  private timer?: ReturnType<typeof setInterval>
  private address = ''
  private hosts: string[] = []
  private code = ''
  private expires = 0
  private error?: string
  private tls?: ReturnType<typeof certificates>
  private qr = ''
  private setupQr = ''
  readonly assets: Assets
  constructor(private dir: string, private webRoot: string, private runs: string, private backend: PhoneBackend,
    private options: { address?: string; hostname?: string; port?: number; setupPort?: number } = {}) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, 'devices.json')
    this.state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { enabled: false, secret: randomBytes(32).toString('hex'), devices: [] }
    this.assets = new Assets(runs, this.state.secret)
  }
  private persist() {
    const file = join(this.dir, 'devices.json')
    writeFileSync(file + '.tmp', JSON.stringify(this.state), { mode: 0o600 }); renameSync(file + '.tmp', file)
  }
  get port() { return this.options.port ?? 8443 }
  get setupPort() { return this.options.setupPort ?? 8444 }
  private get url() { return `https://${this.hosts[0]}:${this.port}` }
  private get setupUrl() { return `http://${this.address}:${this.setupPort}` }
  status(): PhoneStatus {
    return { enabled: !!this.server, url: this.server ? this.url : undefined,
      ipUrl: this.server ? `https://${this.address}:${this.port}` : undefined,
      setupUrl: this.bootstrap ? this.setupUrl : undefined, qr: this.qr, setupQr: this.setupQr,
      fingerprint: this.tls?.fingerprint, code: this.expires > Date.now() ? this.code : undefined,
      pairingExpires: this.expires, error: this.error,
      pending: [...this.pending.values()].filter((p) => !p.token && !p.rejected && p.expires > Date.now()).map(({ id, name, address, expires }) => ({ id, name, address, expires })),
      devices: this.state.devices.map(({ id, name, pairedAt, lastSeen }) => ({ id, name, pairedAt, lastSeen })) }
  }
  async restore() { if (this.state.enabled) { try { await this.start() } catch { /* status displays actionable error */ } } }
  async start() {
    if (this.server) return this.status()
    try {
      this.address = this.options.address ?? lan()
      this.hosts = [this.options.hostname ?? localName(), this.address].filter((v, i, a) => !!v && a.indexOf(v) === i)
      this.tls = certificates(this.dir, this.hosts)
      this.server = httpsServer({ key: this.tls.key, cert: this.tls.cert, minVersion: 'TLSv1.2', maxHeaderSize: 8192 }, (req, res) => { void this.handle(req, res) })
      this.server.requestTimeout = 60000; this.server.headersTimeout = 15000; this.server.maxConnections = 64
      await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(this.port, this.address, resolve) })
      this.server.on('error', (e) => { this.error = e.message })
      this.qr = await QRCode.toDataURL(this.url, { margin: 2, width: 240 })
      this.state.enabled = true; this.error = undefined; this.persist()
      this.unsubscribe = this.backend.subscribe((kind, value) => {
        const payload = JSON.stringify(this.assets.wire(value))
        for (const res of this.streams.keys()) {
          if (res.writableLength > 1024 * 1024) { res.destroy(); continue }
          res.write(`event: ${kind}\ndata: ${payload}\n\n`)
        }
      })
      this.timer = setInterval(() => {
        const now = Date.now()
        for (const [id, p] of this.pending) if (p.expires < now) this.pending.delete(id)
        for (const [key, v] of this.rate) if (v.at < now - 60000) this.rate.delete(key)
        if (this.expires < now && this.bootstrap) { this.bootstrap.close(); this.bootstrap.closeAllConnections(); this.bootstrap = undefined }
        for (const [res, device] of this.streams) {
          if (!this.state.devices.some((d) => d.id === device)) res.end()
          else res.write(': heartbeat\n\n')
        }
        if (!this.options.address) {
          try { if (lan() !== this.address) { this.error = 'Network changed. Disable and enable Phone access to reconnect.'; void this.stop(false) } }
          catch { this.error = 'Wi-Fi disconnected. Reconnect and enable Phone access.'; void this.stop(false) }
        }
      }, 15000)
      this.timer.unref()
      return this.status()
    } catch (e) {
      this.error = `Phone access could not start: ${e instanceof Error ? e.message : e}`
      await this.stop(false); throw new Error(this.error)
    }
  }
  async stop(disable = true) {
    if (disable) { this.state.enabled = false; this.persist() }
    clearInterval(this.timer); this.unsubscribe?.(); this.unsubscribe = undefined
    for (const res of this.streams.keys()) res.end()
    this.streams.clear(); this.pending.clear(); this.expires = 0; this.code = ''
    const servers = [this.server, this.bootstrap]; this.server = undefined; this.bootstrap = undefined
    for (const server of servers) if (server) { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())) }
    return this.status()
  }
  async pairing() {
    if (!this.server) await this.start()
    this.code = String(randomInt(100000, 1000000)); this.expires = Date.now() + 5 * 60000
    if (!this.bootstrap) {
      this.bootstrap = httpServer((req, res) => {
        res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff')
        if (!this.allowedHost(req, this.setupPort) || Date.now() > this.expires || req.method !== 'GET') { res.writeHead(404); return res.end() }
        if (req.url === '/local-lab.cer') {
          res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="Local Lab Wi-Fi.cer"' }); return res.end(this.tls!.der)
        }
        if (req.url !== '/') { res.writeHead(404); return res.end() }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" })
        res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local Lab setup</title><style>body{font:17px system-ui;max-width:520px;margin:40px auto;padding:20px;background:#101317;color:#dfe5ec;line-height:1.6}a{color:#e2b34d}code{overflow-wrap:anywhere}</style><h1>Connect Local Lab</h1><p>This page only provides the public certificate. Your chats and images use encrypted HTTPS.</p><ol><li><a href="/local-lab.cer">Download this Mac’s certificate</a>.</li><li>In Settings, open <b>Profile Downloaded</b> (or General → VPN &amp; Device Management) and install Local Lab.</li><li>Open General → About → Certificate Trust Settings. Enable full trust for <b>Local Lab private Wi-Fi CA</b>.</li><li><a href="${this.url}">Open Local Lab securely</a>, enter the code shown on your Mac, then approve on the Mac.</li><li>In Safari’s Share menu choose Add to Home Screen. Open the Home Screen app and pair there if it asks again.</li></ol><p>Before trusting, verify this SHA-256 fingerprint against Phone access on the Mac:</p><code>${this.tls!.fingerprint}</code>`)
      })
      this.bootstrap.maxConnections = 16; this.bootstrap.requestTimeout = 10000
      try { await new Promise<void>((resolve, reject) => { this.bootstrap!.once('error', reject); this.bootstrap!.listen(this.setupPort, this.address, resolve) }) }
      catch (e) { this.bootstrap.close(); this.bootstrap = undefined; throw e }
    }
    this.setupQr = await QRCode.toDataURL(this.setupUrl, { margin: 2, width: 240 })
    return this.status()
  }
  approve(id: string, allow: boolean) {
    const p = this.pending.get(id)
    if (!p || p.expires < Date.now() || p.token || p.rejected) throw new Error('Pairing request expired.')
    if (!allow) p.rejected = true
    else {
      if (this.state.devices.length >= 20) throw new Error('Remove an old device before pairing another.')
      p.token = randomBytes(32).toString('base64url')
      this.state.devices.push({ id: p.id, name: p.name, hash: hash(p.token), pairedAt: Date.now(), lastSeen: Date.now() }); this.persist()
    }
    return this.status()
  }
  revoke(id: string) {
    this.state.devices = this.state.devices.filter((d) => d.id !== id); this.persist()
    for (const [key, p] of this.pending) if (p.id === id) this.pending.delete(key)
    for (const [res, device] of this.streams) if (device === id) res.end()
    return this.status()
  }
  private allowedHost(req: IncomingMessage, port = this.port) { return this.hosts.some((h) => req.headers.host?.toLowerCase() === `${h}:${port}`.toLowerCase()) }
  private limit(key: string, max: number) {
    const v = this.rate.get(key)
    if (!v || v.at < Date.now() - 60000) { this.rate.set(key, { at: Date.now(), count: 1 }); return }
    if (++v.count > max) throw new Error('Too many requests. Wait a minute and try again.')
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'")
    try {
      if (!this.allowedHost(req)) return json(res, 403, { error: 'Invalid host.' })
      const origin = `https://${req.headers.host}`
      if ((req.headers.origin && req.headers.origin !== origin) || (req.method !== 'GET' && req.method !== 'HEAD' && (req.headers.origin !== origin || req.headers['x-lab-request'] !== '1'))) return json(res, 403, { error: 'Use Local Lab on this device.' })
      const url = new URL(req.url ?? '/', origin)
      const address = req.socket.remoteAddress ?? ''
      if (url.pathname === '/api/pair' && req.method === 'POST') {
        this.limit('pair:' + address, 8); this.limit('pair-global', 30)
        const v = JSON.parse((await body(req, 4096)).toString())
        if (!this.code || Date.now() > this.expires || v.code !== this.code) return json(res, 403, { error: 'Code expired or incorrect. Start pairing on the Mac.' })
        if (this.pending.size >= 10) return json(res, 429, { error: 'Too many pairing requests.' })
        this.code = ''
        const proof = randomBytes(32).toString('base64url')
        const id = randomUUID()
        this.pending.set(id, { id, name: String(v.name ?? 'iPhone').slice(0, 60), address, expires: Date.now() + 5 * 60000, proof: hash(proof) })
        res.setHeader('Set-Cookie', `__Host-lab-pair=${id}.${proof}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=300`)
        return json(res, 200, { pending: true, id })
      }
      if (url.pathname === '/api/pair' && req.method === 'GET') {
        const [id, proof] = (cookie(req, '__Host-lab-pair') ?? '').split('.')
        const p = this.pending.get(id)
        if (!p || p.expires < Date.now() || !proof || p.proof !== hash(proof)) return json(res, 404, { error: 'Pairing expired. Start again on the Mac.' })
        if (p.rejected) return json(res, 403, { error: 'The Mac declined this device.' })
        if (p.token) {
          res.setHeader('Set-Cookie', [sessionCookie(p.token, 90 * 86400), '__Host-lab-pair=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0'])
          this.pending.delete(id); return json(res, 200, { paired: true })
        }
        return json(res, 200, { pending: true })
      }
      if (url.pathname.startsWith('/api/')) {
        const token = cookie(req, '__Host-lab')
        const device = token && this.state.devices.find((d) => d.hash === hash(token) && d.pairedAt > Date.now() - 90 * 86400000)
        if (!device) return json(res, 401, { error: 'Pair this device with Local Lab on your Mac.' })
        if (Date.now() - device.lastSeen > 60000) { device.lastSeen = Date.now(); this.persist() }
        if (url.pathname === '/api/version' && req.method === 'GET') {
          const html = readFileSync(join(this.webRoot, 'index.html'), 'utf8')
          return json(res, 200, { version: hash(html), bundle: html.match(/src="([^"]+\.js)"/)?.[1] })
        }
        if (url.pathname === '/api/session' && req.method === 'GET') return json(res, 200, { name: device.name })
        if (url.pathname === '/api/logout' && req.method === 'POST') { this.revoke(device.id); res.setHeader('Set-Cookie', sessionCookie('', 0)); return json(res, 200, {}) }
        if (url.pathname === '/api/events' && req.method === 'GET') {
          if ([...this.streams.values()].filter((d) => d === device.id).length >= 6) return json(res, 429, { error: 'Too many open tabs.' })
          res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' }); res.write('event: sync\ndata: {}\n\n')
          this.streams.set(res, device.id); res.on('close', () => this.streams.delete(res)); return
        }
        if (url.pathname.startsWith('/api/assets/') && ['GET', 'HEAD'].includes(req.method ?? '')) {
          const path = this.assets.path(url.pathname), type = MEDIA_TYPES[extname(path).toLowerCase()]
          if (!type || !statSync(path).isFile()) return json(res, 404, { error: 'Media not found.' })
          if (type.startsWith('image/') && url.searchParams.has('thumbnail')) {
            const jpeg = await this.backend.thumbnail?.(path)
            if (jpeg) { res.writeHead(200, {'Content-Type':'image/jpeg','Content-Length':jpeg.length}); return res.end(req.method==='HEAD'?undefined:jpeg) }
          }
          return serveFile(req, res, path, type, url.searchParams.has('download'))
        }
        if (url.pathname === '/api/upload' && req.method === 'POST') {
          this.limit('upload:' + device.id, 30)
          const upload = async () => {
          const data = await body(req, 25 * 1024 * 1024)
          const ext = data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? '.png'
            : data[0] === 255 && data[1] === 216 && data[2] === 255 ? '.jpg'
            : data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP' ? '.webp' : ''
          if (!ext) throw new Error('Choose a PNG, JPEG or WebP image. Export HEIC photos as JPEG first.')
          const dir = join(this.runs, 'uploads'); mkdirSync(dir, { recursive: true })
          const path = join(dir, randomUUID() + ext); writeFileSync(path, data, { mode: 0o600 })
          return json(res, 200, { path: this.assets.token(path) })
          }
          return this.backend.access ? await this.backend.access(upload) : await upload()
        }
        if (url.pathname === '/api/rpc' && req.method === 'POST') {
          this.limit('rpc:' + device.id, 240)
          const { method, arg } = JSON.parse((await body(req, 256 * 1024)).toString())
          let result: unknown
          if (method === 'studioUpdate') {
            if (!arg || typeof arg !== 'object') throw new Error('Invalid library change.')
            const decoded = { ...arg }
            if (decoded.path) decoded.path = this.assets.path(decoded.path)
            if (decoded.thumbnail) decoded.thumbnail = this.assets.path(decoded.thumbnail)
            result = await this.backend.call(method, decoded)
          } else if (method === 'basicPlan' || method === 'basicSave') {
            this.limit('basic:' + device.id, 30)
            if (!arg || typeof arg !== 'object') throw new Error('Invalid preset request.')
            const decoded = { ...arg }
            for (const key of ['sourceImage', 'thumbnail']) if (decoded[key]) decoded[key] = this.assets.path(decoded[key])
            if (decoded.chat?.sourceImage) decoded.chat = { ...decoded.chat, sourceImage: this.assets.path(decoded.chat.sourceImage) }
            result = await this.backend.call(method, decoded)
          } else if (method === 'directorStart') {
            this.limit('generate:' + device.id, 20)
            if (!arg || typeof arg !== 'object') throw new Error('Invalid director request.')
            result = await this.backend.call(method, { id: arg.id, choice: arg.choice, turn: validateTurn(arg.turn, this.backend.adapters(), this.assets) })
          } else if (method === 'submitTurn') {
            this.limit('generate:' + device.id, 20)
            result = await this.backend.submit(validateTurn(arg, this.backend.adapters(), this.assets))
          } else if (['listAdapters', 'availability', 'listJobs', 'listChats', 'listHistory', 'cancel', 'clearFinished', 'deleteChat', 'directorInfo', 'directorConfigure', 'directorStatus', 'basicCatalog', 'basicDelete', 'basicModifiers', 'studioInfo', 'historyState', 'historyPreview', 'historyClear'].includes(method)) {
            if (['cancel', 'deleteChat', 'directorStatus'].includes(method) && (typeof arg !== 'string' || !/^[a-z0-9-]{1,100}$/i.test(arg))) throw new Error('Invalid identifier.')
            result = await this.backend.call(method, arg)
          } else return json(res, 404, { error: 'Unknown operation.' })
          return json(res, 200, this.assets.wire(result ?? null))
        }
        return json(res, 404, { error: 'Not found.' })
      }
      if (!['GET', 'HEAD'].includes(req.method ?? '')) return json(res, 405, { error: 'Method not allowed.' })
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1)
      const file = resolve(this.webRoot, rel)
      if (!file.startsWith(resolve(this.webRoot) + sep) || !existsSync(file) || !statSync(file).isFile()) return json(res, 404, { error: 'Not found.' })
      const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }
      if (!types[extname(file)]) return json(res, 404, { error: 'Not found.' })
      return serveFile(req, res, file, types[extname(file)])
    } catch (e) {
      if (!res.headersSent) json(res, 400, { error: e instanceof Error ? e.message : 'Request failed.' })
      else res.destroy()
    }
  }
}
