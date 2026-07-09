import { JsonRpcClient } from '../capabilities/jsonRpc'
import type { AgentEvent, PermissionOption } from '../../../shared/runtime'
import { mapAcpUpdate, mapPermissionRequest } from './mapAcp'

export const PROMPT_TIMEOUT_MS = 1_800_000 // 30 min — cancellation, not timeout, is the stop lever
const HANDSHAKE_TIMEOUT_MS = 10_000

export interface TransportSession {
  prompt(runId: string, text: string): void
  respondPermission(requestId: string, optionId: string): void
  cancel(): void
  dispose(): void
}

/** Pure + exported for testing: YOLO auto-approval picks the first allow-ish option. */
export function pickAutoApprove(options: PermissionOption[]): PermissionOption | undefined {
  return options.find((o) => o.kind === 'allow' || o.kind === 'allow_always')
}

interface PendingPermission {
  resolve: (optionId: string) => void
}

export class AcpSession implements TransportSession {
  private client: JsonRpcClient
  private sessionId: string | null = null
  private currentRunId: string | null = null
  private replaying = false // suppress session/load history replay
  private permissionSeq = 0
  private pendingPermissions = new Map<string, PendingPermission>()
  private onEvent: (e: AgentEvent) => void
  private yolo: boolean

  constructor(onEvent: (e: AgentEvent) => void, yolo: boolean) {
    this.onEvent = onEvent
    this.yolo = yolo
    this.client = new JsonRpcClient('copilot', ['--acp'])
    this.client.onNotification('session/update', (params) => {
      if (this.replaying || !this.currentRunId) return
      const update = (params as { update?: unknown } | null)?.update
      for (const e of mapAcpUpdate(this.currentRunId, update)) this.onEvent(e)
    })
    this.client.onRequest('session/request_permission', (params) => this.handlePermission(params))
  }

  setYolo(y: boolean): void {
    this.yolo = y
  }

  /** Resolves the ACP handshake; throws on failure so the caller can fall back. */
  async connect(cwd: string | undefined, existingSessionId: string | undefined): Promise<string> {
    await this.client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
    }, HANDSHAKE_TIMEOUT_MS)
    if (existingSessionId) {
      try {
        this.replaying = true // session/load re-emits history as session/update — never re-append it
        await this.client.request('session/load', { sessionId: existingSessionId, cwd: cwd ?? process.cwd(), mcpServers: [] }, HANDSHAKE_TIMEOUT_MS)
        this.sessionId = existingSessionId
        return existingSessionId
      } catch {
        // fall through to a fresh session (caller seeds it with the replay prompt on the next send)
      } finally {
        this.replaying = false
      }
    }
    const res = (await this.client.request('session/new', { cwd: cwd ?? process.cwd(), mcpServers: [] }, HANDSHAKE_TIMEOUT_MS)) as { sessionId?: string }
    if (!res?.sessionId) throw new Error('acp: session/new returned no sessionId')
    this.sessionId = res.sessionId
    return res.sessionId
  }

  get loadedSessionId(): string | null {
    return this.sessionId
  }

  private handlePermission(params: unknown): Promise<unknown> {
    const runId = this.currentRunId ?? 'unknown'
    const requestId = `perm_${++this.permissionSeq}`
    const event = mapPermissionRequest(runId, requestId, params)
    if (!event) return Promise.resolve({ outcome: { outcome: 'cancelled' } }) // zero options: never hang
    if (this.yolo) {
      const auto = pickAutoApprove(event.options)
      if (auto) return Promise.resolve({ outcome: { outcome: 'selected', optionId: auto.id } })
    }
    this.onEvent(event)
    return new Promise((resolve) => {
      this.pendingPermissions.set(requestId, {
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

  prompt(runId: string, text: string): void {
    if (!this.sessionId) throw new Error('acp: no session')
    this.currentRunId = runId
    this.onEvent({ type: 'run.started', runId, sessionId: this.sessionId })
    this.client
      .request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] }, PROMPT_TIMEOUT_MS)
      .then((res) => {
        const stop = (res as { stopReason?: string } | null)?.stopReason
        this.expirePermissions() // resolve open cards BEFORE the terminal event unmaps the run (Critical 1: order matters)
        this.onEvent({ type: 'run.completed', runId, stopReason: stop === 'cancelled' ? 'canceled' : 'end_turn' })
      })
      .catch((e: Error) => {
        this.expirePermissions()
        this.onEvent({ type: 'run.errored', runId, message: e.message })
      })
      .finally(() => {
        this.currentRunId = null
      })
  }

  respondPermission(requestId: string, optionId: string): void {
    const p = this.pendingPermissions.get(requestId)
    if (!p) return
    this.pendingPermissions.delete(requestId)
    p.resolve(optionId)
  }

  private expirePermissions(): void {
    // A turn ended with cards still open (error/cancel): answer the protocol with a deny-equivalent.
    for (const [requestId, p] of this.pendingPermissions) {
      this.pendingPermissions.delete(requestId)
      p.resolve('reject_once')
    }
  }

  cancel(): void {
    if (this.sessionId) this.client.notify('session/cancel', { sessionId: this.sessionId })
  }

  dispose(): void {
    this.expirePermissions()
    this.client.close()
  }
}
