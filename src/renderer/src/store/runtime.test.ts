import { describe, it, expect } from 'vitest'
import { buildReplayPrompt } from './runtime'
import type { Turn } from './store'

const turn = (role: Turn['role'], text: string): Turn => ({ id: `${role}_${text}`, role, text })

describe('buildReplayPrompt (cross-provider / compaction-aware replay)', () => {
  it('returns the bare message when there is nothing to replay', () => {
    expect(buildReplayPrompt(null, [], 'hello')).toBe('hello')
  })

  it('replays the tail turns when there is no summary', () => {
    const out = buildReplayPrompt(null, [turn('user', 'remember ZEBRA'), turn('assistant', 'ok')], 'what word?')
    expect(out).toContain('User: remember ZEBRA')
    expect(out).toContain('Assistant: ok')
    expect(out).toContain('User: what word?')
  })

  it('puts the compaction summary first and appends only the tail (not the whole history)', () => {
    const out = buildReplayPrompt('Earlier: user picked the codeword ZEBRA.', [turn('user', 'still there?')], 'what word?')
    expect(out).toContain('Summary of the earlier conversation:')
    expect(out).toContain('codeword ZEBRA')
    expect(out).toContain('User: still there?')
    expect(out.indexOf('Summary of the earlier conversation:')).toBeLessThan(out.indexOf('User: still there?'))
  })

  it('skips empty/streaming-placeholder turns', () => {
    const out = buildReplayPrompt(null, [turn('user', 'hi'), turn('assistant', '   ')], 'next')
    expect(out).toContain('User: hi')
    expect(out).not.toContain('Assistant:')
  })
})
