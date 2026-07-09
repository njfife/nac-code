import { describe, it, expect } from 'vitest'
import { parseClaudeLine, claudeArgs } from './claudeAdapter'

describe('claudeArgs (autonomy)', () => {
  it('skips permissions only under yolo, resumes a session, and passes the model alias', () => {
    expect(claudeArgs('hi')).not.toContain('--dangerously-skip-permissions')
    expect(claudeArgs('hi', undefined, true)).toContain('--dangerously-skip-permissions')
    expect(claudeArgs('hi', 's1')).toEqual(expect.arrayContaining(['--resume', 's1']))
    expect(claudeArgs('hi')).not.toContain('--model')
    expect(claudeArgs('hi', undefined, false, 'sonnet')).toEqual(expect.arrayContaining(['--model', 'sonnet']))
  })

  it('passes effort and injects fastMode via per-run settings', () => {
    expect(claudeArgs('hi', undefined, false, 'opus', 'high')).toEqual(expect.arrayContaining(['--effort', 'high']))
    expect(claudeArgs('hi')).not.toContain('--effort')
    expect(claudeArgs('hi', undefined, false, 'opus', undefined, true)).toEqual(expect.arrayContaining(['--settings', '{"fastMode":true}']))
    expect(claudeArgs('hi')).not.toContain('--settings')
  })
})

// Exercised against the real `claude --output-format stream-json` event shapes.
describe('parseClaudeLine', () => {
  it('maps system/init to run.started with the session id', () => {
    expect(parseClaudeLine('r', '{"type":"system","subtype":"init","session_id":"abc"}')).toEqual([{ type: 'run.started', runId: 'r', sessionId: 'abc' }])
  })

  it('ignores hook, rate-limit, and summary system events', () => {
    expect(parseClaudeLine('r', '{"type":"system","subtype":"hook_started"}')).toEqual([])
    expect(parseClaudeLine('r', '{"type":"rate_limit_event"}')).toEqual([])
    expect(parseClaudeLine('r', '{"type":"system","subtype":"post_turn_summary"}')).toEqual([])
  })

  it('maps assistant thinking + text blocks to content deltas in order', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Hello there, friend!' }] } })
    expect(parseClaudeLine('r', line)).toEqual([
      { type: 'content.delta', runId: 'r', streamKind: 'reasoning', text: 'hmm' },
      { type: 'content.delta', runId: 'r', streamKind: 'assistant_text', text: 'Hello there, friend!' }
    ])
  })

  it('flattens tool_use blocks to a readable note', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } })
    expect(parseClaudeLine('r', line)).toEqual([{ type: 'content.delta', runId: 'r', streamKind: 'assistant_text', text: '\n[tool: Read]\n' }])
  })

  it('maps result to run.completed (end_turn / error)', () => {
    expect(parseClaudeLine('r', '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}')).toEqual([{ type: 'run.completed', runId: 'r', stopReason: 'end_turn' }])
    expect(parseClaudeLine('r', '{"type":"result","is_error":true}')).toEqual([{ type: 'run.completed', runId: 'r', stopReason: 'error' }])
  })

  it('ignores blank and unparseable lines', () => {
    expect(parseClaudeLine('r', '')).toEqual([])
    expect(parseClaudeLine('r', 'not json')).toEqual([])
  })

  it('surfaces a model-rejection result as run.errored with the message', () => {
    const line = JSON.stringify({ type: 'result', is_error: true, result: "There's an issue with the selected model (bogus). It may not exist or you may not have access to it." })
    expect(parseClaudeLine('r', line)).toEqual([{ type: 'run.errored', runId: 'r', message: "There's an issue with the selected model (bogus). It may not exist or you may not have access to it." }])
    // plain errors keep the existing completed/error mapping
    expect(parseClaudeLine('r', '{"type":"result","is_error":true}')).toEqual([{ type: 'run.completed', runId: 'r', stopReason: 'error' }])
  })
})
