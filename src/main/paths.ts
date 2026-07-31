import { app } from 'electron'
import { join } from 'node:path'

/**
 * Worker scripts ship as unpacked resources so they can be spawned by an
 * external Python interpreter — they must exist as real files on disk, which
 * means they cannot live inside the asar bundle.
 */
export function workerPath(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'workers', name)
    : join(app.getAppPath(), 'resources', 'workers', name)
}
