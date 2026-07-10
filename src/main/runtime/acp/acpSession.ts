import { JsonRpcClient } from '../capabilities/jsonRpc'
import type { AgentEvent, PermissionOption } from '../../../shared/runtime'
import { mapAcpUpdate, mapPermissionRequest, usageUpdateCost, THINKING_ROW_PREFIX } from './mapAcp'
import { resolveCwd } from '../paths'
import { renderContextText, type ContextPayload } from '../../../shared/contextRender'

export const PROMPT_TIMEOUT_MS = 1_800_000 // 30 min — cancellation, not timeout, is the stop lever
const HANDSHAKE_TIMEOUT_MS = 10_000

export interface PromptOpts {
  model?: string
  effort?: string
  context?: ContextPayload
}

export interface AcpProfile {
  provider: 'copilot' | 'opencode'
  command: string
  args: string[]
}

export const COPILOT_PROFILE: AcpProfile = { provider: 'copilot', command: 'copilot', args: ['--acp'] }
export const OPENCODE_PROFILE: AcpProfile = { provider: 'opencode', command: 'opencode', args: ['acp'] }

/** Pure + exported for testing: the "model returned nothing" notice is opencode-only — it fires when
 *  a turn produced no assistant text and zero output tokens and wasn't a user-initiated cancel (a
 *  local model that silently no-ops looks identical to a cancel otherwise). */
export function shouldEmitEmptyTurnNotice(provider: 'copilot' | 'opencode', hadText: boolean, outputTokens: number, interrupted: boolean): boolean {
  return provider === 'opencode' && !hadText && outputTokens === 0 && !interrupted
}

export interface TransportSession {
  readonly busy: boolean
  readonly dead: boolean
  setYolo(y: boolean): void
  prompt(runId: string, text: string, opts?: PromptOpts): void
  respondPermission(requestId: string, optionId: string): void
  cancel(): void
  dispose(): void
}

/** Pure + exported for testing: YOLO auto-approval picks the first allow-ish option. */
export function pickAutoApprove(options: PermissionOption[]): PermissionOption | undefined {
  return options.find((o) => o.kind === 'allow' || o.kind === 'allow_always')
}

/** Pure + exported for testing: a permission request must be auto-cancelled (never queued as a card)
 *  when no run is active or during session/load history replay — otherwise the pending permission
 *  can never be resolved and the JSON-RPC request deadlocks the harness. */
export function shouldAutoCancelPermission(replaying: boolean, currentRunId: string | null): boolean {
  return replaying || !currentRunId
}

/** Pure + exported for testing: ACP session cwd. copilot's session/new rejects a non-absolute path
 *  (`-32603 "Directory path must be absolute"`), so a stored `~/…` workspace path MUST be expanded —
 *  the same resolveCwd every one-shot adapter uses. Falls back to process cwd when unset. */
export function acpCwd(cwd: string | undefined): string {
  return resolveCwd(cwd) ?? process.cwd()
}

interface PendingPermission {
  resolve: (optionId: string) => void
  denyId: string
}

/** Extracted surface AcpSession actually uses from JsonRpcClient — lets tests inject a FakeClient
 *  (scripted responses + capturable notification/request handlers) instead of spawning a real
 *  harness process. The default clientFactory below preserves today's real spawn. */
export interface JsonRpcClientLike {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>
  notify(method: string, params?: unknown): void
  onNotification(method: string, handler: (params: unknown) => void): void
  onRequest(method: string, handler: (params: unknown) => Promise<unknown> | unknown): void
  onClose(handler: () => void): void
  readonly isClosed: boolean
  close(): void
}

export class AcpSession implements TransportSession {
  private client: JsonRpcClientLike
  private sessionId: string | null = null
  private currentRunId: string | null = null
  private replaying = false // suppress session/load history replay
  private permissionSeq = 0
  private pendingPermissions = new Map<string, PendingPermission>()
  private onEvent: (e: AgentEvent) => void
  private yolo: boolean
  private profile: AcpProfile
  private turnHadText = false
  private turnCost: number | null = null
  private thinkingOpen = false
  private interrupted = false
  private appliedModel: string | null = null
  private modelMismatchThisTurn = false
  // Discovered from initialize's agentCapabilities — gates whether runTurn sends structured
  // `resource` prompt blocks or falls back to a single rendered-text block (M0-8 Part C).
  private supportsEmbeddedContext = false

  constructor(
    onEvent: (e: AgentEvent) => void,
    yolo: boolean,
    profile: AcpProfile = COPILOT_PROFILE,
    clientFactory: () => JsonRpcClientLike = () => new JsonRpcClient(profile.command, profile.args)
  ) {
    this.onEvent = onEvent
    this.yolo = yolo
    this.profile = profile
    this.client = clientFactory()
    this.client.onNotification('session/update', (params) => {
      if (this.replaying || !this.currentRunId) return
      const update = (params as { update?: unknown } | null)?.update
      const cost = usageUpdateCost(update)
      if (cost !== null) this.turnCost = cost
      for (const e of mapAcpUpdate(this.currentRunId, update, this.profile.provider)) {
        if (e.type === 'content.delta') {
          this.turnHadText = true
          this.closeThinkingRow()
        } else if (e.type === 'tool.updated' && e.toolCallId.startsWith(THINKING_ROW_PREFIX)) {
          this.thinkingOpen = true
        } else if (e.type === 'tool.updated') {
          this.closeThinkingRow()
        }
        this.onEvent(e)
      }
    })
    this.client.onRequest('session/request_permission', (params) => this.handlePermission(params))
  }

  private closeThinkingRow(): void {
    if (!this.thinkingOpen || !this.currentRunId) return
    this.thinkingOpen = false
    this.onEvent({ type: 'tool.updated', runId: this.currentRunId, toolCallId: `${THINKING_ROW_PREFIX}${this.currentRunId}`, title: 'Thinking…', kind: 'reasoning', status: 'completed' })
  }

  setYolo(y: boolean): void {
    this.yolo = y
  }

  /** Resolves the ACP handshake; throws on failure so the caller can fall back. */
  async connect(cwd: string | undefined, existingSessionId: string | undefined): Promise<string> {
    const init = await this.client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
    }, HANDSHAKE_TIMEOUT_MS)
    this.supportsEmbeddedContext = Boolean(
      (init as { agentCapabilities?: { promptCapabilities?: { embeddedContext?: boolean } } } | null)?.agentCapabilities?.promptCapabilities?.embeddedContext
    )
    if (existingSessionId) {
      try {
        this.replaying = true // session/load re-emits history as session/update — never re-append it
        const res = (await this.client.request('session/load', { sessionId: existingSessionId, cwd: acpCwd(cwd), mcpServers: [] }, HANDSHAKE_TIMEOUT_MS)) as { configOptions?: { id?: string; currentValue?: unknown }[] } | null
        this.seedAppliedModel(res?.configOptions)
        this.sessionId = existingSessionId
        return existingSessionId
      } catch (e) {
        // Re-throw: the caller sent a BARE message (renderer chose native continuity, no replay
        // text seeded). Falling through to session/new here would silently start an empty
        // session and drop the conversation — a hard context-preservation violation. Rejecting
        // connect() instead makes promptViaTransport resolve { ok: false }, so ipc.ts falls back to the
        // one-shot startCopilotRun(sessionId) path, which uses --resume to preserve context.
        throw e instanceof Error ? e : new Error(String(e))
      } finally {
        this.replaying = false
      }
    }
    const res = (await this.client.request('session/new', { cwd: acpCwd(cwd), mcpServers: [] }, HANDSHAKE_TIMEOUT_MS)) as { sessionId?: string; configOptions?: { id?: string; currentValue?: unknown }[] }
    if (!res?.sessionId) throw new Error('acp: session/new returned no sessionId')
    this.sessionId = res.sessionId
    this.seedAppliedModel(res.configOptions)
    return res.sessionId
  }

  private seedAppliedModel(configOptions: { id?: string; currentValue?: unknown }[] | undefined): void {
    const model = configOptions?.find((o) => o.id === 'model')?.currentValue
    if (typeof model === 'string') this.appliedModel = model
  }

  get loadedSessionId(): string | null {
    return this.sessionId
  }

  private handlePermission(params: unknown): Promise<unknown> {
    // No active run, or session/load history replay: there is no UI turn to surface a card on, so a
    // pending permission stored here could never be resolved and would deadlock the JSON-RPC request
    // (blocking the harness). Auto-cancel instead. Mirrors the session/update notification guard above.
    if (shouldAutoCancelPermission(this.replaying, this.currentRunId)) return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    const runId = this.currentRunId! // guard above guarantees non-null
    const requestId = `perm_${++this.permissionSeq}`
    const event = mapPermissionRequest(runId, requestId, params)
    if (!event) return Promise.resolve({ outcome: { outcome: 'cancelled' } }) // zero options: never hang
    if (this.yolo) {
      const auto = pickAutoApprove(event.options)
      if (auto) return Promise.resolve({ outcome: { outcome: 'selected', optionId: auto.id } })
    }
    this.onEvent(event)
    const denyId = event.options.find((o) => o.kind === 'deny')?.id ?? event.options[event.options.length - 1].id
    return new Promise((resolve) => {
      this.pendingPermissions.set(requestId, {
        denyId,
        resolve: (optionId) => {
          this.onEvent({ type: 'permission.resolved', runId, requestId, optionId })
          resolve({ outcome: { outcome: 'selected', optionId } })
        }
      })
    })
  }

  /** True while a turn is in flight — the idle reaper must never dispose a busy session. */
  get busy(): boolean {
    return this.currentRunId !== null
  }

  prompt(runId: string, text: string, opts?: PromptOpts): void {
    if (!this.sessionId) throw new Error('acp: no session')
    this.currentRunId = runId
    this.turnHadText = false
    this.turnCost = null
    this.thinkingOpen = false
    this.interrupted = false
    this.modelMismatchThisTurn = false
    this.onEvent({ type: 'run.started', runId, sessionId: this.sessionId })
    void this.runTurn(runId, text, opts)
  }

  /** One `resource` block per attached context item (embeds its content directly, per the
   *  Task 4 probe: opencode 1.17.11 accepts this and the model recalls the embedded text), plus a
   *  trailing `text` block carrying the removal/refusal notes (if any) followed by the user's text. */
  private buildResourceBlocks(context: ContextPayload, text: string): unknown[] {
    const blocks: unknown[] = []
    for (const it of context.items) {
      blocks.push({
        type: 'resource',
        resource: {
          uri: it.path ? `file://${it.path}` : `nac://context/${encodeURIComponent(it.name)}`,
          text: it.content,
          mimeType: 'text/plain'
        }
      })
    }
    const preamble = [
      context.removed.length ? `The following attached context was removed — disregard it going forward: ${context.removed.join(', ')}` : '',
      ...(context.notes ?? [])
    ]
      .filter(Boolean)
      .join('\n')
    blocks.push({ type: 'text', text: preamble ? `${preamble}\n\n${text}` : text })
    return blocks
  }

  private async runTurn(runId: string, text: string, opts?: PromptOpts): Promise<void> {
    try {
      if (this.profile.provider === 'opencode' && opts?.model && opts.model !== this.appliedModel) {
        try {
          await this.client.request('session/set_config_option', { sessionId: this.sessionId, configId: 'model', value: opts.model }, HANDSHAKE_TIMEOUT_MS)
          this.appliedModel = opts.model
        } catch {
          // fail-open: the harness keeps its current model; the ledger records real outcomes
          this.modelMismatchThisTurn = true
        }
      }
      if (this.interrupted) {
        // Cancelled while the config-option request was in flight: never issue session/prompt —
        // the harness would run a turn nothing is waiting for. Bail with the same terminal shape
        // a mid-turn cancel produces.
        this.expirePermissions()
        this.closeThinkingRow()
        this.onEvent({ type: 'run.completed', runId, stopReason: 'canceled' })
        return
      }
      const rendered = opts?.context ? renderContextText(opts.context) : ''
      const usedResourceBlocks = Boolean(opts?.context && this.supportsEmbeddedContext)
      const blocks: unknown[] = usedResourceBlocks
        ? this.buildResourceBlocks(opts!.context!, text)
        : [{ type: 'text', text: rendered + text }]
      let res: unknown
      try {
        res = await this.client.request('session/prompt', { sessionId: this.sessionId, prompt: blocks }, PROMPT_TIMEOUT_MS)
      } catch (e) {
        // Structured resource blocks may be rejected by an agent that lied about (or partially
        // supports) embeddedContext — retry ONCE, text-only, before giving up on the turn entirely.
        if (!usedResourceBlocks) throw e
        res = await this.client.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text: rendered + text }] }, PROMPT_TIMEOUT_MS)
      }
      const stop = (res as { stopReason?: string } | null)?.stopReason
      const u = (res as { usage?: { inputTokens?: number; outputTokens?: number } } | null)?.usage
      this.expirePermissions() // resolve open cards BEFORE the terminal event unmaps the run (Critical 1: order matters)
      this.closeThinkingRow()
      const outputTokens = typeof u?.outputTokens === 'number' ? u.outputTokens : 0
      if (shouldEmitEmptyTurnNotice(this.profile.provider, this.turnHadText, outputTokens, this.interrupted)) {
        this.onEvent({ type: 'tool.updated', runId, toolCallId: `empty_${runId}`, title: 'model returned nothing — is the local model loaded?', kind: 'notice', status: 'failed' })
      }
      const usage = { inputTokens: typeof u?.inputTokens === 'number' ? u.inputTokens : 0, outputTokens, ...(this.turnCost !== null ? { costUsd: this.turnCost } : {}) }
      this.onEvent({
        type: 'run.completed',
        runId,
        stopReason: this.interrupted || stop === 'cancelled' ? 'canceled' : 'end_turn',
        usage,
        ...(this.modelMismatchThisTurn ? { modelMismatch: true } : {})
      })
    } catch (e) {
      this.expirePermissions()
      this.closeThinkingRow()
      this.onEvent({ type: 'run.errored', runId, message: (e as Error).message })
    } finally {
      this.currentRunId = null
    }
  }

  respondPermission(requestId: string, optionId: string): void {
    const p = this.pendingPermissions.get(requestId)
    if (!p) return
    this.pendingPermissions.delete(requestId)
    p.resolve(optionId)
  }

  private expirePermissions(): void {
    // A turn ended with cards still open (error/cancel): answer the protocol with a deny-equivalent
    // — the actual deny option id offered for that request, not a hardcoded guess.
    for (const [requestId, p] of this.pendingPermissions) {
      this.pendingPermissions.delete(requestId)
      p.resolve(p.denyId)
    }
  }

  /** True once the underlying ACP child process has exited — the session can no longer be used. */
  get dead(): boolean {
    return this.client.isClosed
  }

  cancel(): void {
    this.interrupted = true
    if (this.sessionId) this.client.notify('session/cancel', { sessionId: this.sessionId })
  }

  dispose(): void {
    this.expirePermissions()
    this.client.close()
  }
}
