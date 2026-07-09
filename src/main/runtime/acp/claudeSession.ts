import { StreamJsonClient } from './streamJson'
import type { AgentEvent } from '../../../shared/runtime'
import { acpCwd, pickAutoApprove, shouldAutoCancelPermission, PROMPT_TIMEOUT_MS, type TransportSession, type PromptOpts } from './acpSession'
import {
  claudeSessionArgs,
  mapClaudeStreamEvent,
  mapClaudeAssistant,
  mapClaudeToolResult,
  mapClaudeCanUseTool,
  mapClaudeThinking,
  mapClaudeResult,
  THINKING_ROW_ID,
  type ClaudeResultMapping
} from './mapClaude'

// claude stream-json transport (pillar 3). Differs from copilot ACP / codex app-server in three
// ways the code must respect: (1) there is NO handshake — the child is a one-shot `--print` process
// per spawn, so `connect()` itself spawns (never the constructor) and a resumed session must be
// VERIFIED (a bogus/expired --resume id exits in ~1.3s; a real one just sits there streaming
// nothing until prompted); (2) model/effort are baked into argv at spawn time, so changing them
// mid-conversation means killing the child and respawning with `--resume`; (3) YOLO is not a spawn
// flag — the child is always spawned non-bypass and bypassPermissions is toggled live via a
// `set_permission_mode` control_request, so flipping the switch takes effect on the NEXT prompt
// without losing the process.

export const RESUME_VERIFY_MS = 2000

/** Pure + exported for testing: only respawn when a session actually exists to `--resume` into AND
 *  a requested field is BOTH defined and different from what's currently spawned. An undefined
 *  requested field means "no preference" and must never force a respawn. */
export function needsRespawn(spawned: PromptOpts, requested: PromptOpts, sessionId: string | null): boolean {
  if (sessionId === null) return false
  const modelChanged = requested.model !== undefined && requested.model !== spawned.model
  const effortChanged = requested.effort !== undefined && requested.effort !== spawned.effort
  return modelChanged || effortChanged
}

interface PendingApproval {
  claudeRequestId: string
  responses: Record<string, unknown>
  denyId: string
}

export class ClaudeSession implements TransportSession {
  private client!: StreamJsonClient
  private cwd = ''
  private spawned: PromptOpts
  private knownSessionId: string | null = null
  private turnAnnouncedId: string | null = null
  private currentRunId: string | null = null
  private interrupted = false
  private replaying = false // claude's --resume doesn't visibly replay history, but the guard exists for parity
  private thinkingRowActive = false
  private approvalSeq = 0
  private modeSeq = 0
  private interruptSeq = 0
  private appliedYolo = false // spawn is always non-bypass — 'default' mode is what's live until synced
  private pendingApprovals = new Map<string, PendingApproval>()
  private watchdog: ReturnType<typeof setTimeout> | null = null
  private onEvent: (e: AgentEvent) => void
  private yolo: boolean

  constructor(onEvent: (e: AgentEvent) => void, yolo: boolean, opts?: PromptOpts) {
    this.onEvent = onEvent
    this.yolo = yolo
    this.spawned = { model: opts?.model, effort: opts?.effort }
  }

  setYolo(y: boolean): void {
    this.yolo = y
  }

  get busy(): boolean {
    return this.currentRunId !== null
  }

  get dead(): boolean {
    return this.client.isClosed
  }

  private newClient(sessionId: string | undefined): StreamJsonClient {
    const args = claudeSessionArgs({ yolo: false, model: this.spawned.model, effort: this.spawned.effort, sessionId })
    const client = new StreamJsonClient('claude', args, this.cwd)
    this.attach(client)
    return client
  }

  /** claude has no handshake: spawns the child directly. Fresh sessions resolve immediately with ''
   *  — the real id arrives on the first `system/init` frame. A resumed session is VERIFIED by
   *  racing RESUME_VERIFY_MS against onClose: a bogus/expired --resume id exits almost immediately,
   *  well under the ceiling, so a close in that window means the resume failed — throw so the caller
   *  falls back to a one-shot resume (context-preservation doctrine, pillar 1). */
  async connect(cwd: string | undefined, existingSessionId: string | undefined): Promise<string> {
    this.cwd = acpCwd(cwd)
    this.client = this.newClient(existingSessionId)
    if (existingSessionId) {
      this.replaying = true
      try {
        const closedEarly = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), RESUME_VERIFY_MS)
          this.client.onClose(() => {
            clearTimeout(timer)
            resolve(true)
          })
        })
        if (closedEarly) throw new Error('claude: resume verification failed — session exited before the verify window elapsed')
        this.knownSessionId = existingSessionId
        return existingSessionId
      } finally {
        this.replaying = false
      }
    }
    return ''
  }

  prompt(runId: string, text: string, opts?: PromptOpts): void {
    const requested: PromptOpts = opts ?? {}
    if (needsRespawn(this.spawned, requested, this.knownSessionId)) {
      this.client.close()
      this.spawned = {
        model: requested.model !== undefined ? requested.model : this.spawned.model,
        effort: requested.effort !== undefined ? requested.effort : this.spawned.effort
      }
      this.client = this.newClient(this.knownSessionId ?? undefined)
    }
    this.currentRunId = runId
    this.interrupted = false
    this.thinkingRowActive = false
    this.turnAnnouncedId = this.knownSessionId
    if (this.yolo !== this.appliedYolo) {
      this.client.send({
        type: 'control_request',
        request_id: `mode_${++this.modeSeq}`,
        request: { subtype: 'set_permission_mode', mode: this.yolo ? 'bypassPermissions' : 'default' }
      })
      this.appliedYolo = this.yolo
    }
    this.onEvent({ type: 'run.started', runId, sessionId: this.knownSessionId ?? '' })
    this.armWatchdog(runId)
    this.client.send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
  }

  private attach(client: StreamJsonClient): void {
    client.onFrame('system', (frame) => this.handleSystem(frame))
    client.onFrame('stream_event', (frame) => this.handleStreamEvent(frame))
    client.onFrame('assistant', (frame) => this.handleAssistant(frame))
    client.onFrame('user', (frame) => this.handleToolResult(frame))
    client.onFrame('control_request', (frame) => this.handleControlRequest(frame))
    client.onFrame('control_response', () => this.touchWatchdog()) // mode acks — nothing to do
    client.onFrame('result', (frame) => this.handleResult(frame))
    client.onClose(() => {
      if (this.currentRunId) this.finishRun({ kind: 'errored', message: 'claude exited mid-turn' })
    })
  }

  private handleSystem(frame: Record<string, unknown>): void {
    this.touchWatchdog()
    if (frame.subtype === 'init') {
      const id = typeof frame.session_id === 'string' ? frame.session_id : undefined
      if (id && id !== this.turnAnnouncedId) {
        this.knownSessionId = id
        this.turnAnnouncedId = id
        if (this.currentRunId) this.onEvent({ type: 'run.started', runId: this.currentRunId, sessionId: id })
      }
      return
    }
    if (frame.subtype === 'thinking_tokens') {
      if (this.replaying || !this.currentRunId) return
      this.thinkingRowActive = true
      for (const e of mapClaudeThinking(this.currentRunId, frame)) this.onEvent(e)
    }
  }

  private handleStreamEvent(frame: Record<string, unknown>): void {
    this.touchWatchdog()
    if (this.replaying || !this.currentRunId) return
    const runId = this.currentRunId
    const ev = frame.event as { type?: string; delta?: { type?: string }; content_block?: { type?: string } } | undefined
    const isTextDelta = ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta'
    const isToolUseStart = ev?.type === 'content_block_start' && ev.content_block?.type === 'tool_use'
    if (this.thinkingRowActive && (isTextDelta || isToolUseStart)) {
      this.thinkingRowActive = false
      this.onEvent({ type: 'tool.updated', runId, toolCallId: `${THINKING_ROW_ID}${runId}`, title: 'Thinking…', kind: 'reasoning', status: 'completed' })
    }
    for (const e of mapClaudeStreamEvent(runId, frame)) this.onEvent(e)
  }

  private handleAssistant(frame: Record<string, unknown>): void {
    this.touchWatchdog()
    if (this.replaying || !this.currentRunId) return
    for (const e of mapClaudeAssistant(this.currentRunId, frame)) this.onEvent(e)
  }

  private handleToolResult(frame: Record<string, unknown>): void {
    this.touchWatchdog()
    if (this.replaying || !this.currentRunId) return
    for (const e of mapClaudeToolResult(this.currentRunId, frame)) this.onEvent(e)
  }

  private handleControlRequest(frame: Record<string, unknown>): void {
    this.touchWatchdog()
    const request = frame.request as Record<string, unknown> | undefined
    if (!request || request.subtype !== 'can_use_tool') return
    const claudeRequestId = typeof frame.request_id === 'string' ? frame.request_id : ''
    if (shouldAutoCancelPermission(this.replaying, this.currentRunId)) {
      this.sendControlResponse(claudeRequestId, { behavior: 'deny', message: 'Denied via NAC Code' })
      return
    }
    const runId = this.currentRunId! // guard above guarantees non-null
    const requestId = `apr_${++this.approvalSeq}`
    const mapping = mapClaudeCanUseTool(runId, requestId, request)
    if (!mapping) {
      this.sendControlResponse(claudeRequestId, { behavior: 'deny', message: 'Denied via NAC Code' })
      return
    }
    if (this.yolo) {
      const auto = pickAutoApprove(mapping.event.options)
      if (auto) {
        this.sendControlResponse(claudeRequestId, mapping.responses[auto.id])
        return
      }
    }
    this.onEvent(mapping.event)
    this.pendingApprovals.set(requestId, { claudeRequestId, responses: mapping.responses, denyId: 'deny' })
  }

  respondPermission(requestId: string, optionId: string): void {
    const p = this.pendingApprovals.get(requestId)
    if (!p) return
    this.pendingApprovals.delete(requestId)
    const response = p.responses[optionId] ?? p.responses[p.denyId]
    this.sendControlResponse(p.claudeRequestId, response)
    if (this.currentRunId) this.onEvent({ type: 'permission.resolved', runId: this.currentRunId, requestId, optionId })
  }

  private expireApprovals(): void {
    for (const [requestId, p] of this.pendingApprovals) {
      this.pendingApprovals.delete(requestId)
      this.sendControlResponse(p.claudeRequestId, p.responses[p.denyId])
      if (this.currentRunId) this.onEvent({ type: 'permission.resolved', runId: this.currentRunId, requestId, optionId: p.denyId })
    }
  }

  private sendControlResponse(claudeRequestId: string, response: unknown): void {
    this.client.send({ type: 'control_response', response: { subtype: 'success', request_id: claudeRequestId, response } })
  }

  private handleResult(frame: Record<string, unknown>): void {
    this.touchWatchdog()
    if (!this.currentRunId) return
    this.finishRun(mapClaudeResult(frame, this.interrupted))
  }

  private finishRun(outcome: ClaudeResultMapping): void {
    const runId = this.currentRunId
    if (!runId) return
    this.disarmWatchdog()
    this.expireApprovals() // BEFORE the terminal event unmaps the run (pillar-1 ordering)
    if (outcome.kind === 'completed') {
      if (outcome.contextUsedTokens !== undefined) {
        this.onEvent({
          type: 'usage.updated',
          runId,
          inputTokens: outcome.usage.inputTokens,
          outputTokens: outcome.usage.outputTokens,
          contextUsedTokens: outcome.contextUsedTokens
        })
      }
      this.onEvent({ type: 'run.completed', runId, stopReason: outcome.stopReason, usage: outcome.usage })
    } else {
      this.onEvent({ type: 'run.errored', runId, message: outcome.message })
    }
    this.currentRunId = null
    this.interrupted = false
    this.thinkingRowActive = false
  }

  private armWatchdog(runId: string): void {
    this.disarmWatchdog()
    this.watchdog = setTimeout(() => {
      if (this.currentRunId !== runId) return
      this.cancel()
      this.finishRun({ kind: 'errored', message: 'claude inactivity watchdog: no frame within the ceiling' })
    }, PROMPT_TIMEOUT_MS)
  }

  private disarmWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog)
    this.watchdog = null
  }

  /** Re-armed by EVERY incoming frame — the ceiling guards inactivity, not turn duration. */
  private touchWatchdog(): void {
    if (this.currentRunId) this.armWatchdog(this.currentRunId)
  }

  cancel(): void {
    this.interrupted = true
    this.client.send({ type: 'control_request', request_id: `int_${++this.interruptSeq}`, request: { subtype: 'interrupt' } })
  }

  dispose(): void {
    this.disarmWatchdog()
    this.expireApprovals()
    this.client.close()
  }
}
