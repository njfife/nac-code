import { describe, it, expect } from 'vitest'
import { mapAcpUpdate, mapPermissionRequest } from './mapAcp'

const TOOL_CALL = { sessionUpdate: 'tool_call', toolCallId: 'call_MHx', title: 'Run echo nac-probe-ok', kind: 'execute', status: 'pending', rawInput: { command: 'echo nac-probe-ok', description: 'Run echo nac-probe-ok', mode: 'sync' } }
const TOOL_DONE = { sessionUpdate: 'tool_call_update', toolCallId: 'call_MHx', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'nac-probe-ok\n<shellId: 0 completed with exit code 0>' } }], rawOutput: { content: 'nac-probe-ok\n<shellId: 0 completed with exit code 0>' } }
const CHUNK = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'It printed ' } }
const PERM = { sessionId: 's1', toolCall: { toolCallId: 'call_MHx', title: 'Run echo nac-probe-ok', kind: 'execute', status: 'pending', rawInput: { command: 'echo nac-probe-ok' } }, options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' }, { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' }] }

describe('mapAcpUpdate', () => {
  it('maps tool_call to a pending tool.updated carrying the command as detail', () => {
    expect(mapAcpUpdate('r', TOOL_CALL)).toEqual([{ type: 'tool.updated', runId: 'r', toolCallId: 'call_MHx', title: 'Run echo nac-probe-ok', kind: 'execute', status: 'pending', detail: 'echo nac-probe-ok' }])
  })
  it('maps a completed tool_call_update carrying output text as detail', () => {
    const [e] = mapAcpUpdate('r', TOOL_DONE)
    expect(e).toMatchObject({ type: 'tool.updated', toolCallId: 'call_MHx', status: 'completed' })
    expect((e as { detail?: string }).detail).toContain('nac-probe-ok')
  })
  it('maps agent_message_chunk to content.delta and ignores unknown/junk updates', () => {
    expect(mapAcpUpdate('r', CHUNK)).toEqual([{ type: 'content.delta', runId: 'r', streamKind: 'assistant_text', text: 'It printed ' }])
    expect(mapAcpUpdate('r', { sessionUpdate: 'plan' })).toEqual([])
    expect(mapAcpUpdate('r', null)).toEqual([])
  })
  it('preserves a tool_call_update without status as a running upsert', () => {
    const [e] = mapAcpUpdate('r', { sessionUpdate: 'tool_call_update', toolCallId: 'call_MHx', content: [{ type: 'content', content: { type: 'text', text: 'partial' } }] })
    expect(e).toMatchObject({ type: 'tool.updated', status: 'running', detail: 'partial' })
  })
  it('never surfaces a non-string rawOutput.content as detail (Minor 6: React would crash on an object child)', () => {
    const [e] = mapAcpUpdate('r', { sessionUpdate: 'tool_call_update', toolCallId: 'call_MHx', status: 'completed', rawOutput: { content: { type: 'image', data: 'base64...' } } })
    expect(e).toMatchObject({ type: 'tool.updated', toolCallId: 'call_MHx', status: 'completed' })
    expect((e as { detail?: unknown }).detail).toBeUndefined()
  })
})

describe('mapPermissionRequest', () => {
  it('maps the captured request with normalized option kinds', () => {
    const e = mapPermissionRequest('r', 'req1', PERM)
    expect(e).toEqual({
      type: 'permission.requested', runId: 'r', requestId: 'req1', title: 'Run echo nac-probe-ok',
      detail: 'echo nac-probe-ok',
      options: [
        { id: 'allow_once', label: 'Allow once', kind: 'allow' },
        { id: 'allow_always', label: 'Always allow', kind: 'allow_always' },
        { id: 'reject_once', label: 'Deny', kind: 'deny' }
      ]
    })
  })
  it('returns null for junk', () => {
    expect(mapPermissionRequest('r', 'x', null)).toBeNull()
    expect(mapPermissionRequest('r', 'x', { options: [] })).toBeNull()
  })
})
