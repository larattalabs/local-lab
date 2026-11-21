/** Apply the Mac's reset generation before loading any client-side drafts. */
export function syncHistoryDrafts(storage: Pick<Storage, 'getItem'|'setItem'|'removeItem'>, resetId: string, force = false): boolean {
  const previous = storage.getItem('lab-history-reset')
  const changed = force || (previous !== resetId && (previous !== null || resetId !== 'initial'))
  if (changed) {
    let preferences: Record<string, unknown> = {}
    try { preferences = JSON.parse(storage.getItem('lab-preferences') ?? '{}') ?? {} } catch { /* discard invalid drafts */ }
    storage.setItem('lab-preferences', JSON.stringify({ selected: preferences.selected, params: preferences.params }))
    storage.removeItem('lab-basic-drafts')
    storage.removeItem('director-pending')
  }
  storage.setItem('lab-history-reset', resetId)
  return changed
}
