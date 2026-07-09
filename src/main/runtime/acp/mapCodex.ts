import type { AgentEvent, PermissionOption } from '../../../shared/runtime'
import { readableCommand } from '../codexAdapter'

// Pure mappers from codex app-server v2 frames (live-captured 2026-07-09,
// docs/research/codex-turn-frames-0.142.3.txt) to canonical AgentEvents.

/** YOLO → policy mapping, mirroring the one-shot -s semantics. */
export function codexTurnPolicy(yolo: boolean): { approvalPolicy: string; sandboxPolicy: { type: string } } {
  return yolo
    ? { approvalPolicy: 'never', sandboxPolicy: { type: 'workspaceWrite' } }
    : { approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly' } }
}

interface CodexItem {
  type?: string
  id?: string
  command?: string
  status?: string
  aggregatedOutput?: unknown
  changes?: { path?: string }[]
  diff?: unknown
  summary?: { text?: string }[]
}

const s = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** item/started|completed → tool rows. agentMessage/userMessage/empty reasoning are skipped. */
export function mapCodexItem(runId: string, phase: 'started' | 'completed', raw: unknown): AgentEvent[] {
  const item = raw as CodexItem | null
  if (!item || typeof item !== 'object' || !item.id || !item.type) return []
  const status: 'running' | 'completed' | 'failed' =
    phase === 'started' ? 'running' : item.status === 'failed' || item.status === 'declined' ? 'failed' : 'completed'
  switch (item.type) {
    case 'commandExecution': {
      const cmd = item.command ? readableCommand(item.command) : item.id
      const detail = s(item.aggregatedOutput) ?? cmd
      return [{ type: 'tool.updated', runId, toolCallId: item.id, title: cmd, kind: 'execute', status, detail }]
    }
    case 'fileChange': {
      const paths = (item.changes ?? []).map((c) => c.path).filter(Boolean).join(', ')
      const detail = s(item.diff)
      return [{ type: 'tool.updated', runId, toolCallId: item.id, title: paths ? `Edit ${paths}` : 'Edit files', kind: 'edit', status, ...(detail ? { detail } : {}) }]
    }
    case 'reasoning': {
      const text = (item.summary ?? []).map((x) => x?.text).filter(Boolean).join('\n')
      if (!text) return []
      return [{ type: 'tool.updated', runId, toolCallId: item.id, title: 'Reasoning', kind: 'reasoning', status, detail: text }]
    }
    case 'agentMessage': // text already streamed via item/agentMessage/delta
    case 'userMessage':
      return []
    default:
      return [{ type: 'tool.updated', runId, toolCallId: item.id, title: item.type, status }]
  }
}

/** item/agentMessage/delta → content.delta. */
export function mapCodexDelta(runId: string, params: unknown): AgentEvent[] {
  const delta = (params as { delta?: unknown } | null)?.delta
  return typeof delta === 'string' && delta ? [{ type: 'content.delta', runId, streamKind: 'assistant_text', text: delta }] : []
}

export interface CodexApprovalMapping {
  event: Extract<AgentEvent, { type: 'permission.requested' }>
  decisions: Record<string, unknown>
}

const DECISION_META: Record<string, { label: string; kind: PermissionOption['kind'] }> = {
  accept: { label: 'Allow once', kind: 'allow' },
  acceptForSession: { label: 'Allow for session', kind: 'allow_always' },
  acceptWithExecpolicyAmendment: { label: 'Always allow this command', kind: 'allow_always' },
  cancel: { label: 'Deny', kind: 'deny' }
}

/** Approval server request → permission card. `decisions` maps option id → the ORIGINAL
 *  availableDecisions value, echoed VERBATIM in the response — NAC never invents decisions. */
export function mapCodexApproval(runId: string, requestId: string, method: string, params: unknown): CodexApprovalMapping | null {
  const p = params as { command?: string; reason?: string; availableDecisions?: unknown[] } | null
  if (!p || typeof p !== 'object' || !Array.isArray(p.availableDecisions) || p.availableDecisions.length === 0) return null
  const options: PermissionOption[] = []
  const decisions: Record<string, unknown> = {}
  for (const d of p.availableDecisions) {
    const key = typeof d === 'string' ? d : typeof d === 'object' && d !== null ? Object.keys(d)[0] : undefined
    if (!key) continue
    const meta = DECISION_META[key] ?? { label: key, kind: 'deny' as const }
    options.push({ id: key, label: meta.label, kind: meta.kind })
    decisions[key] = d
  }
  if (options.length === 0) return null
  const isFileChange = method === 'item/fileChange/requestApproval'
  const cmd = p.command ? readableCommand(p.command) : undefined
  return {
    event: {
      type: 'permission.requested',
      runId,
      requestId,
      title: isFileChange ? 'Edit files' : cmd ?? 'Approve command',
      ...(isFileChange ? (p.reason ? { detail: p.reason } : {}) : cmd ? { detail: cmd } : {}),
      options
    },
    decisions
  }
}

export interface CodexUsageMapping {
  event: Extract<AgentEvent, { type: 'usage.updated' }>
  stepInput: number
  stepOutput: number
}

/** thread/tokenUsage/updated → usage.updated (+ per-step tokens for turn accumulation). */
export function mapCodexUsage(runId: string, params: unknown): CodexUsageMapping | null {
  const u = (params as { tokenUsage?: { total?: Record<string, number>; last?: Record<string, number>; modelContextWindow?: number } } | null)?.tokenUsage
  if (!u?.total) return null
  return {
    event: {
      type: 'usage.updated',
      runId,
      inputTokens: u.total.inputTokens ?? 0,
      cachedInputTokens: u.total.cachedInputTokens,
      outputTokens: u.total.outputTokens ?? 0,
      reasoningOutputTokens: u.total.reasoningOutputTokens,
      contextUsedTokens: u.total.totalTokens,
      contextWindow: u.modelContextWindow
    },
    stepInput: u.last?.inputTokens ?? 0,
    stepOutput: u.last?.outputTokens ?? 0
  }
}

/** turn/completed status → run terminal mapping. */
export function mapCodexTurnStatus(status: string | undefined, error: { message?: string } | null | undefined): { kind: 'completed'; stopReason: 'end_turn' | 'canceled' } | { kind: 'errored'; message: string } {
  if (status === 'completed') return { kind: 'completed', stopReason: 'end_turn' }
  if (status === 'interrupted' || status === 'cancelled' || status === 'canceled') return { kind: 'completed', stopReason: 'canceled' }
  return { kind: 'errored', message: error?.message ?? 'codex turn ended without status' }
}
