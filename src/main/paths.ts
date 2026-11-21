import { join } from 'node:path'

/**
 * Worker scripts ship as unpacked resources so they can be spawned by an
 * external Python interpreter — they must exist as real files on disk, which
 * means they cannot live inside the asar bundle.
 */
export function workerPath(name: string): string {
  if (!process.versions.electron) return join(process.cwd(), 'resources', 'workers', name)
  if (process.defaultApp) return join(__dirname, '..', '..', 'resources', 'workers', name)
  return join(process.resourcesPath, 'workers', name)
}
