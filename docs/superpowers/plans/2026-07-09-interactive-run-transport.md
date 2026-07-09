# Interactive Run Transport — Pillar 1 (Copilot ACP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Copilot runs become interactive — a persistent `copilot --acp` session per chat with inline permission cards, live tool rows, and real cancellation — behind a provider-generic transport seam, falling back to today's headless path on any ACP failure.

**Architecture:** The M4 `JsonRpcClient` gains server-request/notification handling; a pure `mapAcpUpdate` converts captured-verified ACP frames into three new canonical `AgentEvent` members; `AcpSession`/`SessionManager` (main process) own the child lifecycle (spawn → initialize → session/new|load, prompt, permission responses, cancel, idle disposal); the renderer stores tool rows and permission cards on the streaming `Turn` (render-only — never in replay) and renders them as expandable rows and inline cards.

**Tech Stack:** Electron + React + TS, Zustand, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-09-interactive-run-transport-design.md`. All protocol shapes below are live-captured (see `docs/research/acp-prompt-frames-copilot-1.0.69.txt`).

## Global Constraints

- Wrapper, never a harness; renderer reaches main only via the typed preload bridge.
- Pure/exported/tested logic; `npm run typecheck` + `npx vitest run` green before every commit (baseline: 18 files / 95 tests).
- **Replay invariant:** `buildReplayPrompt` reads only `turn.text` — tools/permissions never enter replay.
- **Fallback floor:** any ACP spawn/initialize/session failure → this send runs through the existing one-shot `startCopilotRun` path; the app is never worse than the current release.
- Verified frames: tool announce `session/update {sessionUpdate:'tool_call', toolCallId, title, kind, status:'pending', rawInput:{command,…}}`; progress/finish `tool_call_update` with `content[]` and finally `status:'completed'` + `rawOutput`; text `agent_message_chunk`; permission = server REQUEST `session/request_permission {toolCall, options:[{optionId,kind,name}]}` answered with `{outcome:{outcome:'selected', optionId}}`; prompt response `{stopReason:'end_turn'}`.
- `session/prompt` timeout = 1_800_000 ms (30 min); cancellation is the stop lever, not timeouts.
- Never restore live-looking state from disk: hydrated `pending/running` tools → `failed`; unresolved permission cards → `resolvedOptionId: 'stale'`.
- Electron `app` imports must stay out of every test's module-scope import graph (ledgerStore precedent).

---

### Task 1: JsonRpcClient — server requests, notifications, outbound notify

**Files:**
- Modify: `src/main/runtime/capabilities/jsonRpc.ts`
- Test: `src/main/runtime/capabilities/jsonRpc.test.ts` (additive)

**Interfaces:**
- Consumes: existing `JsonRpcClient`, `parseRpcLine`, `LineDecoder` (unchanged behavior for M4 discovery callers).
- Produces: `onNotification(method: string, handler: (params: unknown) => void): void`; `onRequest(method: string, handler: (params: unknown) => Promise<unknown> | unknown): void` (resolved value is written back as the JSON-RPC response; a throw/rejection responds with a JSON-RPC error); `notify(method: string, params?: unknown): void` (fire-and-forget client notification — needed for `session/cancel`); pure `classifyRpcMessage(m: RpcMessage): 'response' | 'server-request' | 'notification'`.

- [ ] **Step 1: Write the failing tests** — append to `jsonRpc.test.ts`:

```ts
import { classifyRpcMessage } from './jsonRpc'

describe('classifyRpcMessage', () => {
  it('separates responses, server requests, and notifications', () => {
    expect(classifyRpcMessage({ id: 3, result: { stopReason: 'end_turn' } })).toBe('response')
    // Real captured frame: copilot's permission request arrived with id 0 — a server REQUEST has method+id.
    expect(classifyRpcMessage({ id: 0, method: 'session/request_permission' })).toBe('server-request')
    expect(classifyRpcMessage({ method: 'session/update' })).toBe('notification')
    expect(classifyRpcMessage({ id: 1, error: { code: -32601 } })).toBe('response')
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/main/runtime/capabilities/jsonRpc.test.ts` → FAIL (no export).

- [ ] **Step 3: Implement.** In `jsonRpc.ts`:

Add after `parseRpcLine`:
```ts
/** Pure + exported for testing: incoming message kind. A server-initiated message carries `method`;
 *  with an id it's a request we must answer, without one a notification. Anything else is a response. */
export function classifyRpcMessage(m: RpcMessage): 'response' | 'server-request' | 'notification' {
  if (m.method !== undefined) return m.id !== undefined ? 'server-request' : 'notification'
  return 'response'
}
```

`RpcMessage` gains `params?: unknown`. Inside `JsonRpcClient`, add fields:
```ts
  private notificationHandlers = new Map<string, (params: unknown) => void>()
  private requestHandlers = new Map<string, (params: unknown) => Promise<unknown> | unknown>()
```
Replace the stdout line-loop body with:
```ts
      for (const line of this.lines.push(chunk)) {
        const msg = parseRpcLine(line)
        if (!msg) continue
        const kind = classifyRpcMessage(msg)
        if (kind === 'response' && msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!
          this.pending.delete(msg.id)
          if (msg.error) p.reject(new Error(msg.error.message ?? `rpc error ${msg.error.code}`))
          else p.resolve(msg.result)
        } else if (kind === 'server-request') {
          this.answer(msg)
        } else if (kind === 'notification') {
          this.notificationHandlers.get(msg.method!)?.(msg.params)
        }
      }
```
Add methods:
```ts
  private answer(msg: RpcMessage): void {
    const handler = this.requestHandlers.get(msg.method!)
    const write = (body: object): void => {
      this.child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...body }) + '\n')
    }
    if (!handler) {
      write({ error: { code: -32601, message: `unhandled: ${msg.method}` } })
      return
    }
    Promise.resolve()
      .then(() => handler(msg.params))
      .then((result) => write({ result }))
      .catch((e: Error) => write({ error: { code: -32000, message: e.message ?? 'handler error' } }))
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.set(method, handler)
  }

  onRequest(method: string, handler: (params: unknown) => Promise<unknown> | unknown): void {
    this.requestHandlers.set(method, handler)
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} }) + '\n')
  }
```
Update the stale comment (`// notifications … are ignored`) accordingly.

- [ ] **Step 4: Run to verify pass**, then full gate `npm run typecheck && npx vitest run`.

- [ ] **Step 5: Commit**
```bash
git add src/main/runtime/capabilities/jsonRpc.ts src/main/runtime/capabilities/jsonRpc.test.ts
git commit -m "feat(rpc): server-request answering, notification subscription, outbound notify"
```

---

### Task 2: Canonical events + pure ACP mappers

**Files:**
- Modify: `src/shared/runtime.ts` (AgentEvent members + RUN_CHANNELS.respondPermission)
- Create: `src/main/runtime/acp/mapAcp.ts`
- Test: `src/main/runtime/acp/mapAcp.test.ts`

**Interfaces:**
- Produces (later tasks rely on): AgentEvent gains
  `{ type: 'tool.updated'; runId; toolCallId; title; kind?; status: 'pending'|'running'|'completed'|'failed'; detail?: string }`,
  `{ type: 'permission.requested'; runId; requestId; title; detail?; options: { id: string; label: string; kind: 'allow'|'allow_always'|'deny' }[] }`,
  `{ type: 'permission.resolved'; runId; requestId; optionId: string }`;
  `RUN_CHANNELS.respondPermission = 'run:respondPermission'`;
  pure `mapAcpUpdate(runId: string, update: unknown): AgentEvent[]` and
  `mapPermissionRequest(runId: string, requestId: string, params: unknown): Extract<AgentEvent, {type:'permission.requested'}> | null`.

- [ ] **Step 1: Write the failing tests** — `mapAcp.test.ts`, fixtures are the captured frames verbatim:

```ts
import { describe, it, expect } from 'vitest'
import { mapAcpUpdate, mapPermissionRequest } from './mapAcp'

const TOOL_CALL = { sessionUpdate: 'tool_call', toolCallId: 'call_MHx', title: 'Run echo nac-probe-ok', kind: 'execute', status: 'pending', rawInput: { command: 'echo nac-probe-ok', description: 'Run echo nac-probe-ok', mode: 'sync' } }
const TOOL_DONE = { sessionUpdate: 'tool_call_update', toolCallId: 'call_MHx', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'nac-probe-ok\n<shellId: 0 completed with exit code 0>' } }], rawOutput: { content: 'nac-probe-ok\n<shellId: 0 completed with exit code 0>' } }
const CHUNK = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'It printed ' } }
const PERM = { sessionId: 's1', toolCall: { toolCallId: 'call_MHx', title: 'Run echo nac-probe-ok', kind: 'execute', status: 'pending', rawInput: { command: 'echo nac-probe-ok' } }, options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' }, { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' }] }

describe('mapAcpUpdate', () => {
  it('maps tool_call to a pending tool.updated carrying the command as detail', () => {
    expect(mapAcpUpdate('r', TOOL_CALL)).toEqual([{ type: 'tool.updated', runId: 'r', toolCallId: 'call_MHx', title: 'Run echo nac-probe-ok', kind: 'execute', status: 'pending', detail: 'echo nac-probe-ok' }])
  })
  it('maps a completed tool_call_update carrying output text as detail', () => {
    const [e] = mapAcpUpdate('r', TOOL_DONE)
    expect(e).toMatchObject({ type: 'tool.updated', toolCallId: 'call_MHx', status: 'completed' })
    expect((e as { detail?: string }).detail).toContain('nac-probe-ok')
  })
  it('maps agent_message_chunk to content.delta and ignores unknown/junk updates', () => {
    expect(mapAcpUpdate('r', CHUNK)).toEqual([{ type: 'content.delta', runId: 'r', streamKind: 'assistant_text', text: 'It printed ' }])
    expect(mapAcpUpdate('r', { sessionUpdate: 'plan' })).toEqual([])
    expect(mapAcpUpdate('r', null)).toEqual([])
  })
  it('preserves a tool_call_update without status as a running upsert', () => {
    const [e] = mapAcpUpdate('r', { sessionUpdate: 'tool_call_update', toolCallId: 'call_MHx', content: [{ type: 'content', content: { type: 'text', text: 'partial' } }] })
    expect(e).toMatchObject({ type: 'tool.updated', status: 'running', detail: 'partial' })
  })
})

describe('mapPermissionRequest', () => {
  it('maps the captured request with normalized option kinds', () => {
    const e = mapPermissionRequest('r', 'req1', PERM)
    expect(e).toEqual({
      type: 'permission.requested', runId: 'r', requestId: 'req1', title: 'Run echo nac-probe-ok',
      detail: 'echo nac-probe-ok',
      options: [
        { id: 'allow_once', label: 'Allow once', kind: 'allow' },
        { id: 'allow_always', label: 'Always allow', kind: 'allow_always' },
        { id: 'reject_once', label: 'Deny', kind: 'deny' }
      ]
    })
  })
  it('returns null for junk', () => {
    expect(mapPermissionRequest('r', 'x', null)).toBeNull()
    expect(mapPermissionRequest('r', 'x', { options: [] })).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Shared types.** In `src/shared/runtime.ts`: add to `RUN_CHANNELS`: `respondPermission: 'run:respondPermission'`. Extend `AgentEvent`:
```ts
  | { type: 'tool.updated'; runId: string; toolCallId: string; title: string; kind?: string; status: 'pending' | 'running' | 'completed' | 'failed'; detail?: string }
  | { type: 'permission.requested'; runId: string; requestId: string; title: string; detail?: string; options: PermissionOption[] }
  | { type: 'permission.resolved'; runId: string; requestId: string; optionId: string }
```
with
```ts
export interface PermissionOption {
  id: string
  label: string
  kind: 'allow' | 'allow_always' | 'deny'
}
```

- [ ] **Step 4: Implement `mapAcp.ts`:**
```ts
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
  rawOutput?: { content?: string }
  content?: AcpContentEntry[] | { text?: string }
}

const TOOL_STATUSES = new Set(['pending', 'running', 'completed', 'failed'])

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
      const detail = u.rawOutput?.content ?? contentText(u) ?? u.rawInput?.command
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
  return {
    type: 'permission.requested', runId, requestId,
    title: p.toolCall?.title ?? 'Permission request',
    ...(p.toolCall?.rawInput?.command ? { detail: p.toolCall.rawInput.command } : {}),
    options
  }
}
```
Note the tool_call_update WITHOUT an explicit status maps to `'running'` (partial output frames), and `tool_call` without status maps to `'pending'` — the reducer upserts, so the last frame's `completed`/`failed` wins.

- [ ] **Step 5: Run to verify pass**, then full gate.

- [ ] **Step 6: Commit**
```bash
git add src/shared/runtime.ts src/main/runtime/acp/
git commit -m "feat(events): tool/permission canonical events + pure ACP mappers from captured frames"
```

---

### Task 3: AcpSession + SessionManager

**Files:**
- Create: `src/main/runtime/acp/acpSession.ts`, `src/main/runtime/acp/sessionManager.ts`
- Test: `src/main/runtime/acp/acpSession.test.ts` (pure helpers only — lifecycle is live-verified in Task 6)

**Interfaces:**
- Consumes: `JsonRpcClient` (+`onRequest`/`onNotification`/`notify`, Task 1), `mapAcpUpdate`/`mapPermissionRequest` (Task 2).
- Produces:
```ts
export interface TransportSession {
  prompt(runId: string, text: string): void
  respondPermission(requestId: string, optionId: string): void
  cancel(): void
  dispose(): void
}
// sessionManager.ts
export function promptViaAcp(opts: { chatId: string; runId: string; prompt: string; cwd?: string; yolo?: boolean; sessionId?: string; onEvent: (e: AgentEvent) => void }): Promise<{ ok: boolean }>
export function respondPermission(runId: string, requestId: string, optionId: string): void
export function cancelRun(runId: string): boolean   // true = handled by a live session
export function disposeAll(): void                   // app quit
```
Pure helpers (exported, tested): `pickAutoApprove(options: PermissionOption[]): PermissionOption | undefined` (first `allow`/`allow_always`); `IDLE_MS = 15 * 60_000`; `PROMPT_TIMEOUT_MS = 1_800_000`.

- [ ] **Step 1: Write the failing tests** — `acpSession.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { pickAutoApprove } from './acpSession'

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
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement `acpSession.ts`:**
```ts
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
        this.onEvent({ type: 'run.completed', runId, stopReason: stop === 'cancelled' ? 'canceled' : 'end_turn' })
      })
      .catch((e: Error) => this.onEvent({ type: 'run.errored', runId, message: e.message }))
      .finally(() => {
        this.currentRunId = null
        this.expirePermissions()
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
```

- [ ] **Step 4: Implement `sessionManager.ts`:**
```ts
import type { AgentEvent } from '../../../shared/runtime'
import { AcpSession } from './acpSession'

// One live ACP session per chat. Sessions die on provider switch (a new prompt for the same chat
// with a different transport never reaches here), app quit, or idle timeout.

export const IDLE_MS = 15 * 60_000

interface Entry {
  session: AcpSession
  idleTimer: ReturnType<typeof setTimeout> | null
}

const byChat = new Map<string, Entry>()
const runToChat = new Map<string, string>()

function touch(chatId: string): void {
  const e = byChat.get(chatId)
  if (!e) return
  if (e.idleTimer) clearTimeout(e.idleTimer)
  e.idleTimer = setTimeout(() => disposeChat(chatId), IDLE_MS)
}

function disposeChat(chatId: string): void {
  const e = byChat.get(chatId)
  if (!e) return
  if (e.session.busy) {
    // A turn can run up to 30 min (PROMPT_TIMEOUT_MS) — re-arm instead of killing mid-turn.
    touch(chatId)
    return
  }
  byChat.delete(chatId)
  if (e.idleTimer) clearTimeout(e.idleTimer)
  e.session.dispose()
}

/** Try the interactive path. Resolves { ok: false } when ACP is unavailable — caller falls back. */
export async function promptViaAcp(opts: {
  chatId: string
  runId: string
  prompt: string
  cwd?: string
  yolo?: boolean
  sessionId?: string
  onEvent: (e: AgentEvent) => void
}): Promise<{ ok: boolean }> {
  let entry = byChat.get(opts.chatId)
  if (!entry) {
    const session = new AcpSession(opts.onEvent, opts.yolo === true)
    try {
      await session.connect(opts.cwd, opts.sessionId)
    } catch {
      session.dispose()
      return { ok: false }
    }
    entry = { session, idleTimer: null }
    byChat.set(opts.chatId, entry)
  }
  entry.session.setYolo(opts.yolo === true)
  runToChat.set(opts.runId, opts.chatId)
  entry.session.prompt(opts.runId, opts.prompt)
  touch(opts.chatId)
  return { ok: true }
}

export function respondPermission(runId: string, requestId: string, optionId: string): void {
  const chatId = runToChat.get(runId)
  if (!chatId) return
  byChat.get(chatId)?.session.respondPermission(requestId, optionId)
  touch(chatId)
}

export function cancelRun(runId: string): boolean {
  const chatId = runToChat.get(runId)
  if (!chatId) return false
  const e = byChat.get(chatId)
  if (!e) return false
  e.session.cancel()
  return true
}

export function disposeAll(): void {
  for (const chatId of [...byChat.keys()]) disposeChat(chatId)
}
```
Note: one session per chat also means a fresh `session/new` after an ACP-session death is seeded by the RENDERER's existing logic (no `chat.sessionId` match → replay prompt), so no seeding logic lives here.

- [ ] **Step 5: Run to verify pass** (`npx vitest run src/main/runtime/acp`), full gate.

- [ ] **Step 6: Commit**
```bash
git add src/main/runtime/acp/
git commit -m "feat(acp): persistent AcpSession + SessionManager behind the TransportSession seam"
```

---

### Task 4: IPC routing, preload, renderer reducers, persistence

**Files:**
- Modify: `src/main/runtime/ipc.ts` (copilot start routing + respondPermission + cancel dispatch + quit hook), `src/preload/index.ts`, `src/renderer/src/store/store.ts` (Turn fields + reducers), `src/renderer/src/store/runtime.ts` (event routing), `src/renderer/src/store/persist.ts` (hydrate staleness)
- Test: `src/renderer/src/store/store.test.ts`, `src/renderer/src/store/persist.test.ts` (additive)

**Interfaces:**
- Consumes: Task 2 events/channel, Task 3 manager functions.
- Produces: `Turn.tools?: ToolRow[]`, `Turn.permissions?: PermissionCard[]` with
  `ToolRow { toolCallId: string; title: string; kind?: string; status: 'pending'|'running'|'completed'|'failed'; detail?: string }`,
  `PermissionCard { requestId: string; title: string; detail?: string; options: PermissionOption[]; resolvedOptionId?: string }`;
  store actions `upsertTool(chatId, row)`, `upsertPermission(chatId, card)`, `resolvePermission(chatId, requestId, optionId)`;
  preload `runs.respondPermission(runId, requestId, optionId): Promise<void>`.

- [ ] **Step 1: Write the failing tests.**

`store.test.ts` additions:
```ts
it('upsertTool merges by toolCallId on the streaming turn', () => {
  const s = useApp.getState()
  const id = s.activeChatId
  s.pushTurn(id, { id: 'a1', role: 'assistant', text: '', streaming: true })
  s.upsertTool(id, { toolCallId: 't1', title: 'Run x', status: 'pending', detail: 'x' })
  s.upsertTool(id, { toolCallId: 't1', title: 'Run x', status: 'completed', detail: 'done' })
  const turn = useApp.getState().chats[id].messages.at(-1)!
  expect(turn.tools).toEqual([{ toolCallId: 't1', title: 'Run x', status: 'completed', detail: 'done' }])
})

it('permission cards resolve in place', () => {
  const s = useApp.getState()
  const id = s.activeChatId
  s.pushTurn(id, { id: 'a2', role: 'assistant', text: '', streaming: true })
  s.upsertPermission(id, { requestId: 'p1', title: 'Run x', options: [{ id: 'allow_once', label: 'Allow once', kind: 'allow' }] })
  s.resolvePermission(id, 'p1', 'allow_once')
  const turn = useApp.getState().chats[id].messages.at(-1)!
  expect(turn.permissions?.[0].resolvedOptionId).toBe('allow_once')
})
```

`persist.test.ts` addition:
```ts
it('hydration never restores live-looking tool/permission state', () => {
  const raw = { fast: false, messages: [{ id: 'a', role: 'assistant', text: 'x', tools: [{ toolCallId: 't', title: 'T', status: 'running' }], permissions: [{ requestId: 'p', title: 'P', options: [] }] }] } as never
  const c = normalizeChat(raw, 'c_live')
  expect(c.messages[0].tools?.[0].status).toBe('failed')
  expect(c.messages[0].permissions?.[0].resolvedOptionId).toBe('stale')
})
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Store.** In `store.ts`: extend `Turn`:
```ts
export interface ToolRow {
  toolCallId: string
  title: string
  kind?: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  detail?: string
}
export interface PermissionCard {
  requestId: string
  title: string
  detail?: string
  options: PermissionOption[]
  resolvedOptionId?: string
}
export interface Turn {
  id: string
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
  error?: boolean
  tools?: ToolRow[]        // render-only history — NEVER read by buildReplayPrompt
  permissions?: PermissionCard[]
}
```
(`PermissionOption` imported from shared/runtime.) Add the three actions to `AppState` and implement with the existing `updateLast` helper:
```ts
  upsertTool: (chatId, row) =>
    set((s) => {
      const c = s.chats[chatId]
      if (!c) return {}
      const messages = updateLast(c.messages, (t) => {
        const tools = t.tools ? [...t.tools] : []
        const i = tools.findIndex((x) => x.toolCallId === row.toolCallId)
        if (i >= 0) tools[i] = { ...tools[i], ...row }
        else tools.push(row)
        return { ...t, tools }
      })
      return { chats: { ...s.chats, [chatId]: { ...c, messages } } }
    }),
  upsertPermission: (chatId, card) =>
    set((s) => {
      const c = s.chats[chatId]
      if (!c) return {}
      const messages = updateLast(c.messages, (t) => {
        const permissions = t.permissions ? [...t.permissions] : []
        const i = permissions.findIndex((x) => x.requestId === card.requestId)
        if (i >= 0) permissions[i] = { ...permissions[i], ...card }
        else permissions.push(card)
        return { ...t, permissions }
      })
      return { chats: { ...s.chats, [chatId]: { ...c, messages } } }
    }),
  resolvePermission: (chatId, requestId, optionId) =>
    set((s) => {
      const c = s.chats[chatId]
      if (!c) return {}
      const messages = updateLast(c.messages, (t) => ({
        ...t,
        permissions: (t.permissions ?? []).map((p) => (p.requestId === requestId ? { ...p, resolvedOptionId: optionId } : p))
      }))
      return { chats: { ...s.chats, [chatId]: { ...c, messages } } }
    }),
```

- [ ] **Step 4: Event routing.** In `runtime.ts`'s `onEvent` switch add:
```ts
      case 'tool.updated':
        s.upsertTool(chatId, { toolCallId: event.toolCallId, title: event.title, kind: event.kind, status: event.status, detail: event.detail })
        break
      case 'permission.requested':
        s.upsertPermission(chatId, { requestId: event.requestId, title: event.title, detail: event.detail, options: event.options })
        break
      case 'permission.resolved':
        s.resolvePermission(chatId, event.requestId, event.optionId)
        break
```

- [ ] **Step 5: Persistence.** In `persist.ts` `normalizeChat`, replace the messages line with a sanitizer:
```ts
    messages: Array.isArray(c.messages)
      ? c.messages.map((m) => ({
          ...m,
          // never restore live-looking state (the `compacting` doctrine)
          tools: m.tools?.map((t) => (t.status === 'pending' || t.status === 'running' ? { ...t, status: 'failed' as const } : t)),
          permissions: m.permissions?.map((p) => (p.resolvedOptionId ? p : { ...p, resolvedOptionId: 'stale' }))
        }))
      : [],
```

- [ ] **Step 6: IPC + preload.** `ipc.ts`:
- imports: `import { promptViaAcp, respondPermission as acpRespondPermission, cancelRun as acpCancelRun, disposeAll as acpDisposeAll } from './acp/sessionManager'` and `app` is already imported.
- In `RUN_CHANNELS.start`, replace the copilot branch: the handler becomes async for copilot only —
```ts
    if (req.provider === 'copilot') {
      // Interactive-first: persistent ACP session; on { ok: false } fall back to the one-shot path.
      void promptViaAcp({ chatId: req.chatId ?? runId, runId, prompt: req.prompt, cwd: req.cwd, yolo: req.yolo, sessionId: req.sessionId, onEvent: handler }).then(({ ok }) => {
        if (!ok) {
          handler({ type: 'content.delta', runId, streamKind: 'assistant_text', text: '\n[interactive session unavailable — ran headless]\n' })
          runs.set(runId, startCopilotRun(runId, { prompt: req.prompt, cwd: req.cwd, yolo: req.yolo, sessionId: req.sessionId, effort: req.effort, model: req.model }, handler))
        }
      })
      return { runId }
    }
```
placed before the existing ternary (whose copilot branch is removed). `RunRequest` gains `chatId?: string // session-affinity key for persistent transports` in shared/runtime.ts, and `sendMessage` passes `chatId` (one line in `runs.start({...})`).
- Cancel handler becomes:
```ts
  ipcMain.handle(RUN_CHANNELS.cancel, (_e, runId: string): void => {
    if (acpCancelRun(runId)) return // live interactive session: protocol-level stop
    runs.get(runId)?.cancel()
    runs.delete(runId)
  })
```
- New handler: `ipcMain.handle(RUN_CHANNELS.respondPermission, (_e, runId: string, requestId: string, optionId: string) => acpRespondPermission(runId, requestId, optionId))`
- In `registerRuntimeIpc`, register `app.on('will-quit', () => acpDisposeAll())`.

`preload/index.ts` `runs` object gains:
```ts
    respondPermission: (runId: string, requestId: string, optionId: string): Promise<void> =>
      ipcRenderer.invoke(RUN_CHANNELS.respondPermission, runId, requestId, optionId),
```

- [ ] **Step 7: Run to verify pass**, full gate (`npm run typecheck && npx vitest run`).

- [ ] **Step 8: Commit**
```bash
git add src/shared/runtime.ts src/main/runtime/ipc.ts src/preload/index.ts src/renderer/src/store
git commit -m "feat(runtime): interactive copilot routing, permission IPC, tool/permission turn state"
```

---

### Task 5: UI — ToolRow, PermissionCard, Stop button

**Files:**
- Create: `src/renderer/src/components/ToolRow.tsx`, `src/renderer/src/components/PermissionCard.tsx`
- Modify: `src/renderer/src/components/ChatView.tsx` (render rows/cards inside assistant messages; Stop button), `src/renderer/src/store/runtime.ts` (export `runIdForChat`)
- Test: none new (component idiom is untested in this repo — rendering is verified live in Task 6); full suite must stay green.

**Interfaces:**
- Consumes: `Turn.tools`/`Turn.permissions` (Task 4), `window.nac.runs.respondPermission` + `runs.cancel` (Task 4), `isStreaming`.

- [ ] **Step 1: `ToolRow.tsx`:**
```tsx
import { useState, type CSSProperties } from 'react'
import type { ToolRow as ToolRowData } from '../store/store'

const GLYPH: Record<ToolRowData['status'], string> = { pending: '·', running: '⟳', completed: '✓', failed: '✗' }
const GLYPH_COLOR: Record<ToolRowData['status'], string> = { pending: 'var(--muted)', running: 'var(--accent-light)', completed: 'var(--success)', failed: 'var(--error)' }

export default function ToolRow(props: { tool: ToolRowData }) {
  const [open, setOpen] = useState(false)
  const t = props.tool
  return (
    <div style={{ margin: '4px 0' }}>
      <button onClick={() => setOpen(!open)} style={row}>
        <span style={{ color: GLYPH_COLOR[t.status], width: 14, display: 'inline-block' }}>{GLYPH[t.status]}</span>
        <span className="mono" style={{ fontSize: 12, color: 'var(--text-2)' }}>{t.title}</span>
        {t.detail && <span style={{ marginLeft: 'auto', color: 'var(--faint)', fontSize: 11 }}>{open ? '▾' : '▸'}</span>}
      </button>
      {open && t.detail && (
        <pre className="mono" style={detailBox}>{t.detail}</pre>
      )}
    </div>
  )
}

const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', textAlign: 'left' }
const detailBox: CSSProperties = { margin: '2px 0 0 22px', padding: '6px 10px', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 6, fontSize: 11, color: 'var(--muted)', whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }
```

- [ ] **Step 2: `PermissionCard.tsx`:**
```tsx
import { type CSSProperties } from 'react'
import type { PermissionCard as CardData } from '../store/store'

export default function PermissionCard(props: { card: CardData; onRespond: (optionId: string) => void }) {
  const c = props.card
  if (c.resolvedOptionId) {
    const chosen = c.options.find((o) => o.id === c.resolvedOptionId)
    const label = c.resolvedOptionId === 'stale' ? '· expired' : `${chosen?.kind === 'deny' ? '✗' : '✓'} ${chosen?.label ?? c.resolvedOptionId}`
    return (
      <div style={{ ...resolvedLine }}>
        {label} — {c.title}
      </div>
    )
  }
  return (
    <div style={card}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{c.title}</div>
      {c.detail && <pre className="mono" style={detail}>{c.detail}</pre>}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        {c.options.map((o) => (
          <button key={o.id} onClick={() => props.onRespond(o.id)} style={{ ...btn, ...(o.kind === 'deny' ? denyBtn : {}) }}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

const card: CSSProperties = { margin: '6px 0', padding: '10px 12px', background: 'var(--card)', border: '1px solid var(--warning)', borderRadius: 8 }
const detail: CSSProperties = { margin: '4px 0 0', padding: '6px 10px', background: 'var(--card-3, var(--panel))', borderRadius: 6, fontSize: 11.5, color: 'var(--text-2)', whiteSpace: 'pre-wrap' }
const btn: CSSProperties = { background: 'var(--accent-tint-3)', color: 'var(--accent-light)', border: '1px solid var(--accent)', borderRadius: 6, padding: '4px 12px', fontSize: 12, cursor: 'pointer' }
const denyBtn: CSSProperties = { background: 'var(--card)', color: 'var(--muted)', border: '1px solid var(--line-2)' }
const resolvedLine: CSSProperties = { margin: '4px 0', fontSize: 11.5, color: 'var(--muted)' }
```

- [ ] **Step 3: ChatView integration.** In the message list (`ChatView.tsx:109` today renders `<Message …/>`), pass the turn through and render inside the assistant message flow: change the map to give `Message` the whole turn (`<Message key={m.id} turn={m} runId={…}` — simplest faithful change: extend the existing `Message` component signature to `props: { turn: Turn }` plus a `respond` callback). Inside `Message`, before the text block:
```tsx
      {props.turn.permissions?.map((p) => (
        <PermissionCard key={p.requestId} card={p} onRespond={(optionId) => respondPermission(props.turn, p.requestId, optionId)} />
      ))}
      {props.turn.tools?.map((t) => (
        <ToolRow key={t.toolCallId} tool={t} />
      ))}
```
where `respondPermission` calls `window.nac.runs.respondPermission(activeRunId(props.turn), p.requestId, optionId)`. The renderer's `runtime.ts` exposes the run id: add
```ts
export function runIdForChat(chatId: string): string | undefined {
  return Object.keys(runToChat).find((r) => runToChat[r] === chatId)
}
```
and ChatView uses `runIdForChat(active.id)` for the active streaming turn (cards only appear on the streaming turn, so this is unambiguous).
- Stop button: next to Send (`ChatView.tsx:168` area), when `streaming`:
```tsx
              {streaming && (
                <button onClick={() => { const r = runIdForChat(active.id); if (r) void window.nac.runs.cancel(r) }} style={stopBtn}>
                  Stop
                </button>
              )}
```
with `const stopBtn: CSSProperties = { background: 'var(--card)', color: 'var(--warning)', border: '1px solid var(--warning)', borderRadius: 8, padding: '9px 14px', fontSize: 13, cursor: 'pointer' }` — exact placement/styling may be adapted to the composer's existing layout idiom.

- [ ] **Step 4: Verify** — `npm run typecheck && npx vitest run` green.

- [ ] **Step 5: Commit**
```bash
git add src/renderer/src/components
git commit -m "feat(ui): permission cards, expandable tool rows, stop button"
```

---

### Task 6: Live verification + docs

**Files:**
- Modify: `docs/DECISIONS.md`

- [ ] **Step 1: Live matrix** (controller-driven in the running app, YOLO OFF, copilot chat in a scratch workspace):
  1. Prompt that runs a shell command → PermissionCard appears with the harness's 3 options → Allow once → ToolRow streams pending→completed (expand shows output) → reply text lands → turn completes.
  2. Deny path: same prompt → Deny → turn completes without executing (tool row absent or failed).
  3. Stop mid-run → `run.completed` with `canceled`, Stop button disappears, composer usable.
  4. Turn 2 on the same chat → verify NO replay block was sent (bare message; check main-process behavior via a probe or the copilot session transcript) and the reply has first-turn context.
  5. Quit + relaunch → next send revives via `session/load` (context recalled) or falls back to seeded fresh session; either way no error.
  6. YOLO ON → same shell prompt → no card, tool executes, rows still stream.
  7. Fallback: temporarily break ACP (e.g. PATH-shadow `copilot` with a script that fails on `--acp`) → send → headless fallback line appears and the turn completes via the one-shot path.
  8. Cross-provider: switch the chat to claude → replay carries the conversation (tool rows excluded — verify the replay prompt contains no tool text).

- [ ] **Step 2: Final gate** — `npm run typecheck && npx vitest run && npm run build`.

- [ ] **Step 3: DECISIONS entry** — add at the top of "Current phase" (replace `<commit>` with the real hash):
```markdown
**✅ Interactive run transport — pillar 1, copilot ACP** (`<commit>`): copilot runs are INTERACTIVE — a persistent `copilot --acp` session per chat (spawn → initialize → session/new, revived across restarts via session/load) behind a provider-generic `TransportSession` seam; the harness's permission requests render as inline transcript cards (Allow once / Always / Deny — the harness's own options), tool calls render as live expandable rows, and Stop is a real protocol-level `session/cancel`. YOLO auto-approves (no cards). Tool/permission history is render-only — the replay invariant holds (`buildReplayPrompt` reads only turn text), so cross-provider switches stay bounded. Every ACP failure falls back to the one-shot headless path (floor = previous release). Verified live: allow/deny/cancel/continuity/restart-revival/fallback/cross-provider-switch matrix. Pillars 2-4 (codex app-server, claude, opencode acp) reuse this seam. Spec: `docs/superpowers/specs/2026-07-09-interactive-run-transport-design.md`.
```

- [ ] **Step 4: Commit**
```bash
git add docs/DECISIONS.md
git commit -m "docs: interactive run transport pillar 1 done — copilot ACP verified live"
```
