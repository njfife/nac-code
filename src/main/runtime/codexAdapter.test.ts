import { describe, it, expect } from 'vitest'
import { parseCodexLine } from './codexAdapter'

// Exercised against the real `codex exec --json` event shapes.
describe('parseCodexLine', () => {
  it('maps thread.started to run.started with the thread id', () => {
    expect(parseCodexLine('r', '{"type":"thread.started","thread_id":"t1"}')).toEqual([{ type: 'run.started', runId: 'r', sessionId: 't1' }])
  })

  it('maps an agent_message item to a content delta', () => {
    expect(parseCodexLine('r', '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}')).toEqual([
      { type: 'content.delta', runId: 'r', streamKind: 'assistant_text', text: 'ok' }
    ])
  })

  it('flattens non-message tool items and skips reasoning', () => {
    expect(parseCodexLine('r', '{"type":"item.completed","item":{"type":"command_execution"}}')).toEqual([{ type: 'content.delta', runId: 'r', streamKind: 'assistant_text', text: '\n[command_execution]\n' }])
    expect(parseCodexLine('r', '{"type":"item.completed","item":{"type":"reasoning","text":"hmm"}}')).toEqual([])
  })

  it('maps turn.completed to run.completed', () => {
    expect(parseCodexLine('r', '{"type":"turn.completed","usage":{}}')).toEqual([{ type: 'run.completed', runId: 'r', stopReason: 'end_turn' }])
  })

  it('ignores turn.started and non-JSON noise', () => {
    expect(parseCodexLine('r', '{"type":"turn.started"}')).toEqual([])
    expect(parseCodexLine('r', '2026-06-29 ERROR rmcp transport closed')).toEqual([])
  })
})
