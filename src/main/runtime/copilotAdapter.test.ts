import { describe, it, expect } from 'vitest'
import { parseCopilotLine, copilotArgs } from './copilotAdapter'

describe('copilotArgs (autonomy)', () => {
  it('uses --allow-all-tools by default and --yolo under yolo', () => {
    expect(copilotArgs('hi')).toContain('--allow-all-tools')
    expect(copilotArgs('hi', true)).toContain('--yolo')
    expect(copilotArgs('hi', true)).not.toContain('--allow-all-tools')
  })

  it('appends --resume= when given a session', () => {
    expect(copilotArgs('hi', false, 'sid')).toContain('--resume=sid')
    expect(copilotArgs('hi')).not.toContain('--resume=undefined')
  })

  it('passes reasoning effort', () => {
    expect(copilotArgs('hi', false, undefined, 'medium')).toEqual(expect.arrayContaining(['--reasoning-effort', 'medium']))
    expect(copilotArgs('hi')).not.toContain('--reasoning-effort')
  })

  it('passes --model when set', () => {
    expect(copilotArgs('hi', false, undefined, undefined, 'claude-sonnet-4.6')).toEqual(expect.arrayContaining(['--model', 'claude-sonnet-4.6']))
    expect(copilotArgs('hi')).not.toContain('--model')
  })
})

// Exercised against the real `copilot -p --output-format json` event shapes.
describe('parseCopilotLine', () => {
  it('streams assistant message deltas as content deltas', () => {
    expect(parseCopilotLine('r', '{"type":"assistant.message_delta","data":{"messageId":"m","deltaContent":"ok"}}')).toEqual([
      { type: 'content.delta', runId: 'r', streamKind: 'assistant_text', text: 'ok' }
    ])
  })

  it('maps result to run.started (carrying the session id) + run.completed', () => {
    expect(parseCopilotLine('r', '{"type":"result","sessionId":"s1","exitCode":0,"usage":{}}')).toEqual([
      { type: 'run.started', runId: 'r', sessionId: 's1' },
      { type: 'run.completed', runId: 'r', stopReason: 'end_turn' }
    ])
  })

  it('reports a non-zero exit as an error stop', () => {
    expect(parseCopilotLine('r', '{"type":"result","sessionId":"s1","exitCode":1}')).toEqual([
      { type: 'run.started', runId: 'r', sessionId: 's1' },
      { type: 'run.completed', runId: 'r', stopReason: 'error' }
    ])
  })

  it('ignores session/setup/turn noise and non-JSON lines', () => {
    expect(parseCopilotLine('r', '{"type":"session.mcp_servers_loaded","data":{}}')).toEqual([])
    expect(parseCopilotLine('r', '{"type":"user.message","data":{"content":"hi"}}')).toEqual([])
    expect(parseCopilotLine('r', '{"type":"assistant.turn_start","data":{}}')).toEqual([])
    expect(parseCopilotLine('r', 'not json')).toEqual([])
  })
})
