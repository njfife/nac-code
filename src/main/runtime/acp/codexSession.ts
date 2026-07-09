import { JsonRpcClient } from '../capabilities/jsonRpc'
import type { AgentEvent } from '../../../shared/runtime'
import { acpCwd, pickAutoApprove, shouldAutoCancelPermission, PROMPT_TIMEOUT_MS, type TransportSession, type PromptOpts } from './acpSession'
import { codexTurnPolicy, mapCodexItem, mapCodexDelta, mapCodexApproval, mapCodexUsage, mapCodexTurnStatus } from './mapCodex'

// Codex app-server transport (pillar 2). Differs from copilot ACP in three ways the code must
// respect: (1) turn/start RESPONDS immediately (inProgress) — the turn ends on the turn/completed
// NOTIFICATION, so a watchdog guards against a lost notification; (2) approvals carry the server's
// own availableDecisions, echoed verbatim; (3) per-turn model/effort ARE honored (no copilot
// limitation), and real token usage streams via thread/tokenUsage/updated.

export const TURN_WATCHDOG_MS = PROMPT_TIMEOUT_MS
const HANDSHAKE_TIMEOUT_MS = 10_000

/** Pure + exported for testing: a stray turn/completed for a PRIOR turn must not finish the current
 *  one. Tolerates currentTurnId still being null (turn/start ack hasn't landed yet) and notifications
 *  that carry no turn id — both proceed as before this guard existed. */
export function shouldFinishOnTurnCompleted(currentTurnId: string | null, notifiedTurnId: string | null | undefined): boolean {
  if (currentTurnId === null || notifiedTurnId == null) return true
  return notifiedTurnId === currentTurnId
}

interface PendingApproval {
  resolve: (decision: unknown) => void
  decisions: Record<string, unknown>
  denyId: string
}

export class CodexSession implements TransportSession {
  private client: JsonRpcClient
  private threadId: string | null = null
  private currentRunId: string | null = null
  private currentTurnId: string | null = null
  private replaying = false // resume MAY replay history (unverified) — suppress just in case
  private approvalSeq = 0
  private pendingApprovals = new Map<string, PendingApproval>()
  private watchdog: ReturnType<typeof setTimeout> | null = null
  private turnInput = 0
  private turnOutput = 0
  private onEvent: (e: AgentEvent) => void
  private yolo: boolean
  private cwd = ''

  constructor(onEvent: (e: AgentEvent) => void, yolo: boolean) {
    this.onEvent = onEvent
    this.yolo = yolo
    this.client = new JsonRpcClient('codex', ['app-server'])

    const forRun = (fn: (runId: string) => AgentEvent[]): void => {
      if (this.replaying || !this.currentRunId) return
      for (const e of fn(this.currentRunId)) this.onEvent(e)
    }
    this.client.onNotification('item/started', (p) => forRun((r) => mapCodexItem(r, 'started', (p as { item?: unknown } | null)?.item)))
    this.client.onNotification('item/completed', (p) => forRun((r) => mapCodexItem(r, 'completed', (p as { item?: unknown } | null)?.item)))
    this.client.onNotification('item/agentMessage/delta', (p) => forRun((r) => mapCodexDelta(r, p)))
    this.client.onNotification('thread/tokenUsage/updated', (p) => {
      if (this.replaying || !this.currentRunId) return
      const m = mapCodexUsage(this.currentRunId, p)
      if (!m) return
      this.turnInput += m.stepInput
      this.turnOutput += m.stepOutput
      this.onEvent(m.event)
    })
    this.client.onNotification('turn/completed', (p) => this.onTurnCompleted(p))
    this.client.onRequest('item/commandExecution/requestApproval', (p) => this.handleApproval('item/commandExecution/requestApproval', p))
    this.client.onRequest('item/fileChange/requestApproval', (p) => this.handleApproval('item/fileChange/requestApproval', p))
    // A dead child mid-turn means no turn/completed is ever coming — without this, the run would
    // stay streaming until the watchdog ceiling and Stop would be a silent no-op.
    this.client.onClose(() => {
      if (this.currentRunId) this.finishRun({ kind: 'errored', message: 'codex app-server exited mid-turn' })
    })
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

  /** initialize → thread/resume (throws on failure: context preservation — caller falls back to
   *  one-shot `codex exec resume`) or thread/start. Returns the threadId (the chat's sessionId). */
  async connect(cwd: string | undefined, existingThreadId: string | undefined): Promise<string> {
    this.cwd = acpCwd(cwd)
    await this.client.request('initialize', { clientInfo: { name: 'nac-code', title: 'NAC Code', version: '0.1.0' } }, HANDSHAKE_TIMEOUT_MS)
    if (existingThreadId) {
      try {
        this.replaying = true // resume may replay item history (unverified) — never re-append it
        await this.client.request('thread/resume', { threadId: existingThreadId }, HANDSHAKE_TIMEOUT_MS)
        this.threadId = existingThreadId
        return existingThreadId
      } catch (e) {
        // Context-preservation doctrine (pillar 1): the caller sent a BARE message. Falling
        // through to thread/start would drop the conversation. Throw → { ok: false } → one-shot
        // `codex exec resume <id>` fallback keeps the context.
        throw e instanceof Error ? e : new Error(String(e))
      } finally {
        this.replaying = false
      }
    }
    const res = (await this.client.request('thread/start', {}, HANDSHAKE_TIMEOUT_MS)) as { thread?: { id?: string } }
    if (!res?.thread?.id) throw new Error('codex: thread/start returned no thread id')
    this.threadId = res.thread.id
    return res.thread.id
  }

  prompt(runId: string, text: string, opts?: PromptOpts): void {
    if (!this.threadId) throw new Error('codex: no thread')
    this.currentRunId = runId
    this.turnInput = 0
    this.turnOutput = 0
    this.onEvent({ type: 'run.started', runId, sessionId: this.threadId })
    this.armWatchdog(runId)
    const policy = codexTurnPolicy(this.yolo)
    this.client
      .request('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text }],
        cwd: this.cwd,
        ...policy,
        ...(opts?.model ? { model: opts.model } : {}),
        ...(opts?.effort ? { effort: opts.effort } : {})
      }, HANDSHAKE_TIMEOUT_MS)
      .then((res) => {
        this.currentTurnId = (res as { turn?: { id?: string } } | null)?.turn?.id ?? null
      })
      .catch((e: Error) => this.finishRun({ kind: 'errored', message: e.message }))
  }

  private onTurnCompleted(params: unknown): void {
    const turn = (params as { turn?: { id?: string; status?: string; error?: { message?: string } | null } } | null)?.turn
    if (!shouldFinishOnTurnCompleted(this.currentTurnId, turn?.id)) return
    this.finishRun(mapCodexTurnStatus(turn?.status, turn?.error))
  }

  private finishRun(outcome: { kind: 'completed'; stopReason: 'end_turn' | 'canceled' } | { kind: 'errored'; message: string }): void {
    const runId = this.currentRunId
    if (!runId) return
    this.disarmWatchdog()
    this.expireApprovals() // BEFORE the terminal event unmaps the run (pillar-1 ordering)
    if (outcome.kind === 'completed') {
      this.onEvent({ type: 'run.completed', runId, stopReason: outcome.stopReason, usage: { inputTokens: this.turnInput, outputTokens: this.turnOutput } })
    } else {
      this.onEvent({ type: 'run.errored', runId, message: outcome.message })
    }
    this.currentRunId = null
    this.currentTurnId = null
  }

  private armWatchdog(runId: string): void {
    this.disarmWatchdog()
    this.watchdog = setTimeout(() => {
      // A lost turn/completed must not wedge the chat forever: interrupt + error out.
      if (this.currentRunId !== runId) return
      this.cancel()
      this.finishRun({ kind: 'errored', message: 'codex turn watchdog: no turn/completed within the ceiling' })
    }, TURN_WATCHDOG_MS)
  }

  private disarmWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog)
    this.watchdog = null
  }

  private handleApproval(method: string, params: unknown): Promise<unknown> {
    if (shouldAutoCancelPermission(this.replaying, this.currentRunId)) return Promise.resolve({ decision: 'cancel' })
    const runId = this.currentRunId! // guard above guarantees non-null
    const requestId = `apr_${++this.approvalSeq}`
    const mapping = mapCodexApproval(runId, requestId, method, params)
    if (!mapping) return Promise.resolve({ decision: 'cancel' }) // junk/zero options: never hang
    if (this.yolo) {
      const auto = pickAutoApprove(mapping.event.options)
      if (auto) return Promise.resolve({ decision: mapping.decisions[auto.id] })
    }
    this.onEvent(mapping.event)
    const denyId = mapping.event.options.find((o) => o.kind === 'deny')?.id ?? mapping.event.options[mapping.event.options.length - 1].id
    return new Promise((resolve) => {
      this.pendingApprovals.set(requestId, {
        denyId,
        decisions: mapping.decisions,
        resolve: (decision) => {
          resolve({ decision })
        }
      })
    })
  }

  respondPermission(requestId: string, optionId: string): void {
    const p = this.pendingApprovals.get(requestId)
    if (!p) return
    this.pendingApprovals.delete(requestId)
    const decision = p.decisions[optionId] ?? p.decisions[p.denyId]
    if (this.currentRunId) this.onEvent({ type: 'permission.resolved', runId: this.currentRunId, requestId, optionId })
    p.resolve(decision)
  }

  private expireApprovals(): void {
    for (const [requestId, p] of this.pendingApprovals) {
      this.pendingApprovals.delete(requestId)
      if (this.currentRunId) this.onEvent({ type: 'permission.resolved', runId: this.currentRunId, requestId, optionId: p.denyId })
      p.resolve(p.decisions[p.denyId])
    }
  }

  cancel(): void {
    if (this.threadId && this.currentTurnId) {
      this.client.request('turn/interrupt', { threadId: this.threadId, turnId: this.currentTurnId }, HANDSHAKE_TIMEOUT_MS).catch(() => {})
    }
  }

  dispose(): void {
    this.disarmWatchdog()
    this.expireApprovals()
    this.client.close()
  }
}
