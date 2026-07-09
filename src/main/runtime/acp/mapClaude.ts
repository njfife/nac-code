import type { AgentEvent, PermissionOption } from '../../../shared/runtime'

// Pure mappers from claude stream-json frames (live-captured 2026-07-09 on 2.1.181,
// docs/research/claude-stream-json-2.1.181.txt) to canonical AgentEvents.

export const THINKING_ROW_ID = 'thinking_'

export function claudeSessionArgs(o: { yolo: boolean; model?: string; effort?: string; sessionId?: string }): string[] {
  const args = [
    '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--allow-dangerously-skip-permissions'
  ]
  if (o.model) args.push('--model', o.model)
  if (o.effort) args.push('--effort', o.effort)
  if (o.sessionId) args.push('--resume', o.sessionId)
  return args
}

const s = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const n = (v: unknown): number => (typeof v === 'number' ? v : 0)

// claude Task subagents emit stream_event/assistant/user frames on the SAME stream, distinguished
// only by a non-null string `parent_tool_use_id`. Their text deltas must never feed the main turn's
// text (buildReplayPrompt replay pollution) and their tool_use/tool_result blocks must never spawn
// top-level rows — so every frame-consuming mapper checks this first and bails to [].
const isSubagentFrame = (frame: Record<string, unknown>): boolean => typeof frame.parent_tool_use_id === 'string'

interface Usage {
  input_tokens?: unknown
  cache_creation_input_tokens?: unknown
  cache_read_input_tokens?: unknown
  output_tokens?: unknown
}
const contextOf = (u: Usage): number => n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens)

export function mapClaudeStreamEvent(runId: string, frame: Record<string, unknown>): AgentEvent[] {
  if (isSubagentFrame(frame)) return []
  const ev = frame.event as { type?: string; delta?: { type?: string; text?: unknown }; message?: { usage?: Usage } } | undefined
  if (!ev) return []
  if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
    const text = s(ev.delta.text)
    return text ? [{ type: 'content.delta', runId, streamKind: 'assistant_text', text }] : []
  }
  if (ev.type === 'message_start' && ev.message?.usage) {
    const u = ev.message.usage
    return [{ type: 'usage.updated', runId, inputTokens: n(u.input_tokens), outputTokens: n(u.output_tokens), contextUsedTokens: contextOf(u) }]
  }
  return []
}

interface ToolUseBlock {
  type?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
}

function titleAndKind(b: ToolUseBlock): { title: string; kind?: 'execute' | 'edit' } {
  const input = b.input ?? {}
  if (b.name === 'Bash') return { title: s(input.command) ?? 'Bash', kind: 'execute' }
  if (b.name === 'Write' || b.name === 'Edit' || b.name === 'NotebookEdit') return { title: `Edit ${s(input.file_path) ?? ''}`.trim(), kind: 'edit' }
  const arg = s(input.file_path) ?? s(input.pattern) ?? s(input.path) ?? s(input.query)
  const name = b.name ?? 'tool' // partial frames must never render "undefined <arg>"
  return { title: arg ? `${name} ${arg}` : name }
}

export function mapClaudeAssistant(runId: string, frame: Record<string, unknown>): AgentEvent[] {
  if (isSubagentFrame(frame)) return []
  const raw = (frame.message as { content?: unknown } | undefined)?.content
  const content = Array.isArray(raw) ? (raw as ToolUseBlock[]) : []
  const out: AgentEvent[] = []
  for (const b of content) {
    if (b?.type !== 'tool_use' || !b.id) continue
    const { title, kind } = titleAndKind(b)
    out.push({ type: 'tool.updated', runId, toolCallId: b.id, title, ...(kind ? { kind } : {}), status: 'running' })
  }
  return out
}

export function mapClaudeToolResult(runId: string, frame: Record<string, unknown>): AgentEvent[] {
  if (isSubagentFrame(frame)) return []
  const raw = (frame.message as { content?: unknown } | undefined)?.content
  const content = Array.isArray(raw) ? (raw as { type?: string; content?: unknown; is_error?: unknown; tool_use_id?: unknown }[]) : []
  const out: AgentEvent[] = []
  for (const b of content) {
    if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
    const detail = s(b.content) ?? (Array.isArray(b.content)
      ? (b.content as { type?: string; text?: unknown }[]).map((c) => (c?.type === 'text' ? s(c.text) : undefined)).filter(Boolean).join('\n') || undefined
      : undefined)
    // title '' — upsertTool merges by toolCallId, so the running row's title survives.
    out.push({ type: 'tool.updated', runId, toolCallId: b.tool_use_id, title: '', status: b.is_error === true ? 'failed' : 'completed', ...(detail ? { detail } : {}) })
  }
  return out
}

export interface ClaudeApprovalMapping {
  event: Extract<AgentEvent, { type: 'permission.requested' }>
  responses: Record<string, unknown>
}

function suggestionLabel(sug: Record<string, unknown>): string {
  if (sug.type === 'setMode' && sug.mode === 'acceptEdits') return 'Allow edits for session'
  if (sug.type === 'setMode') return `Allow (${s(sug.mode) ?? 'mode'})`
  return 'Always allow'
}

export function mapClaudeCanUseTool(runId: string, requestId: string, request: Record<string, unknown>): ClaudeApprovalMapping | null {
  const toolName = s(request.display_name) ?? s(request.tool_name)
  const input = request.input
  if (!toolName || !input || typeof input !== 'object') return null
  const options: PermissionOption[] = [{ id: 'allow', label: 'Allow once', kind: 'allow' }]
  const responses: Record<string, unknown> = { allow: { behavior: 'allow', updatedInput: input } }
  const suggestions = Array.isArray(request.permission_suggestions) ? (request.permission_suggestions as Record<string, unknown>[]) : []
  suggestions.forEach((sug, i) => {
    const id = `sugg_${i}`
    options.push({ id, label: suggestionLabel(sug), kind: 'allow_always' })
    // The suggestion object goes back VERBATIM — claude defined it, NAC just relays the choice.
    responses[id] = { behavior: 'allow', updatedInput: input, updatedPermissions: [sug] }
  })
  options.push({ id: 'deny', label: 'Deny', kind: 'deny' })
  responses.deny = { behavior: 'deny', message: 'Denied via NAC Code' }
  const detail = s(request.description)
  return { event: { type: 'permission.requested', runId, requestId, title: toolName, ...(detail ? { detail } : {}), options }, responses }
}

export function mapClaudeThinking(runId: string, frame: Record<string, unknown>): AgentEvent[] {
  const tokens = n(frame.estimated_tokens)
  return [{ type: 'tool.updated', runId, toolCallId: `${THINKING_ROW_ID}${runId}`, title: 'Thinking…', kind: 'reasoning', status: 'running', detail: `~${tokens} tokens` }]
}

export type ClaudeResultMapping =
  | { kind: 'completed'; stopReason: 'end_turn' | 'canceled'; usage: { inputTokens: number; outputTokens: number; costUsd?: number }; contextUsedTokens?: number }
  | { kind: 'errored'; message: string }

export function mapClaudeResult(frame: Record<string, unknown>, interrupted: boolean): ClaudeResultMapping {
  const u = (frame.usage ?? {}) as Usage
  const usage = {
    inputTokens: n(u.input_tokens),
    outputTokens: n(u.output_tokens),
    ...(typeof frame.total_cost_usd === 'number' ? { costUsd: frame.total_cost_usd } : {})
  }
  const ctx = contextOf(u)
  if (frame.subtype === 'success' && frame.is_error !== true) {
    return { kind: 'completed', stopReason: 'end_turn', usage, ...(ctx > 0 ? { contextUsedTokens: ctx } : {}) }
  }
  if (frame.subtype === 'error_during_execution' && interrupted) {
    return { kind: 'completed', stopReason: 'canceled', usage, ...(ctx > 0 ? { contextUsedTokens: ctx } : {}) }
  }
  return { kind: 'errored', message: s(frame.result) ?? `claude result: ${s(frame.subtype) ?? 'unknown error'}` }
}
