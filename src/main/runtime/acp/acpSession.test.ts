import { describe, it, expect } from 'vitest'
import { homedir } from 'os'
import { pickAutoApprove, acpCwd, shouldAutoCancelPermission, shouldEmitEmptyTurnNotice, COPILOT_PROFILE, OPENCODE_PROFILE, AcpSession, type JsonRpcClientLike } from './acpSession'
import type { AgentEvent } from '../../../shared/runtime'

describe('pickAutoApprove', () => {
  it('picks the first allow-kind option', () => {
    expect(pickAutoApprove([
      { id: 'reject_once', label: 'Deny', kind: 'deny' },
      { id: 'allow_once', label: 'Allow once', kind: 'allow' },
      { id: 'allow_always', label: 'Always', kind: 'allow_always' }
    ])?.id).toBe('allow_once')
  })
  it('returns undefined when no allow option exists', () => {
    expect(pickAutoApprove([{ id: 'reject_once', label: 'Deny', kind: 'deny' }])).toBeUndefined()
  })
})

describe('shouldAutoCancelPermission', () => {
  it('auto-cancels when no run is active or during session/load replay (else the JSON-RPC request deadlocks)', () => {
    expect(shouldAutoCancelPermission(false, null)).toBe(true) // no active run
    expect(shouldAutoCancelPermission(true, 'run_1')).toBe(true) // replaying loaded history
    expect(shouldAutoCancelPermission(true, null)).toBe(true)
  })
  it('surfaces the card only during a live, non-replaying run', () => {
    expect(shouldAutoCancelPermission(false, 'run_1')).toBe(false)
  })
})

describe('acpCwd', () => {
  it('expands a stored ~ workspace path to absolute (copilot session/new rejects non-absolute)', () => {
    expect(acpCwd('~/Code/nac-code')).toBe(`${homedir()}/Code/nac-code`)
    expect(acpCwd('~')).toBe(homedir())
  })
  it('passes an absolute path through and falls back to process cwd when unset', () => {
    expect(acpCwd('/abs/path')).toBe('/abs/path')
    expect(acpCwd(undefined)).toBe(process.cwd())
    expect(acpCwd('')).toBe(process.cwd())
  })
})

describe('pillar-4 profile', () => {
  it('profiles carry the exact spawn specs', () => {
    expect(COPILOT_PROFILE).toEqual({ provider: 'copilot', command: 'copilot', args: ['--acp'] })
    expect(OPENCODE_PROFILE).toEqual({ provider: 'opencode', command: 'opencode', args: ['acp'] })
  })
  it('empty-turn notice fires only for opencode, no text, zero tokens, not interrupted', () => {
    expect(shouldEmitEmptyTurnNotice('opencode', false, 0, false)).toBe(true)
    expect(shouldEmitEmptyTurnNotice('opencode', true, 0, false)).toBe(false)
    expect(shouldEmitEmptyTurnNotice('opencode', false, 5, false)).toBe(false)
    expect(shouldEmitEmptyTurnNotice('opencode', false, 0, true)).toBe(false)
    expect(shouldEmitEmptyTurnNotice('copilot', false, 0, false)).toBe(false)
  })
})

// --- Stateful AcpSession suite -------------------------------------------------------------
// A scripted JsonRpcClientLike so tests can drive requests/responses and inject session/update
// frames mid-turn without spawning a real harness process.

interface Deferred {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

class FakeClient implements JsonRpcClientLike {
  readonly calls: { method: string; params: unknown }[] = []
  readonly notifies: { method: string; params: unknown }[] = []
  closed = false
  private immediate = new Map<string, unknown>()
  private pending: Deferred[] = []
  private notificationHandlers = new Map<string, (params: unknown) => void>()
  private requestHandlers = new Map<string, (params: unknown) => Promise<unknown> | unknown>()
  private closeHandlers: Array<() => void> = []

  /** Any subsequent request() for this method auto-resolves (or rejects, if value is an Error). */
  setImmediate(method: string, value: unknown): void {
    this.immediate.set(method, value)
  }

  /** Settles the OLDEST still-pending (non-immediate) request() call, FIFO. AcpSession only ever
   *  has one request() in flight at a time (each is awaited before the next is issued), so FIFO
   *  order over calls unambiguously targets "the request currently being awaited". */
  resolveNext(value: unknown): void {
    this.pending.shift()?.resolve(value)
  }

  rejectNext(err: Error): void {
    this.pending.shift()?.reject(err)
  }

  request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params })
    if (this.immediate.has(method)) {
      const v = this.immediate.get(method)
      return v instanceof Error ? Promise.reject(v) : Promise.resolve(v)
    }
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject })
    })
  }

  notify(method: string, params?: unknown): void {
    this.notifies.push({ method, params })
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.set(method, handler)
  }

  onRequest(method: string, handler: (params: unknown) => Promise<unknown> | unknown): void {
    this.requestHandlers.set(method, handler)
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler)
  }

  get isClosed(): boolean {
    return this.closed
  }

  close(): void {
    this.closed = true
  }

  /** Simulates the harness pushing a session/update notification mid-turn. */
  emitUpdate(update: unknown): void {
    this.notificationHandlers.get('session/update')?.({ update })
  }

  /** Simulates the harness making a server-initiated request (e.g. session/request_permission)
   *  mid-turn; returns the (possibly still-pending) response promise AcpSession produced. */
  emitRequest(method: string, params: unknown): Promise<unknown> | unknown {
    return this.requestHandlers.get(method)?.(params)
  }
}

/** Flushes the microtask queue so awaited request()/notify() continuations in AcpSession settle
 *  before assertions run. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function makeSession(profile = COPILOT_PROFILE): { session: AcpSession; fake: FakeClient; events: AgentEvent[] } {
  const events: AgentEvent[] = []
  const fake = new FakeClient()
  fake.setImmediate('initialize', {})
  fake.setImmediate('session/new', { sessionId: 'sess_1', configOptions: [] })
  const session = new AcpSession((e) => events.push(e), false, profile, () => fake)
  return { session, fake, events }
}

describe('AcpSession — stateful transport suite', () => {
  it('success ordering: expire (permission.resolved) -> thinking-close -> run.completed', async () => {
    const { session, fake, events } = makeSession(COPILOT_PROFILE)
    await session.connect(undefined, undefined)
    session.prompt('r1', 'hello')

    // mid-turn: open the thinking row and raise an unresolved permission request
    fake.emitUpdate({ sessionUpdate: 'tool_call', toolCallId: 'thinking_r1', title: 'Thinking…', kind: 'reasoning', status: 'pending' })
    fake.emitRequest('session/request_permission', {
      toolCall: { title: 'Run rm -rf' },
      options: [{ optionId: 'deny_1', kind: 'reject_once', name: 'Deny' }]
    })

    fake.resolveNext({ stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 4 } })
    await tick()

    expect(events.map((e) => e.type)).toEqual([
      'run.started',
      'tool.updated', // thinking row opens
      'permission.requested',
      'permission.resolved', // expirePermissions, BEFORE the thinking-row close
      'tool.updated', // closeThinkingRow
      'run.completed'
    ])
    const [, , , expireEvt, closeEvt, terminal] = events
    expect(expireEvt).toMatchObject({ type: 'permission.resolved', optionId: 'deny_1' })
    expect(closeEvt).toMatchObject({ type: 'tool.updated', toolCallId: 'thinking_r1', status: 'completed' })
    expect(terminal).toMatchObject({ type: 'run.completed', stopReason: 'end_turn' })
  })

  it('interrupted maps ANY harness stopReason to canceled', async () => {
    const { session, fake, events } = makeSession(COPILOT_PROFILE)
    await session.connect(undefined, undefined)
    session.prompt('r1', 'hello')

    session.cancel()
    fake.resolveNext({ stopReason: 'refusal', usage: { inputTokens: 1, outputTokens: 1 } })
    await tick()

    const terminal = events.at(-1)
    expect(terminal).toMatchObject({ type: 'run.completed', stopReason: 'canceled' })
    expect(fake.notifies).toContainEqual({ method: 'session/cancel', params: { sessionId: 'sess_1' } })
  })

  it('fail-open: set_config_option rejects, session/prompt STILL sent, run.completed carries modelMismatch: true', async () => {
    const { session, fake, events } = makeSession(OPENCODE_PROFILE)
    await session.connect(undefined, undefined)
    fake.setImmediate('session/set_config_option', new Error('model not available'))
    fake.setImmediate('session/prompt', { stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 5 } })

    session.prompt('r1', 'hello', { model: 'lmstudio/qwen/qwen3-coder-30b' })
    await tick()

    expect(fake.calls.map((c) => c.method)).toContain('session/prompt')
    const terminal = events.at(-1)
    expect(terminal).toMatchObject({ type: 'run.completed', stopReason: 'end_turn', modelMismatch: true })
  })

  it('cancel-during-config-await: NO session/prompt is ever sent; run.completed is canceled', async () => {
    const { session, fake, events } = makeSession(OPENCODE_PROFILE)
    await session.connect(undefined, undefined)

    session.prompt('r1', 'hello', { model: 'lmstudio/qwen/qwen3-coder-30b' })
    await tick() // let the set_config_option request() call land in fake.pending
    expect(fake.calls.map((c) => c.method)).toEqual(['initialize', 'session/new', 'session/set_config_option'])

    session.cancel() // interrupted = true WHILE set_config_option is still pending
    fake.rejectNext(new Error('model not available')) // let the awaited config call settle
    await tick()

    expect(fake.calls.map((c) => c.method)).toEqual(['initialize', 'session/new', 'session/set_config_option']) // session/prompt NEVER issued
    const terminal = events.at(-1)
    expect(terminal).toMatchObject({ type: 'run.completed', stopReason: 'canceled' })
  })

  it('per-turn state resets: a mismatched turn does not leak modelMismatch into the next prompt', async () => {
    const { session, fake, events } = makeSession(OPENCODE_PROFILE)
    await session.connect(undefined, undefined)

    // turn 1: fail-open mismatch
    fake.setImmediate('session/set_config_option', new Error('model not available'))
    fake.setImmediate('session/prompt', { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } })
    session.prompt('r1', 'first', { model: 'lmstudio/qwen/qwen3-coder-30b' })
    await tick()
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', modelMismatch: true })

    // turn 2: no model option this time — config path is skipped entirely, flag must be clean
    session.prompt('r2', 'second')
    await tick()
    const secondTerminal = events.at(-1) as Extract<AgentEvent, { type: 'run.completed' }>
    expect(secondTerminal).toMatchObject({ type: 'run.completed', stopReason: 'end_turn' })
    expect(secondTerminal.modelMismatch).toBeUndefined()
  })

  it('copilot profile: run.completed usage carries costUsd once a usage_update frame has flowed', async () => {
    const { session, fake, events } = makeSession(COPILOT_PROFILE)
    await session.connect(undefined, undefined)
    session.prompt('r1', 'hello')

    fake.emitUpdate({ sessionUpdate: 'usage_update', cost: { amount: 0.0123 } })
    fake.resolveNext({ stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 7 } })
    await tick()

    const terminal = events.at(-1) as Extract<AgentEvent, { type: 'run.completed' }>
    expect(terminal.usage).toMatchObject({ inputTokens: 5, outputTokens: 7, costUsd: 0.0123 })
  })
})
