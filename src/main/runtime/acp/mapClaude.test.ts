import { describe, it, expect } from 'vitest'
import { claudeSessionArgs, mapClaudeStreamEvent, mapClaudeAssistant, mapClaudeToolResult, mapClaudeCanUseTool, mapClaudeThinking, mapClaudeResult } from './mapClaude'

describe('claudeSessionArgs', () => {
  it('builds the exact spawn args, flags only when set', () => {
    expect(claudeSessionArgs({ yolo: false })).toEqual([
      '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--allow-dangerously-skip-permissions'
    ])
    expect(claudeSessionArgs({ yolo: true, model: 'claude-opus-4-8', effort: 'high', sessionId: 'sid1' })).toEqual([
      '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--allow-dangerously-skip-permissions',
      '--model', 'claude-opus-4-8', '--effort', 'high', '--resume', 'sid1'
    ])
  })
})

describe('mapClaudeStreamEvent', () => {
  it('maps text_delta to content.delta and ignores other SSE noise', () => {
    const frame = { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ello pillar three' } }, parent_tool_use_id: null }
    expect(mapClaudeStreamEvent('r', frame)).toEqual([{ type: 'content.delta', runId: 'r', streamKind: 'assistant_text', text: 'ello pillar three' }])
    expect(mapClaudeStreamEvent('r', { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })).toEqual([])
    expect(mapClaudeStreamEvent('r', { type: 'stream_event' })).toEqual([])
  })
  it('drops subagent frames (parent_tool_use_id a non-null string) — Task subagent text must never leak into the main transcript', () => {
    const frame = { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'subagent chatter' } }, parent_tool_use_id: 'toolu_parent' }
    expect(mapClaudeStreamEvent('r', frame)).toEqual([])
  })
  it('maps message_start usage to usage.updated with context = input + cache tokens', () => {
    const frame = { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 4133, cache_creation_input_tokens: 2049, cache_read_input_tokens: 15626, output_tokens: 3 } } } }
    const [e] = mapClaudeStreamEvent('r', frame)
    expect(e).toMatchObject({ type: 'usage.updated', runId: 'r', inputTokens: 4133, outputTokens: 3, contextUsedTokens: 4133 + 2049 + 15626 })
  })
})

describe('mapClaudeAssistant / mapClaudeToolResult', () => {
  it('maps Bash tool_use to an execute row titled by the command, Write to an edit row', () => {
    const bash = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: "echo 'x' > f.txt", description: 'd' } }] }, parent_tool_use_id: null }
    expect(mapClaudeAssistant('r', bash)).toEqual([{ type: 'tool.updated', runId: 'r', toolCallId: 't1', title: "echo 'x' > f.txt", kind: 'execute', status: 'running' }])
    const write = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: '/tmp/a.txt', content: 'y' } }] } }
    expect(mapClaudeAssistant('r', write)).toEqual([{ type: 'tool.updated', runId: 'r', toolCallId: 't2', title: 'Edit /tmp/a.txt', kind: 'edit', status: 'running' }])
    expect(mapClaudeAssistant('r', { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })).toEqual([])
  })
  it('completes rows from tool_result; is_error → failed; string content → detail', () => {
    const frame = { type: 'user', message: { content: [{ type: 'tool_result', content: 'blocked', is_error: true, tool_use_id: 't1' }] }, parent_tool_use_id: null }
    expect(mapClaudeToolResult('r', frame)).toEqual([{ type: 'tool.updated', runId: 'r', toolCallId: 't1', title: '', status: 'failed', detail: 'blocked' }])
    const ok = { type: 'user', message: { content: [{ type: 'tool_result', content: 'done', is_error: false, tool_use_id: 't2' }] } }
    expect(mapClaudeToolResult('r', ok)[0]).toMatchObject({ status: 'completed', detail: 'done' })
    expect(mapClaudeToolResult('r', { type: 'user', message: { content: [{ type: 'text', text: 'x' }] } })).toEqual([])
  })
  it('degrades to [] when message.content is not an array (junk frames must not throw)', () => {
    expect(mapClaudeAssistant('r', { type: 'assistant', message: { content: 42 } })).toEqual([])
    expect(mapClaudeAssistant('r', { type: 'assistant', message: { content: {} } })).toEqual([])
    expect(mapClaudeToolResult('r', { type: 'user', message: { content: 42 } })).toEqual([])
    expect(mapClaudeToolResult('r', { type: 'user' })).toEqual([])
  })
  it('extracts detail from array-form tool_result content', () => {
    const frame = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't9', is_error: false, content: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }] }] } }
    expect(mapClaudeToolResult('r', frame)[0]).toMatchObject({ status: 'completed', detail: 'line one\nline two' })
  })
  it('never renders "undefined" in a title when a tool_use block lacks a name', () => {
    const [e] = mapClaudeAssistant('r', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'nx', input: { file_path: '/tmp/x' } }] } })
    expect((e as { title: string }).title).toBe('tool /tmp/x')
  })
  it('drops subagent tool_use rows (parent_tool_use_id a non-null string) — Task subagent tool calls must not spawn top-level rows', () => {
    const frame = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tsub', name: 'Bash', input: { command: 'echo sub' } }] }, parent_tool_use_id: 'toolu_parent' }
    expect(mapClaudeAssistant('r', frame)).toEqual([])
  })
  it('drops subagent tool_result rows (parent_tool_use_id a non-null string)', () => {
    const frame = { type: 'user', message: { content: [{ type: 'tool_result', content: 'sub done', is_error: false, tool_use_id: 'tsub' }] }, parent_tool_use_id: 'toolu_parent' }
    expect(mapClaudeToolResult('r', frame)).toEqual([])
  })
})

describe('mapClaudeCanUseTool', () => {
  const request = {
    subtype: 'can_use_tool', tool_name: 'Write', display_name: 'Write',
    input: { file_path: '/tmp/y.txt', content: 'y' }, description: 'y.txt',
    permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }], tool_use_id: 'tu1'
  }
  it('builds allow / verbatim-suggestion / deny options with verbatim response payloads', () => {
    const m = mapClaudeCanUseTool('r', 'req1', request)!
    expect(m.event.options.map((o) => o.kind)).toEqual(['allow', 'allow_always', 'deny'])
    expect(m.event.title).toBe('Write')
    expect(m.event.detail).toBe('y.txt')
    expect(m.responses[m.event.options[0].id]).toEqual({ behavior: 'allow', updatedInput: request.input })
    expect(m.responses[m.event.options[1].id]).toEqual({ behavior: 'allow', updatedInput: request.input, updatedPermissions: [request.permission_suggestions[0]] })
    expect(m.event.options[1].label).toBe('Allow edits for session')
    expect(m.responses[m.event.options[2].id]).toEqual({ behavior: 'deny', message: 'Denied via NAC Code' })
  })
  it('returns null on junk', () => {
    expect(mapClaudeCanUseTool('r', 'x', {})).toBeNull()
  })
})

describe('mapClaudeThinking', () => {
  it('renders a running Thinking row keyed to the run', () => {
    const [e] = mapClaudeThinking('r', { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 183 })
    expect(e).toMatchObject({ type: 'tool.updated', toolCallId: 'thinking_r', title: 'Thinking…', kind: 'reasoning', status: 'running', detail: '~183 tokens' })
  })
})

describe('mapClaudeResult', () => {
  const success = { type: 'result', subtype: 'success', is_error: false, result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0.0946805, usage: { input_tokens: 4481, cache_creation_input_tokens: 2100, cache_read_input_tokens: 15700, output_tokens: 50 } }
  it('success → completed end_turn with real usage + cost + context', () => {
    const r = mapClaudeResult(success, false)
    expect(r).toMatchObject({ kind: 'completed', stopReason: 'end_turn', usage: { inputTokens: 4481, outputTokens: 50, costUsd: 0.0946805 }, contextUsedTokens: 4481 + 2100 + 15700 })
  })
  it('error_during_execution after OUR interrupt → canceled; without → errored', () => {
    const err = { type: 'result', subtype: 'error_during_execution', is_error: true, result: null }
    expect(mapClaudeResult(err, true)).toMatchObject({ kind: 'completed', stopReason: 'canceled' })
    expect(mapClaudeResult(err, false)).toMatchObject({ kind: 'errored' })
  })
})
