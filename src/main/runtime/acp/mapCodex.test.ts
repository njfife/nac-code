import { describe, it, expect } from 'vitest'
import { codexTurnPolicy, mapCodexItem, mapCodexDelta, mapCodexApproval, mapCodexUsage, mapCodexTurnStatus } from './mapCodex'

const CMD_ITEM = { type: 'commandExecution', id: 'call_3Sac', command: "/bin/zsh -lc 'touch nac-approval-probe.txt'", cwd: '/tmp/x', status: 'inProgress' }
const CMD_DONE = { ...CMD_ITEM, status: 'completed', aggregatedOutput: 'ok\n' }
const APPROVAL = { threadId: 't1', turnId: 'turn1', itemId: 'call_dvl', command: "/bin/zsh -lc 'touch nac-approval-probe.txt'", cwd: '/tmp/x', availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch', 'nac-approval-probe.txt'] } }, 'cancel'] }
const USAGE = { threadId: 't1', turnId: 'turn1', tokenUsage: { total: { totalTokens: 42305, inputTokens: 41684, cachedInputTokens: 25344, outputTokens: 621, reasoningOutputTokens: 474 }, last: { totalTokens: 21311, inputTokens: 21092, cachedInputTokens: 20352, outputTokens: 219, reasoningOutputTokens: 148 }, modelContextWindow: 272000 } }

describe('codexTurnPolicy', () => {
  it('maps YOLO to never/workspaceWrite and off to untrusted/readOnly', () => {
    expect(codexTurnPolicy(true)).toEqual({ approvalPolicy: 'never', sandboxPolicy: { type: 'workspaceWrite' } })
    expect(codexTurnPolicy(false)).toEqual({ approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly' } })
  })
})

describe('mapCodexItem', () => {
  it('maps commandExecution started/completed to tool rows with the unwrapped command', () => {
    expect(mapCodexItem('r', 'started', CMD_ITEM)).toEqual([{ type: 'tool.updated', runId: 'r', toolCallId: 'call_3Sac', title: 'touch nac-approval-probe.txt', kind: 'execute', status: 'running', detail: 'touch nac-approval-probe.txt' }])
    const [done] = mapCodexItem('r', 'completed', CMD_DONE)
    expect(done).toMatchObject({ type: 'tool.updated', status: 'completed' })
    expect((done as { detail?: string }).detail).toContain('ok')
  })
  it('maps a failed commandExecution to failed', () => {
    expect(mapCodexItem('r', 'completed', { ...CMD_ITEM, status: 'failed' })[0]).toMatchObject({ status: 'failed' })
  })
  it('maps a DECLINED commandExecution to failed (denied commands must not render ✓)', () => {
    expect(mapCodexItem('r', 'completed', { ...CMD_ITEM, status: 'declined' })[0]).toMatchObject({ status: 'failed' })
  })
  it('maps fileChange to an edit row carrying the diff and skips agentMessage/userMessage/empty reasoning', () => {
    const [fc] = mapCodexItem('r', 'completed', { type: 'fileChange', id: 'fc1', changes: [{ path: 'a.ts' }], diff: '--- a.ts\n+++ a.ts\n+x' })
    expect(fc).toMatchObject({ type: 'tool.updated', kind: 'edit', status: 'completed' })
    expect((fc as { detail?: string }).detail).toContain('+++')
    expect(mapCodexItem('r', 'completed', { type: 'agentMessage', id: 'm1', text: 'hi' })).toEqual([])
    expect(mapCodexItem('r', 'started', { type: 'userMessage', id: 'u1' })).toEqual([])
    expect(mapCodexItem('r', 'completed', { type: 'reasoning', id: 'rs1', summary: [], content: [] })).toEqual([])
    expect(mapCodexItem('r', 'started', null)).toEqual([])
  })
  it('renders reasoning WITH summary text as a collapsed row', () => {
    const [e] = mapCodexItem('r', 'completed', { type: 'reasoning', id: 'rs2', summary: [{ type: 'summary_text', text: 'thought about it' }], content: [] })
    expect(e).toMatchObject({ type: 'tool.updated', kind: 'reasoning', title: 'Reasoning', status: 'completed', detail: 'thought about it' })
  })
})

describe('mapCodexDelta', () => {
  it('maps agentMessage deltas to assistant text', () => {
    expect(mapCodexDelta('r', { itemId: 'm1', delta: 'Using' })).toEqual([{ type: 'content.delta', runId: 'r', streamKind: 'assistant_text', text: 'Using' }])
    expect(mapCodexDelta('r', {})).toEqual([])
  })
})

describe('mapCodexApproval', () => {
  it('maps the captured request; options mirror availableDecisions; decisions echo the ORIGINAL values', () => {
    const m = mapCodexApproval('r', 'req1', 'item/commandExecution/requestApproval', APPROVAL)!
    expect(m.event).toMatchObject({ type: 'permission.requested', requestId: 'req1', title: 'touch nac-approval-probe.txt', detail: 'touch nac-approval-probe.txt' })
    expect(m.event.options).toEqual([
      { id: 'accept', label: 'Allow once', kind: 'allow' },
      { id: 'acceptWithExecpolicyAmendment', label: 'Always allow this command', kind: 'allow_always' },
      { id: 'cancel', label: 'Deny', kind: 'deny' }
    ])
    expect(m.decisions.accept).toBe('accept')
    expect(m.decisions.cancel).toBe('cancel')
    expect(m.decisions.acceptWithExecpolicyAmendment).toEqual(APPROVAL.availableDecisions[1])
  })
  it('maps acceptForSession to allow_always and tolerates junk', () => {
    const m = mapCodexApproval('r', 'x', 'item/commandExecution/requestApproval', { ...APPROVAL, availableDecisions: ['accept', 'acceptForSession', 'cancel'] })!
    expect(m.event.options[1]).toEqual({ id: 'acceptForSession', label: 'Allow for session', kind: 'allow_always' })
    expect(mapCodexApproval('r', 'x', 'item/commandExecution/requestApproval', null)).toBeNull()
    expect(mapCodexApproval('r', 'x', 'item/commandExecution/requestApproval', { availableDecisions: [] })).toBeNull()
  })
  it('maps fileChange approvals with a reason', () => {
    const m = mapCodexApproval('r', 'x', 'item/fileChange/requestApproval', { itemId: 'i', reason: 'writes outside sandbox', availableDecisions: ['accept', 'cancel'] })!
    expect(m.event.title).toBe('Edit files')
    expect(m.event.detail).toBe('writes outside sandbox')
  })
})

describe('mapCodexUsage', () => {
  it('maps the captured usage frame to usage.updated + step tokens', () => {
    const m = mapCodexUsage('r', USAGE)!
    expect(m.event).toEqual({ type: 'usage.updated', runId: 'r', inputTokens: 41684, cachedInputTokens: 25344, outputTokens: 621, reasoningOutputTokens: 474, contextUsedTokens: 42305, contextWindow: 272000 })
    expect(m.stepInput).toBe(21092)
    expect(m.stepOutput).toBe(219)
    expect(mapCodexUsage('r', null)).toBeNull()
  })
})

describe('mapCodexTurnStatus', () => {
  it('maps completed/interrupted/error', () => {
    expect(mapCodexTurnStatus('completed', null)).toEqual({ kind: 'completed', stopReason: 'end_turn' })
    expect(mapCodexTurnStatus('interrupted', null)).toEqual({ kind: 'completed', stopReason: 'canceled' })
    expect(mapCodexTurnStatus('failed', { message: 'boom' })).toEqual({ kind: 'errored', message: 'boom' })
    expect(mapCodexTurnStatus(undefined, undefined)).toEqual({ kind: 'errored', message: 'codex turn ended without status' })
  })
})
