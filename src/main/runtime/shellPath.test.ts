import { describe, it, expect } from 'vitest'
import { shellPathArgs, extractShellPath, mergePath, shouldResolveShellPath, resolveShellPath } from './shellPath'

const MARKER = '__NAC_PATH__'
const wrap = (path: string, noise = ''): string => `${noise}${MARKER}${path}${MARKER}`

describe('shellPathArgs', () => {
  it('is a login+interactive shell that prints $PATH bracketed by markers', () => {
    expect(shellPathArgs()).toEqual([
      '-ilc',
      `command -v true >/dev/null 2>&1; printf '${MARKER}'; printenv PATH; printf '${MARKER}'`
    ])
  })
})

describe('extractShellPath', () => {
  it('returns the value between the two markers', () => {
    expect(extractShellPath(wrap('/opt/homebrew/bin:/usr/bin'))).toBe('/opt/homebrew/bin:/usr/bin')
  })
  it('recovers the PATH despite leading rc-file stdout noise (the real-world bug)', () => {
    // brew shellenv / nvm init etc. echo BEFORE our -c command runs; the value must survive intact
    expect(extractShellPath(wrap('/opt/homebrew/bin:/usr/bin', 'NOISE-FROM-RC\nnvm: v20\n')))
      .toBe('/opt/homebrew/bin:/usr/bin')
  })
  it('recovers the PATH despite trailing noise after the closing marker', () => {
    expect(extractShellPath(wrap('/opt/homebrew/bin', '') + 'trailing junk')).toBe('/opt/homebrew/bin')
  })
  it('returns null when the markers are absent (probe never reached the printf)', () => {
    expect(extractShellPath('NOISE-FROM-RC\n/usr/local/bin:/usr/bin')).toBeNull()
    expect(extractShellPath('')).toBeNull()
  })
  it('returns null when only one marker is present (truncated output)', () => {
    expect(extractShellPath(`${MARKER}/usr/bin`)).toBeNull()
  })
  it('returns null when the bracketed value is empty/whitespace', () => {
    expect(extractShellPath(wrap(''))).toBeNull()
    expect(extractShellPath(wrap('   '))).toBeNull()
  })
})

describe('mergePath', () => {
  it('keeps current entries first, appends new discovered ones, dedups, colon-joined', () => {
    expect(mergePath('/usr/bin:/bin', '/opt/homebrew/bin:/usr/bin:/Users/x/.local/bin'))
      .toBe('/usr/bin:/bin:/opt/homebrew/bin:/Users/x/.local/bin')
  })
  it('handles an undefined current path', () => {
    expect(mergePath(undefined, '/opt/homebrew/bin:/usr/bin')).toBe('/opt/homebrew/bin:/usr/bin')
  })
  it('empty/whitespace discovered leaves current unchanged', () => {
    expect(mergePath('/usr/bin', '   ')).toBe('/usr/bin')
    expect(mergePath('/usr/bin', '')).toBe('/usr/bin')
    expect(mergePath(undefined, '')).toBe('')
  })
})

describe('shouldResolveShellPath', () => {
  it('only runs for a packaged, non-Windows app', () => {
    expect(shouldResolveShellPath(true, 'darwin')).toBe(true)
    expect(shouldResolveShellPath(true, 'linux')).toBe(true)
    expect(shouldResolveShellPath(false, 'darwin')).toBe(false) // dev already has the terminal PATH
    expect(shouldResolveShellPath(true, 'win32')).toBe(false)   // deferred
  })
})

describe('resolveShellPath', () => {
  // Fake child. `neverCloses` models a hung shell (for the timeout branch). Captures the spawn opts.
  const fakeSpawn = (
    rawStdout: string,
    opts: { errorEvent?: Error; exitCode?: number; neverCloses?: boolean } = {}
  ) => {
    const seen: { stdio?: unknown } = {}
    let killed = false
    const spawn = (_cmd: string, _args: string[], spawnOpts: { stdio: unknown }) => {
      seen.stdio = spawnOpts.stdio
      const stdoutCbs: ((c: Buffer) => void)[] = []
      const closeCbs: ((code: number) => void)[] = []
      const errCbs: ((e: Error) => void)[] = []
      queueMicrotask(() => {
        if (opts.errorEvent) { errCbs.forEach((cb) => cb(opts.errorEvent!)); return }
        if (rawStdout) stdoutCbs.forEach((cb) => cb(Buffer.from(rawStdout)))
        if (!opts.neverCloses) closeCbs.forEach((cb) => cb(opts.exitCode ?? 0))
      })
      return {
        stdout: { on: (_e: string, cb: (c: Buffer) => void) => stdoutCbs.push(cb) },
        on: (e: string, cb: (a: Error | number) => void) => { if (e === 'close') closeCbs.push(cb); if (e === 'error') errCbs.push(cb) },
        kill: () => { killed = true }
      }
    }
    return Object.assign(spawn, { seen, wasKilled: () => killed })
  }

  it('returns the PATH extracted from the bracketed clean output', async () => {
    expect(await resolveShellPath(fakeSpawn(wrap('/opt/homebrew/bin:/usr/bin')) as never)).toBe('/opt/homebrew/bin:/usr/bin')
  })
  it('recovers the PATH even when rc files spew stdout noise first', async () => {
    expect(await resolveShellPath(fakeSpawn(wrap('/opt/homebrew/bin:/usr/bin', 'greeting\n')) as never))
      .toBe('/opt/homebrew/bin:/usr/bin')
  })
  it('ignores stderr (stdio: ignore, pipe, ignore) so an rc stderr flood cannot deadlock the shell', async () => {
    const spawn = fakeSpawn(wrap('/usr/bin'))
    await resolveShellPath(spawn as never)
    expect(spawn.seen.stdio).toEqual(['ignore', 'pipe', 'ignore'])
  })
  it('returns null on a nonzero exit', async () => {
    expect(await resolveShellPath(fakeSpawn(wrap('/x'), { exitCode: 1 }) as never)).toBeNull()
  })
  it('returns null on output with no markers', async () => {
    expect(await resolveShellPath(fakeSpawn('/usr/bin:/bin') as never)).toBeNull()
  })
  it('returns null on a spawn error event', async () => {
    expect(await resolveShellPath(fakeSpawn('', { errorEvent: new Error('ENOENT') }) as never)).toBeNull()
  })
  it('returns null (and kills the child) when the shell hangs past the timeout', async () => {
    const spawn = fakeSpawn(wrap('/usr/bin'), { neverCloses: true })
    expect(await resolveShellPath(spawn as never, 5)).toBeNull()
    expect(spawn.wasKilled()).toBe(true)
  })
  it('returns null when spawn itself throws synchronously', async () => {
    const throwingSpawn = (() => { throw new Error('spawn EACCES') }) as never
    expect(await resolveShellPath(throwingSpawn)).toBeNull()
  })
})
