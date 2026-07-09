import type { AgentEvent, PermissionOption } from '../../../shared/runtime'

// Pure mappers from copilot ACP frames (live-captured 2026-07-09, docs/research/
// acp-prompt-frames-copilot-1.0.69.txt) to canonical AgentEvents.

interface AcpContentEntry {
  content?: { text?: string }
}
interface AcpUpdate {
  sessionUpdate?: string
  toolCallId?: string
  title?: string
  kind?: string
  status?: string
  rawInput?: { command?: string }
  rawOutput?: { content?: unknown }
  content?: AcpContentEntry[] | { text?: string }
}

const TOOL_STATUSES = new Set(['pending', 'running', 'completed', 'failed'])

/** rawOutput.content / rawInput.command can be structured (non-string) — only strings are safe to
 *  hand to React as event detail, so anything else is dropped rather than crashing the renderer. */
function asStringDetail(x: unknown): string | undefined {
  return typeof x === 'string' ? x : undefined
}

function contentText(u: AcpUpdate): string | undefined {
  if (Array.isArray(u.content)) {
    const texts = u.content.map((c) => c?.content?.text).filter((t): t is string => Boolean(t))
    return texts.length ? texts.join('') : undefined
  }
  return undefined
}

/** One session/update frame → 0..n AgentEvents. Unknown update kinds are ignored. */
export function mapAcpUpdate(runId: string, update: unknown): AgentEvent[] {
  const u = update as AcpUpdate | null
  if (!u || typeof u !== 'object') return []
  switch (u.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = (u.content as { text?: string } | undefined)?.text
      return text ? [{ type: 'content.delta', runId, streamKind: 'assistant_text', text }] : []
    }
    case 'tool_call':
    case 'tool_call_update': {
      if (!u.toolCallId) return []
      const status = (u.status && TOOL_STATUSES.has(u.status) ? u.status : u.sessionUpdate === 'tool_call' ? 'pending' : 'running') as 'pending' | 'running' | 'completed' | 'failed'
      const detail = asStringDetail(u.rawOutput?.content) ?? contentText(u) ?? u.rawInput?.command
      return [{ type: 'tool.updated', runId, toolCallId: u.toolCallId, title: u.title ?? u.toolCallId, kind: u.kind, status, ...(detail ? { detail } : {}) }]
    }
    default:
      return []
  }
}

const OPTION_KINDS: Record<string, PermissionOption['kind']> = {
  allow_once: 'allow',
  allow_always: 'allow_always',
  reject_once: 'deny',
  reject_always: 'deny'
}

/** session/request_permission params → a permission.requested event (null for junk/no options). */
export function mapPermissionRequest(runId: string, requestId: string, params: unknown): Extract<AgentEvent, { type: 'permission.requested' }> | null {
  const p = params as { toolCall?: { title?: string; rawInput?: { command?: string } }; options?: { optionId?: string; kind?: string; name?: string }[] } | null
  if (!p || typeof p !== 'object' || !Array.isArray(p.options) || p.options.length === 0) return null
  const options: PermissionOption[] = []
  for (const o of p.options) {
    if (!o?.optionId) continue
    options.push({ id: o.optionId, label: o.name ?? o.optionId, kind: OPTION_KINDS[o.kind ?? ''] ?? 'deny' })
  }
  if (options.length === 0) return null
  const detail = asStringDetail(p.toolCall?.rawInput?.command)
  return {
    type: 'permission.requested', runId, requestId,
    title: p.toolCall?.title ?? 'Permission request',
    ...(detail ? { detail } : {}),
    options
  }
}
