import { describe, it, expect } from 'vitest'
import { buildReplayPrompt, buildContextBlock } from './runtime'
import type { Turn } from './store'
import type { ContextItem } from '../data/context'

const item = (over: Partial<ContextItem>): ContextItem => ({ id: 'x', type: 'instruction', name: 'x', description: '', tokens: 0, scope: 'workspace', source: 'user', tags: [], ...over })

describe('buildContextBlock (attached context injection)', () => {
  it('injects note content + file contents and skips items with neither', () => {
    const out = buildContextBlock(
      [item({ name: 'style', content: 'Use tabs.' }), item({ name: 'a.ts', type: 'file', path: '/a.ts' }), item({ name: 'empty' })],
      { '/a.ts': 'export const x = 1' }
    )
    expect(out).toContain('## style')
    expect(out).toContain('Use tabs.')
    expect(out).toContain('## a.ts (/a.ts)')
    expect(out).toContain('export const x = 1')
    expect(out).not.toContain('## empty')
    expect(out.endsWith('---\n\n')).toBe(true)
  })

  it('returns empty when nothing is injectable', () => {
    expect(buildContextBlock([], {})).toBe('')
    expect(buildContextBlock([item({ name: 'empty' })], {})).toBe('')
  })
})

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
