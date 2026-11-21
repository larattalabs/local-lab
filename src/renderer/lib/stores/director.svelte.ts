import { lab } from '../api'
import { defaultDirectorConfig, directorProfiles, type DirectorChoice, type DirectorInfo, type DirectorStatus, type DirectorStart, type DirectorConfig } from '@shared/director'
import type { SubmitTurn, TurnResult } from '@shared/types'
type Resolution = { turn: SubmitTurn } | { result: TurnResult; turn: SubmitTurn } | null
export class DirectorFlow {
  info = $state<DirectorInfo>({ config: defaultDirectorConfig(), models: [] })
  choices = $state({ image: { ...defaultDirectorConfig().defaults.image, mode: 'off' as DirectorChoice['mode'] }, video: { ...defaultDirectorConfig().defaults.video, mode: 'off' as DirectorChoice['mode'] } })
  session = $state<{ input?: DirectorStart; status: DirectorStatus; recovered: boolean } | null>(null)
  connectionError = $state('')
  private waiter?: (value: Resolution) => void
  private timer?: ReturnType<typeof setTimeout>
  private epoch = 0
  private loading?: Promise<void>
  init() { return this.loading ??= this.load().catch(error => { this.loading = undefined; throw error }) }
  private async load() {
    this.info = await lab.directorInfo()
    this.choices = $state.snapshot(this.info.config.defaults)
    try { this.choices = { ...this.choices, ...JSON.parse(localStorage.getItem('director-choices') ?? '{}') } } catch { /* defaults */ }
    this.reconcileProfiles()
    const id = localStorage.getItem('director-pending')
    if (id && !this.session) {
      this.session = { status: { id, state: 'queued', automatic: false }, recovered: true }
      this.poll(++this.epoch)
    }
  }
  choose(m: 'image' | 'video', key: keyof DirectorChoice, value: string) {
    this.choices[m] = { ...this.choices[m], [key]: value }
    localStorage.setItem('director-choices', JSON.stringify(this.choices))
  }
  private reconcileProfiles() {
    const ids = new Set(directorProfiles(this.info.config).map((p) => p.id))
    for (const m of ['image', 'video'] as const) if (!ids.has(this.choices[m].preset)) this.choose(m, 'preset', this.info.config.defaults[m].preset)
  }
  async configure(config: DirectorConfig) { this.info = await lab.directorConfigure($state.snapshot(config)); this.reconcileProfiles() }
  async reload() { this.info = await lab.directorInfo(); this.reconcileProfiles() }
  async prepare(turn: SubmitTurn, override?: import('@shared/director').DirectorChoice): Promise<Resolution> {
    const modality = turn.request.modality
    if (modality !== 'image' && modality !== 'video') return { turn }
    if (!override && this.loading) await this.loading
    const choice = { ...(override ?? this.choices[modality]) }
    if (choice.mode === 'off' || turn.request.director) return { turn }
    if (this.session) throw new Error('Finish or dismiss the current director preview first.')
    // Faithful follow-ups get an edit-specific recipe; custom presets remain explicit.
    if (modality === 'image' && turn.request.images?.length && choice.preset === 'faithful') choice.preset = 'edit'
    const input = $state.snapshot({ id: turn.turnId, turn, choice })
    this.session = { input, status: { id: input.id, state: 'queued', automatic: choice.mode === 'auto' }, recovered: false }
    this.connectionError = ''
    localStorage.setItem('director-pending', input.id)
    const waiting = new Promise<Resolution>((resolve) => { this.waiter = resolve })
    await this.start(input)
    return waiting
  }
  private async start(input: DirectorStart) {
    const epoch = ++this.epoch
    try {
      const status = await lab.directorStart(input)
      if (this.session?.status.id !== input.id || epoch !== this.epoch) return
      this.session.status = status
      this.poll(epoch)
    } catch (error) {
      // A lost response may follow a successful server-side automatic submission.
      // Recover that same identifier before offering a retry with a new one.
      if (this.session?.status.id !== input.id || epoch !== this.epoch) return
      this.connectionError = error instanceof Error ? error.message : String(error)
      this.poll(epoch, this.connectionError)
    }
  }
  private poll(epoch: number, startError?: string) {
    const id = this.session?.status.id
    if (!id || epoch !== this.epoch) return
    void lab.directorStatus(id).then((status) => {
      if (!this.session || epoch !== this.epoch) return
      this.session.status = status; this.connectionError = ''
      if (status.automatic && status.result && this.waiter) {
        this.finish({ result: status.result, turn: status.preview!.turn }); return
      }
      if (['queued', 'running'].includes(status.state)) this.timer = setTimeout(() => this.poll(epoch), 1000)
    }).catch((e) => {
      if (!this.session || epoch !== this.epoch) return
      this.connectionError = e instanceof Error ? e.message : String(e)
      if (/no longer available/.test(this.connectionError)) {
        this.session.status = { ...this.session.status, state: 'error', error: startError ?? this.connectionError }
        this.connectionError = ''; return
      }
      this.timer = setTimeout(() => this.poll(epoch, startError), 2500)
    })
  }
  private finish(result: Resolution) {
    ++this.epoch; clearTimeout(this.timer)
    this.session = null; localStorage.removeItem('director-pending')
    const resolve = this.waiter; this.waiter = undefined; resolve?.(result)
  }
  approved(prompts: Record<string, string>): SubmitTurn | undefined {
    const preview = this.session?.status.preview
    if (!preview) return
    for (const value of Object.values(prompts)) {
      if (!value.trim() || value.length > 16000) throw new Error('Enter a prompt of 1–16,000 characters.')
      for (const term of preview.provenance.protectedTerms) if (!value.includes(term)) throw new Error(`Keep protected text “${term}” in the prompt.`)
    }
    const turn = { ...preview.turn, request: { ...preview.turn.request, director: { previewId: preview.id, prompts } } }
    if (this.waiter) { this.finish({ turn }); return }
    return turn
  }
  completeRecovered() { this.finish(null) }
  async original(): Promise<SubmitTurn | undefined> {
    const turn = this.session?.input?.turn ?? this.session?.status.preview?.turn
    if (!turn) return
    if (['queued', 'running'].includes(this.session!.status.state)) await lab.cancel(this.session!.status.id)
    if (this.waiter) { this.finish({ turn }); return }
    return turn
  }
  async cancel() {
    if (this.session && ['queued', 'running'].includes(this.session.status.state)) await lab.cancel(this.session.status.id)
    this.finish(null)
  }
  async retry() {
    const session = this.session
    const previous = session?.input
    const preview = session?.status.preview
    if (!session || (!previous && !preview)) return
    const turn = $state.snapshot(previous?.turn ?? preview!.turn)
    turn.turnId = crypto.randomUUID()
    const m = turn.request.modality as 'image' | 'video'
    const input = { id: turn.turnId, turn, choice: previous?.choice ?? { ...this.choices[m], mode: session.status.automatic ? 'auto' as const : 'preview' as const } }
    session.input = input; session.status = { id: input.id, state: 'queued', automatic: input.choice.mode === 'auto' }
    this.connectionError = ''; localStorage.setItem('director-pending', input.id)
    await this.start($state.snapshot(input))
  }
}
export const directorFlow = new DirectorFlow()
