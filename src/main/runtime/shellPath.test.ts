import { describe, it, expect } from 'vitest'
import { shellPathArgs, mergePath, shouldResolveShellPath, resolveShellPath } from './shellPath'

describe('shellPathArgs', () => {
  it('is a login+interactive shell that prints only $PATH', () => {
    expect(shellPathArgs()).toEqual(['-ilc', 'command -v true >/dev/null 2>&1; printf "%s" "$PATH"'])
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
  const fakeSpawn = (stdout: string, opts: { errorEvent?: Error; exitCode?: number } = {}) => () => {
    const stdoutCbs: ((c: Buffer) => void)[] = []
    const closeCbs: ((code: number) => void)[] = []
    const errCbs: ((e: Error) => void)[] = []
    queueMicrotask(() => {
      if (opts.errorEvent) { errCbs.forEach((cb) => cb(opts.errorEvent!)); return }
      if (stdout) stdoutCbs.forEach((cb) => cb(Buffer.from(stdout)))
      closeCbs.forEach((cb) => cb(opts.exitCode ?? 0))
    })
    return {
      stdout: { on: (_e: string, cb: (c: Buffer) => void) => stdoutCbs.push(cb) },
      on: (e: string, cb: (a: never) => void) => { if (e === 'close') closeCbs.push(cb as never); if (e === 'error') errCbs.push(cb as never) },
      kill: () => {}
    }
  }

  it('returns the trimmed PATH on a clean exit', async () => {
    expect(await resolveShellPath(fakeSpawn('/opt/homebrew/bin:/usr/bin\n') as never)).toBe('/opt/homebrew/bin:/usr/bin')
  })
  it('returns null on a nonzero exit', async () => {
    expect(await resolveShellPath(fakeSpawn('/x', { exitCode: 1 }) as never)).toBeNull()
  })
  it('returns null on empty output', async () => {
    expect(await resolveShellPath(fakeSpawn('   ') as never)).toBeNull()
  })
  it('returns null on a spawn error', async () => {
    expect(await resolveShellPath(fakeSpawn('', { errorEvent: new Error('ENOENT') }) as never)).toBeNull()
  })
})
