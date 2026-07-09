import { describe, it, expect } from 'vitest'
import { resolveCapabilities } from './index'
import { STATIC_CAPABILITIES } from '../../../shared/capabilities'

describe('resolveCapabilities (pure ladder)', () => {
  it('uses the protocol result when the strategy succeeds', async () => {
    const live = { ...STATIC_CAPABILITIES.codex, source: 'protocol' as const, models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }], fetchedAt: 9 }
    expect(await resolveCapabilities('codex', async () => live)).toEqual(live)
  })
  it('falls back to the static floor when the strategy returns null or throws', async () => {
    expect((await resolveCapabilities('codex', async () => null)).source).toBe('static')
    expect((await resolveCapabilities('codex', async () => { throw new Error('boom') })).source).toBe('static')
  })
  it('unknown provider gets an empty static shape, never a rejection', async () => {
    const caps = await resolveCapabilities('nope', async () => null)
    expect(caps.models).toEqual([])
    expect(caps.provider).toBe('nope')
  })
})
