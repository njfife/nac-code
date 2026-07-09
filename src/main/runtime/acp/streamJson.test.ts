import { describe, it, expect, vi } from 'vitest'
import { StreamJsonClient } from './streamJson'

describe('StreamJsonClient', () => {
  it('dispatches typed frames by exact type match', async () => {
    // Child prints two frames then exits — handler must see only its type.
    const script = `process.stdout.write(JSON.stringify({type:'a',v:1})+'\\n'+JSON.stringify({type:'b',v:2})+'\\n')`
    const client = new StreamJsonClient(process.execPath, ['-e', script])
    const got = await new Promise<Record<string, unknown>>((resolve) => client.onFrame('b', resolve))
    expect(got.v).toBe(2)
    expect(client.isClosed === false || client.isClosed === true).toBe(true) // no throw path
  })

  it('ignores non-JSON lines and frames without a string type', async () => {
    const script = `process.stdout.write('not json\\n{"v":1}\\n'+JSON.stringify({type:'ok'})+'\\n')`
    const client = new StreamJsonClient(process.execPath, ['-e', script])
    const got = await new Promise<Record<string, unknown>>((resolve) => client.onFrame('ok', resolve))
    expect(got.type).toBe('ok')
  })

  it('fires onClose once on exit, immediately for late registration, and marks isClosed', async () => {
    const client = new StreamJsonClient(process.execPath, ['-e', 'process.exit(0)'])
    let fires = 0
    await new Promise<void>((resolve) => client.onClose(() => { fires++; resolve() }))
    await new Promise((r) => setTimeout(r, 50))
    expect(fires).toBe(1)
    expect(client.isClosed).toBe(true)
    const late = await new Promise<boolean>((resolve) => client.onClose(() => resolve(true)))
    expect(late).toBe(true)
  })

  it('collapses spawn-failure error→close to one firing', async () => {
    const client = new StreamJsonClient('definitely-not-a-real-binary-xyz', [])
    let fires = 0
    await new Promise<void>((resolve) => client.onClose(() => { fires++; resolve() }))
    await new Promise((r) => setTimeout(r, 50))
    expect(fires).toBe(1)
    expect(client.isClosed).toBe(true)
  })

  it('send() after the child has died is a no-op guarded by isClosed (never touches stdin)', async () => {
    // Child exits immediately — by the time onClose fires, stdin is torn down.
    const client = new StreamJsonClient(process.execPath, ['-e', 'process.exit(0)'])
    await new Promise<void>((resolve) => client.onClose(() => resolve()))
    expect(client.isClosed).toBe(true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reaching into the child to spy on stdin
    const stdin = (client as any).child.stdin
    const writeSpy = stdin ? vi.spyOn(stdin, 'write') : undefined
    expect(() => client.send({ type: 'x' })).not.toThrow()
    if (writeSpy) expect(writeSpy).not.toHaveBeenCalled()
    // Give any async 'error' event a tick to surface — an unlistened emit would crash the process.
    await new Promise((r) => setTimeout(r, 50))
  })

  it('registers an error listener on stdin so a live EPIPE never becomes an uncaught exception', () => {
    const client = new StreamJsonClient(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reaching into the child to inspect listeners
    const stdin = (client as any).child.stdin
    expect(stdin.listenerCount('error')).toBeGreaterThan(0)
    client.close()
  })
})
