/**
 * Repair a half-extracted Electron install.
 *
 * Electron's postinstall downloads a ~100MB zip and unpacks it with a JS unzip
 * that does not reliably reproduce a macOS app bundle — on this machine it
 * produced a 312KB `Electron.app` with `MacOS/` and `Resources/` but no
 * `Frameworks/`, and no `path.txt`. That yields two unhelpful errors in
 * sequence: electron-vite reports "Electron uninstall" (path.txt missing), and
 * if you write that file by hand the app then dies in dyld with
 * "Library not loaded: @rpath/Electron Framework.framework".
 *
 * The cached zip is intact; only the extraction is bad. `ditto -xk` unpacks app
 * bundles correctly (symlinks, frameworks, extended attributes), so re-extract
 * with that and then write the pointer file.
 *
 * Every step is conditional, so this is a no-op on a healthy install.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

let root
try {
  root = dirname(require.resolve('electron/package.json'))
} catch {
  process.exit(0) // electron not installed — nothing to do
}

const RELATIVE = {
  darwin: 'Electron.app/Contents/MacOS/Electron',
  linux: 'electron',
  win32: 'electron.exe',
}[process.platform]
if (!RELATIVE) process.exit(0)

const dist = join(root, 'dist')
const binary = join(dist, RELATIVE)
const frameworks = join(dist, 'Electron.app', 'Contents', 'Frameworks')

/** A bundle without Frameworks launches and then immediately dies in dyld. */
function bundleLooksComplete() {
  if (!existsSync(binary)) return false
  if (process.platform !== 'darwin') return true
  return existsSync(frameworks) && readdirSync(frameworks).length > 0
}

function cachedZip() {
  const cache = join(homedir(), 'Library', 'Caches', 'electron')
  if (!existsSync(cache)) return null
  for (const d of readdirSync(cache)) {
    const dir = join(cache, d)
    if (!statSync(dir).isDirectory()) continue
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.zip') && f.includes(process.arch)) return join(dir, f)
    }
  }
  return null
}

if (process.platform === 'darwin' && !bundleLooksComplete()) {
  const zip = cachedZip()
  if (zip) {
    console.log('[fix-electron] incomplete Electron.app — re-extracting with ditto')
    rmSync(dist, { recursive: true, force: true })
    mkdirSync(dist, { recursive: true })
    execFileSync('/usr/bin/ditto', ['-xk', zip, dist], { stdio: 'inherit' })
  } else {
    console.warn('[fix-electron] Electron.app looks incomplete and no cached zip was found.')
    console.warn('               Try: rm -rf node_modules && pnpm install')
  }
}

if (bundleLooksComplete() && !existsSync(join(root, 'path.txt'))) {
  writeFileSync(join(root, 'path.txt'), RELATIVE)
  console.log('[fix-electron] wrote missing electron/path.txt')
}
