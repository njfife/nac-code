import { describe, it, expect } from 'vitest'
import { parseHarnessLine } from './harnessRunner'

describe('parseHarnessLine', () => {
  it('maps a delta to content.delta (assistant_text)', () => {
    expect(parseHarnessLine('r1', '{"type":"delta","text":"hi"}')).toEqual({
      type: 'content.delta',
      runId: 'r1',
      streamKind: 'assistant_text',
      text: 'hi'
    })
  })

  it('marks reasoning deltas', () => {
    expect(parseHarnessLine('r1', '{"type":"delta","text":"think","reasoning":true}')).toMatchObject({
      streamKind: 'reasoning'
    })
  })

  it('maps done to run.completed (end_turn)', () => {
    expect(parseHarnessLine('r1', '{"type":"done"}')).toEqual({
      type: 'run.completed',
      runId: 'r1',
      stopReason: 'end_turn'
    })
  })

  it('coerces missing text to empty string', () => {
    expect(parseHarnessLine('r1', '{"type":"delta"}')).toMatchObject({ text: '' })
  })

  it('ignores blank, unparseable, and unknown lines', () => {
    expect(parseHarnessLine('r1', '')).toBeNull()
    expect(parseHarnessLine('r1', '   ')).toBeNull()
    expect(parseHarnessLine('r1', 'not json')).toBeNull()
    expect(parseHarnessLine('r1', '{"type":"weird"}')).toBeNull()
  })

  it('carries the runId through', () => {
    expect(parseHarnessLine('run_42', '{"type":"done"}')).toMatchObject({ runId: 'run_42' })
  })
})
