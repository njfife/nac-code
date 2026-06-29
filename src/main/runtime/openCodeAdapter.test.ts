import { describe, it, expect } from 'vitest'
import { parseOpenCodeLine, openCodeArgs } from './openCodeAdapter'

// Exercised against the real `opencode run --format json` event shapes.
describe('parseOpenCodeLine', () => {
  it('maps step_start to run.started with the session id', () => {
    expect(parseOpenCodeLine('r', '{"type":"step_start","sessionID":"ses_1","part":{"type":"step-start"}}')).toEqual([
      { type: 'run.started', runId: 'r', sessionId: 'ses_1' }
    ])
  })

  it('maps a text part to a content delta', () => {
    expect(parseOpenCodeLine('r', '{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"ok"}}')).toEqual([
      { type: 'content.delta', runId: 'r', streamKind: 'assistant_text', text: 'ok' }
    ])
  })

  it('does NOT complete on step_finish (completion comes from process exit)', () => {
    expect(parseOpenCodeLine('r', '{"type":"step_finish","part":{"type":"step-finish","reason":"stop"}}')).toEqual([])
  })

  it('ignores non-JSON noise', () => {
    expect(parseOpenCodeLine('r', 'opencode banner')).toEqual([])
  })
})

describe('openCodeArgs', () => {
  it('builds run --format json with the model, and adds yolo/resume flags', () => {
    expect(openCodeArgs('hi', 'opencode/x')).toEqual(['run', 'hi', '--format', 'json', '-m', 'opencode/x'])
    expect(openCodeArgs('hi', 'm', true, 'ses_1')).toEqual(['run', 'hi', '--format', 'json', '-m', 'm', '--dangerously-skip-permissions', '-s', 'ses_1'])
  })
})
