import { describe, it, expect } from 'vitest'
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
})
