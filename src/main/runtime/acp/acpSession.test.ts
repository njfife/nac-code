import { describe, it, expect } from 'vitest'
import { homedir } from 'os'
import { pickAutoApprove, acpCwd, shouldAutoCancelPermission, shouldEmitEmptyTurnNotice, shouldRetryTextOnly, contextResourceUri, COPILOT_PROFILE, OPENCODE_PROFILE, AcpSession, type JsonRpcClientLike } from './acpSession'
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

describe('shouldRetryTextOnly', () => {
  it('never retries when resource blocks were not used', () => {
    expect(shouldRetryTextOnly(false, new Error('-32602 invalid params'))).toBe(false)
  })
  it('retries on shape/support-looking rejections', () => {
    expect(shouldRetryTextOnly(true, new Error('rpc error -32602'))).toBe(true)
    expect(shouldRetryTextOnly(true, new Error('Invalid Params'))).toBe(true)
    expect(shouldRetryTextOnly(true, new Error('invalid_request: bad shape'))).toBe(true)
    expect(shouldRetryTextOnly(true, new Error('unsupported content block'))).toBe(true)
    expect(shouldRetryTextOnly(true, new Error('embedded resource not accepted'))).toBe(true)
  })
  it('does NOT retry on an unrelated error even with resource blocks in play', () => {
    expect(shouldRetryTextOnly(true, new Error('rpc timeout'))).toBe(false)
    expect(shouldRetryTextOnly(true, new Error('ECONNRESET'))).toBe(false)
  })
})

describe('contextResourceUri', () => {
  it('encodes reserved chars (#, ?, space) in file paths that plain encodeURI leaves raw', () => {
    expect(contextResourceUri({ path: '/tmp/a#b?c.txt', name: 'x' })).toBe('file:///tmp/a%23b%3Fc.txt')
    expect(contextResourceUri({ path: '/tmp/has space.txt', name: 'x' })).toBe('file:///tmp/has%20space.txt')
  })
  it('uses the nac://context scheme (name-encoded) for path-less items', () => {
    expect(contextResourceUri({ name: 'api rules' })).toBe('nac://context/api%20rules')
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

function makeSession(profile = COPILOT_PROFILE, initResult: unknown = {}): { session: AcpSession; fake: FakeClient; events: AgentEvent[] } {
  const events: AgentEvent[] = []
  const fake = new FakeClient()
  fake.setImmediate('initialize', initResult)
  fake.setImmediate('session/new', { sessionId: 'sess_1', configOptions: [] })
  const session = new AcpSession((e) => events.push(e), false, profile, () => fake)
  return { session, fake, events }
}

const EMBEDDED_CONTEXT_INIT = { agentCapabilities: { promptCapabilities: { embeddedContext: true } } }

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

// --- Structured context threading (Task 4) --------------------------------------------------
// Probe (docs/research/opencode-acp-1.17.11.txt) confirmed opencode 1.17.11 both advertises
// agentCapabilities.promptCapabilities.embeddedContext AND accepts+recalls a `resource` prompt
// block's embedded text. These tests drive AcpSession's capability capture + block construction
// + rejection-retry entirely through the scripted FakeClient (no real harness).

describe('AcpSession — structured context (embedded resource blocks)', () => {
  it('captures supportsEmbeddedContext from initialize and sends one resource block per item + a trailing text block', async () => {
    const { session, fake } = makeSession(COPILOT_PROFILE, EMBEDDED_CONTEXT_INIT)
    await session.connect(undefined, undefined)
    fake.setImmediate('session/prompt', { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } })

    session.prompt('r1', 'hello', {
      context: {
        items: [
          { name: 'note', content: 'A' },
          { name: 'b.md', content: 'B', path: '/x/b.md' }
        ],
        removed: ['gone-thing'],
        notes: ['attached file c could not be included (missing)']
      }
    })
    await tick()

    const call = fake.calls.find((c) => c.method === 'session/prompt')
    const prompt = (call?.params as { prompt: { type: string; text?: string; resource?: { uri: string; text: string; mimeType: string } }[] }).prompt
    expect(prompt).toHaveLength(3) // 2 resource blocks + 1 trailing text block
    expect(prompt[0]).toEqual({ type: 'resource', resource: { uri: 'nac://context/note', text: 'A', mimeType: 'text/plain' } })
    expect(prompt[1]).toEqual({ type: 'resource', resource: { uri: 'file:///x/b.md', text: 'B', mimeType: 'text/plain' } })
    expect(prompt[2].type).toBe('text')
    expect(prompt[2].text).toBe(
      'The following attached context was removed — disregard it going forward: gone-thing\nattached file c could not be included (missing)\n\nhello'
    )
  })

  it('without embeddedContext support, context renders as a single text block with the rendered prefix', async () => {
    const { session, fake } = makeSession(COPILOT_PROFILE, {}) // no agentCapabilities at all
    await session.connect(undefined, undefined)
    fake.setImmediate('session/prompt', { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } })

    session.prompt('r1', 'hello', { context: { items: [{ name: 'note', content: 'A' }], removed: [] } })
    await tick()

    const call = fake.calls.find((c) => c.method === 'session/prompt')
    const prompt = (call?.params as { prompt: { type: string; text?: string }[] }).prompt
    expect(prompt).toHaveLength(1)
    expect(prompt[0].type).toBe('text')
    expect(prompt[0].text!.startsWith('Attached context')).toBe(true)
    expect(prompt[0].text!.endsWith('hello')).toBe(true)
  })

  it('rejection retry: resource-block session/prompt rejects, retries ONCE text-only, run completes', async () => {
    const { session, fake, events } = makeSession(COPILOT_PROFILE, EMBEDDED_CONTEXT_INIT)
    await session.connect(undefined, undefined)

    session.prompt('r1', 'hello', { context: { items: [{ name: 'note', content: 'A' }], removed: [] } })
    await tick()
    expect(fake.calls.map((c) => c.method)).toEqual(['initialize', 'session/new', 'session/prompt'])
    const firstPrompt = (fake.calls[2].params as { prompt: { type: string }[] }).prompt
    expect(firstPrompt.some((b) => b.type === 'resource')).toBe(true)

    fake.rejectNext(new Error('rpc error -32602'))
    await tick()

    expect(fake.calls.map((c) => c.method)).toEqual(['initialize', 'session/new', 'session/prompt', 'session/prompt'])
    const secondPrompt = (fake.calls[3].params as { prompt: { type: string; text?: string }[] }).prompt
    expect(secondPrompt).toHaveLength(1)
    expect(secondPrompt[0].type).toBe('text')
    expect(secondPrompt[0].text).toContain('hello')

    fake.resolveNext({ stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } })
    await tick()

    expect(events.at(-1)).toMatchObject({ type: 'run.completed', stopReason: 'end_turn' })
  })

  it('a non-shape error (e.g. rpc timeout) with resource blocks does NOT retry — only one session/prompt call, and it surfaces as run.errored', async () => {
    const { session, fake, events } = makeSession(COPILOT_PROFILE, EMBEDDED_CONTEXT_INIT)
    await session.connect(undefined, undefined)

    session.prompt('r1', 'hello', { context: { items: [{ name: 'note', content: 'A' }], removed: [] } })
    await tick()
    expect(fake.calls.map((c) => c.method)).toEqual(['initialize', 'session/new', 'session/prompt'])

    fake.rejectNext(new Error('rpc timeout'))
    await tick()

    // No retry: still exactly one session/prompt call.
    expect(fake.calls.filter((c) => c.method === 'session/prompt')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'run.errored', message: 'rpc timeout' })
  })

  it('cancel landing between rejection and retry bails without a second session/prompt', async () => {
    const { session, fake, events } = makeSession(COPILOT_PROFILE, EMBEDDED_CONTEXT_INIT)
    await session.connect(undefined, undefined)

    session.prompt('r1', 'hello', { context: { items: [{ name: 'note', content: 'A' }], removed: [] } })
    await tick()

    session.cancel() // lands while the first (resource-block) request is in flight
    fake.rejectNext(new Error('rpc error -32602'))
    await tick()

    // No retry was issued — the turn bails with the cancel terminal shape instead.
    expect(fake.calls.filter((c) => c.method === 'session/prompt')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', stopReason: 'canceled' })
  })
})
