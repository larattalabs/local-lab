import { app, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { CodeApprovalMode, CodeBackend, CodeCatalogEntry, CodeDelivery, CodeNewSession, CodeSettings, CodeThinking } from '@shared/code'
import { CodeService } from './service'

/**
 * Code tab IPC. The Code tab is effectively a remote shell — an agent that
 * edits files and runs commands — so it is registered here, directly on
 * ipcMain, and NOT through the `commands` table that the phone server proxies.
 * Every handler also checks that the caller is the desktop window itself.
 */
export function registerCodeIpc(getWin: () => BrowserWindow | null, jobsBusy: () => boolean): CodeService {
  const code = new CodeService(app.getPath('userData'), jobsBusy)

  const handle = (channel: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(channel, (e: IpcMainInvokeEvent, ...args: unknown[]) => {
      const win = getWin()
      if (!win || win.isDestroyed() || e.sender !== win.webContents) throw new Error('Code is only available in the Local Lab window on this Mac.')
      return fn(...args)
    })

  handle('code:catalog', () => code.catalog())
  handle('code:refreshCatalog', () => code.refreshCatalog())
  handle('code:backends', () => code.backendState())
  handle('code:list', () => code.list())
  handle('code:open', (id: string) => code.open(String(id)))
  handle('code:create', (input: CodeNewSession) => code.create(input))
  handle('code:send', (id: string, text: string, images?: string[], delivery?: CodeDelivery) => code.send(String(id), String(text), images ?? [], delivery))
  handle('code:saveImage', (base64: string, mime: string) => code.saveImage(String(base64), String(mime)))
  handle('code:compact', (id: string) => code.compact(String(id)))
  handle('code:commands', (id: string) => code.commands(String(id)))
  handle('code:agents', () => code.agents())
  handle('code:changes', (id: string) => code.changes(String(id)))
  handle('code:settings', () => code.settings())
  handle('code:saveSettings', (input: Partial<CodeSettings>) => code.saveSettings(input ?? {}))
  handle('code:discover', () => code.discover())
  handle('code:checkModel', (backend: CodeBackend, model: string) =>
    code.checkModel(backend, String(model), (line) => { const w = getWin(); if (w && !w.isDestroyed()) w.webContents.send('code:checkStatus', line) }))
  handle('code:saveModel', (entry: CodeCatalogEntry) => code.saveModel(entry))
  handle('code:removeModel', (id: string) => code.removeModel(String(id)))
  handle('code:serverSettings', () => code.serverSettings())
  handle('code:setOmlxContext', (model: string, ctx: number | null) => code.setOmlxContext(String(model), ctx === null ? null : Number(ctx)))
  handle('code:stop', (id: string) => code.stop(String(id)))
  handle('code:stopBackend', (b: string) => code.stopBackend(String(b) as CodeBackend))
  handle('code:answer', (id: string, approvalId: string, approve: boolean) => code.answer(String(id), String(approvalId), !!approve))
  handle('code:configure', (id: string, patch: { modelId?: string; mode?: CodeApprovalMode; leanTools?: boolean; title?: string; thinking?: CodeThinking; agent?: string }) => code.configure(String(id), patch ?? {}))
  handle('code:remove', (id: string) => code.remove(String(id)))
  handle('code:pickFolder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], message: 'Choose the folder the agent works in' })
    return r.canceled ? undefined : r.filePaths[0]
  })
  handle('code:reveal', (path: string) => shell.openPath(String(path)))

  code.onPush((p) => {
    const win = getWin()
    if (!win || win.isDestroyed()) return
    if (p) win.webContents.send('code:event', p)
    else win.webContents.send('code:sessions')
  })
  app.on('before-quit', () => code.shutdown())
  return code
}
