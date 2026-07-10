import { spawn } from 'child_process'
import { app } from 'electron'

interface ChildLike {
  stdout: { on(ev: 'data', cb: (c: Buffer) => void): void } | null
  on(ev: 'error', cb: (e: Error) => void): void
  on(ev: 'close', cb: (code: number | null) => void): void
  kill(): void
}
interface SpawnOpts { stdio: ['ignore', 'pipe', 'ignore'] }
type SpawnLike = (cmd: string, args: string[], opts: SpawnOpts) => ChildLike

const SHELL_TIMEOUT_MS = 3000

/** Unique delimiters bracketing the PATH in the probe's stdout. An interactive+login shell sources
 *  rc files BEFORE our `-c` command, and anything they echo (nvm/rbenv init, `brew shellenv`) lands
 *  on stdout ahead of the printf — so we cannot trust "the whole output" or even "the last line".
 *  Bracketing the value lets us extract it no matter what noise surrounds it. */
const PATH_MARKER = '__NAC_PATH__'

/** Interactive+login shell so rc files that set PATH are sourced; the value is emitted between two
 *  PATH_MARKERs so we can recover it from surrounding rc-file stdout noise (see PATH_MARKER).
 *  Uses `printenv PATH` rather than shell-native `"$PATH"` expansion: in fish, a double-quoted
 *  `"$PATH"` expands the list joined by spaces (not colons), producing one invalid entry. `printenv`
 *  reads the exported colon-separated value the same way regardless of shell, and is present at
 *  /usr/bin/printenv on macOS and via coreutils on Linux. All three commands here are `;`-separated
 *  with no command substitution, so the line is valid POSIX sh/bash/zsh AND fish. */
export function shellPathArgs(): string[] {
  return ['-ilc', `command -v true >/dev/null 2>&1; printf '${PATH_MARKER}'; printenv PATH; printf '${PATH_MARKER}'`]
}

/** Pull the PATH out of the probe's raw stdout: the substring between the two markers. Returns null
 *  if the markers are absent (probe failed / never reached the printf) or the bracketed value is empty. */
export function extractShellPath(raw: string): string | null {
  const first = raw.indexOf(PATH_MARKER)
  if (first < 0) return null
  const start = first + PATH_MARKER.length
  const second = raw.indexOf(PATH_MARKER, start)
  if (second < 0) return null
  return raw.slice(start, second).trim() || null
}

/** Union of the current PATH (kept first — nothing already resolvable breaks) with newly discovered
 *  entries, deduped, colon-joined. Empty/whitespace discovered → current unchanged. */
export function mergePath(current: string | undefined, discovered: string): string {
  const base = (current ?? '').split(':').filter(Boolean)
  const found = discovered.trim() ? discovered.split(':').filter(Boolean) : []
  const seen = new Set(base)
  for (const p of found) if (!seen.has(p)) { base.push(p); seen.add(p) }
  return base.join(':')
}

/** Only a packaged, non-Windows app needs the merge: dev already inherited the terminal's PATH, and
 *  Windows PATH/shell semantics differ (deferred with the PlatformServices note). */
export function shouldResolveShellPath(isPackaged: boolean, platform: NodeJS.Platform): boolean {
  return isPackaged && platform !== 'win32'
}

/** Never throws: timeout / nonzero exit / empty output / spawn error all resolve to null. */
export function resolveShellPath(spawnImpl: SpawnLike = spawn as unknown as SpawnLike, timeoutMs = SHELL_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (v: string | null): void => { if (!done) { done = true; resolve(v) } }
    let child: ChildLike
    try {
      // stderr ignored, not piped: an rc setup that floods stderr must not fill an unread pipe and hang the shell.
      child = spawnImpl(process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'), shellPathArgs(), { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      finish(null); return
    }
    const timer = setTimeout(() => { child.kill(); finish(null) }, timeoutMs)
    child.stdout?.on('data', (c) => { out += c.toString() })
    child.on('error', () => { clearTimeout(timer); finish(null) })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish(code === 0 ? extractShellPath(out) : null)
    })
  })
}

/** Merge the login shell's PATH into the process env once, so bare-name CLI spawns resolve from a
 *  Finder launch. No-ops in dev / on Windows / on any resolution failure. */
export async function applyShellPath(): Promise<void> {
  if (!shouldResolveShellPath(app.isPackaged, process.platform)) return
  const discovered = await resolveShellPath()
  if (discovered) process.env.PATH = mergePath(process.env.PATH, discovered)
}
