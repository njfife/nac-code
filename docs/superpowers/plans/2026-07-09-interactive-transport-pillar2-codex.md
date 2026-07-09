# Interactive Run Transport — Pillar 2 (Codex App-Server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Codex runs become interactive — per-chat `codex app-server` sessions with token streaming, approval cards from the server's own decisions, diff-carrying tool rows, real interrupt, and live token-usage numbers in the Inspector — behind the pillar-1 `TransportSession` seam with the same fallback ladder.

**Architecture:** The `TransportSession` interface is promoted (busy/dead/setYolo + a `PromptOpts` param); a `CodexSession` implements it over `codex app-server` (initialize → thread/start|resume → turn/start per send, per-turn model/effort, run resolution on the `turn/completed` NOTIFICATION with a watchdog); pure `mapCodex` converts live-captured frames into pillar-1 canonical events plus one new `usage.updated`; the SessionManager grows a per-provider factory and the ipc codex branch routes through it with the one-shot `codexArgs` path as the floor; the renderer maps `usage.updated` onto the existing `contextK`/`windowK` fields, making the Inspector's context bar real for codex chats.

**Tech Stack:** Electron + React + TS, Zustand, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-09-interactive-transport-pillar2-codex-design.md`. Frames: `docs/research/codex-turn-frames-0.142.3.txt` (live-captured 2026-07-09).

## Global Constraints

- Wrapper, never a harness; renderer only via the typed preload bridge; pure/exported/tested logic; typecheck + vitest green before every commit (baseline: 20 files / 114 tests).
- Replay invariant: `buildReplayPrompt` reads only `turn.text` — untouched.
- Fallback floor: any app-server failure → this send runs through the one-shot `startCodexRun` path (with `sessionId` so `codex exec resume` preserves context); fallback notice is the render-only `tool.updated` row idiom from pillar 1, never `content.delta`.
- Verified protocol shapes (do not invent): `sandboxPolicy` is TYPE-tagged (`{type:'readOnly'|'workspaceWrite'|'dangerFullAccess'}`); `turn/start` input is `[{type:'text', text}]`; approvals are id-bearing server requests `item/commandExecution/requestApproval` / `item/fileChange/requestApproval` answered `{decision: <one of availableDecisions, echoed VERBATIM>}`; `turn/start` RESPONDS immediately (`inProgress`) — the turn ends on the `turn/completed` notification; codex responses omit `jsonrpc`; the stream is chatty — unknown methods are ignored.
- YOLO mapping: on → `approvalPolicy:'never'` + `{type:'workspaceWrite'}`; off → `'untrusted'` + `{type:'readOnly'}`.
- Context-preservation doctrine: `thread/resume` failure THROWS (caller falls back to one-shot resume); whether resume replays item history is unverified — keep a `replaying` suppression guard around it (Task 6 confirms live).
- Codex ledger hooks STAY LIVE (per-turn model honored) — the existing copilot-only gate in ipc.ts must not widen.
- Never restore live-looking state on hydrate (`contextLive` resets false).

---

### Task 1: Shared groundwork — `usage.updated`, promoted `TransportSession`, exported `readableCommand`

**Files:**
- Modify: `src/shared/runtime.ts` (AgentEvent member), `src/main/runtime/acp/acpSession.ts` (interface promotion + ignored opts), `src/main/runtime/codexAdapter.ts` (export `readableCommand`)
- Test: `src/main/runtime/codexAdapter.test.ts` (additive)

**Interfaces:**
- Produces: AgentEvent gains
  `{ type: 'usage.updated'; runId: string; inputTokens: number; cachedInputTokens?: number; outputTokens: number; reasoningOutputTokens?: number; contextUsedTokens?: number; contextWindow?: number }`;
  in acpSession.ts:
  ```ts
  export interface PromptOpts {
    model?: string
    effort?: string
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
  ```
  `AcpSession.prompt(runId, text, _opts?: PromptOpts)` — opts accepted and IGNORED with the comment `// pillar-1 limitation: copilot ACP runs the account-default model; opts are honored by CodexSession`;
  `export function readableCommand(raw: string): string` from codexAdapter.ts (function body unchanged — just add `export`).

- [ ] **Step 1: Write the failing test** — append to `codexAdapter.test.ts`:

```ts
import { readableCommand } from './codexAdapter'

describe('readableCommand', () => {
  it('unwraps zsh -lc wrapping (as app-server commandExecution items arrive)', () => {
    expect(readableCommand("/bin/zsh -lc 'touch nac-approval-probe.txt'")).toBe('touch nac-approval-probe.txt')
    expect(readableCommand('plain command')).toBe('plain command')
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/main/runtime/codexAdapter.test.ts` → FAIL (not exported).

- [ ] **Step 3: Implement.** Add `export` to `readableCommand` in codexAdapter.ts. Add the `usage.updated` member to `AgentEvent` in shared/runtime.ts (after `permission.resolved`) with the comment `// live token metering (codex app-server thread/tokenUsage); contextWindow/contextUsedTokens drive the Inspector bar`. In acpSession.ts: add `PromptOpts`, extend `TransportSession` exactly as above (busy/dead/setYolo promoted from the class), and change `AcpSession.prompt(runId: string, text: string)` to `prompt(runId: string, text: string, _opts?: PromptOpts)` with the limitation comment.

- [ ] **Step 4: Verify** — `npm run typecheck && npx vitest run` → green (115 tests).

- [ ] **Step 5: Commit**
```bash
git add src/shared/runtime.ts src/main/runtime/acp/acpSession.ts src/main/runtime/codexAdapter.ts src/main/runtime/codexAdapter.test.ts
git commit -m "feat(transport): usage.updated event + promoted TransportSession with PromptOpts"
```

---

### Task 2: Pure codex mappers (`mapCodex.ts`)

**Files:**
- Create: `src/main/runtime/acp/mapCodex.ts`
- Test: `src/main/runtime/acp/mapCodex.test.ts`

**Interfaces:**
- Consumes: `readableCommand` (Task 1), shared event types, `PermissionOption`.
- Produces (Task 3 relies on):
  ```ts
  export function codexTurnPolicy(yolo: boolean): { approvalPolicy: string; sandboxPolicy: { type: string } }
  export function mapCodexItem(runId: string, phase: 'started' | 'completed', item: unknown): AgentEvent[]
  export function mapCodexDelta(runId: string, params: unknown): AgentEvent[]
  export interface CodexApprovalMapping {
    event: Extract<AgentEvent, { type: 'permission.requested' }>
    decisions: Record<string, unknown> // option id -> ORIGINAL availableDecisions value (echoed verbatim)
  }
  export function mapCodexApproval(runId: string, requestId: string, method: string, params: unknown): CodexApprovalMapping | null
  export interface CodexUsageMapping {
    event: Extract<AgentEvent, { type: 'usage.updated' }>
    stepInput: number  // tokenUsage.last.inputTokens
    stepOutput: number // tokenUsage.last.outputTokens
  }
  export function mapCodexUsage(runId: string, params: unknown): CodexUsageMapping | null
  export function mapCodexTurnStatus(status: string | undefined, error: { message?: string } | null | undefined): { kind: 'completed'; stopReason: 'end_turn' | 'canceled' } | { kind: 'errored'; message: string }
  ```

- [ ] **Step 1: Write the failing tests** — fixtures are the LIVE captured frames:

```ts
import { describe, it, expect } from 'vitest'
import { codexTurnPolicy, mapCodexItem, mapCodexDelta, mapCodexApproval, mapCodexUsage, mapCodexTurnStatus } from './mapCodex'

const CMD_ITEM = { type: 'commandExecution', id: 'call_3Sac', command: "/bin/zsh -lc 'touch nac-approval-probe.txt'", cwd: '/tmp/x', status: 'inProgress' }
const CMD_DONE = { ...CMD_ITEM, status: 'completed', aggregatedOutput: 'ok\n' }
const APPROVAL = { threadId: 't1', turnId: 'turn1', itemId: 'call_dvl', command: "/bin/zsh -lc 'touch nac-approval-probe.txt'", cwd: '/tmp/x', availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch', 'nac-approval-probe.txt'] } }, 'cancel'] }
const USAGE = { threadId: 't1', turnId: 'turn1', tokenUsage: { total: { totalTokens: 42305, inputTokens: 41684, cachedInputTokens: 25344, outputTokens: 621, reasoningOutputTokens: 474 }, last: { totalTokens: 21311, inputTokens: 21092, cachedInputTokens: 20352, outputTokens: 219, reasoningOutputTokens: 148 }, modelContextWindow: 272000 } }

describe('codexTurnPolicy', () => {
  it('maps YOLO to never/workspaceWrite and off to untrusted/readOnly', () => {
    expect(codexTurnPolicy(true)).toEqual({ approvalPolicy: 'never', sandboxPolicy: { type: 'workspaceWrite' } })
    expect(codexTurnPolicy(false)).toEqual({ approvalPolicy: 'untrusted', sandboxPolicy: { type: 'readOnly' } })
  })
})

describe('mapCodexItem', () => {
  it('maps commandExecution started/completed to tool rows with the unwrapped command', () => {
    expect(mapCodexItem('r', 'started', CMD_ITEM)).toEqual([{ type: 'tool.updated', runId: 'r', toolCallId: 'call_3Sac', title: 'touch nac-approval-probe.txt', kind: 'execute', status: 'running', detail: 'touch nac-approval-probe.txt' }])
    const [done] = mapCodexItem('r', 'completed', CMD_DONE)
    expect(done).toMatchObject({ type: 'tool.updated', status: 'completed' })
    expect((done as { detail?: string }).detail).toContain('ok')
  })
  it('maps a failed commandExecution to failed', () => {
    expect(mapCodexItem('r', 'completed', { ...CMD_ITEM, status: 'failed' })[0]).toMatchObject({ status: 'failed' })
  })
  it('maps fileChange to an edit row carrying the diff and skips agentMessage/userMessage/empty reasoning', () => {
    const [fc] = mapCodexItem('r', 'completed', { type: 'fileChange', id: 'fc1', changes: [{ path: 'a.ts' }], diff: '--- a.ts\n+++ a.ts\n+x' })
    expect(fc).toMatchObject({ type: 'tool.updated', kind: 'edit', status: 'completed' })
    expect((fc as { detail?: string }).detail).toContain('+++')
    expect(mapCodexItem('r', 'completed', { type: 'agentMessage', id: 'm1', text: 'hi' })).toEqual([])
    expect(mapCodexItem('r', 'started', { type: 'userMessage', id: 'u1' })).toEqual([])
    expect(mapCodexItem('r', 'completed', { type: 'reasoning', id: 'rs1', summary: [], content: [] })).toEqual([])
    expect(mapCodexItem('r', 'started', null)).toEqual([])
  })
  it('renders reasoning WITH summary text as a collapsed row', () => {
    const [e] = mapCodexItem('r', 'completed', { type: 'reasoning', id: 'rs2', summary: [{ type: 'summary_text', text: 'thought about it' }], content: [] })
    expect(e).toMatchObject({ type: 'tool.updated', kind: 'reasoning', title: 'Reasoning', status: 'completed', detail: 'thought about it' })
  })
})

describe('mapCodexDelta', () => {
  it('maps agentMessage deltas to assistant text', () => {
    expect(mapCodexDelta('r', { itemId: 'm1', delta: 'Using' })).toEqual([{ type: 'content.delta', runId: 'r', streamKind: 'assistant_text', text: 'Using' }])
    expect(mapCodexDelta('r', {})).toEqual([])
  })
})

describe('mapCodexApproval', () => {
  it('maps the captured request; options mirror availableDecisions; decisions echo the ORIGINAL values', () => {
    const m = mapCodexApproval('r', 'req1', 'item/commandExecution/requestApproval', APPROVAL)!
    expect(m.event).toMatchObject({ type: 'permission.requested', requestId: 'req1', title: 'touch nac-approval-probe.txt', detail: 'touch nac-approval-probe.txt' })
    expect(m.event.options).toEqual([
      { id: 'accept', label: 'Allow once', kind: 'allow' },
      { id: 'acceptWithExecpolicyAmendment', label: 'Always allow this command', kind: 'allow_always' },
      { id: 'cancel', label: 'Deny', kind: 'deny' }
    ])
    expect(m.decisions.accept).toBe('accept')
    expect(m.decisions.cancel).toBe('cancel')
    expect(m.decisions.acceptWithExecpolicyAmendment).toEqual(APPROVAL.availableDecisions[1])
  })
  it('maps acceptForSession to allow_always and tolerates junk', () => {
    const m = mapCodexApproval('r', 'x', 'item/commandExecution/requestApproval', { ...APPROVAL, availableDecisions: ['accept', 'acceptForSession', 'cancel'] })!
    expect(m.event.options[1]).toEqual({ id: 'acceptForSession', label: 'Allow for session', kind: 'allow_always' })
    expect(mapCodexApproval('r', 'x', 'item/commandExecution/requestApproval', null)).toBeNull()
    expect(mapCodexApproval('r', 'x', 'item/commandExecution/requestApproval', { availableDecisions: [] })).toBeNull()
  })
  it('maps fileChange approvals with a reason', () => {
    const m = mapCodexApproval('r', 'x', 'item/fileChange/requestApproval', { itemId: 'i', reason: 'writes outside sandbox', availableDecisions: ['accept', 'cancel'] })!
    expect(m.event.title).toBe('Edit files')
    expect(m.event.detail).toBe('writes outside sandbox')
  })
})

describe('mapCodexUsage', () => {
  it('maps the captured usage frame to usage.updated + step tokens', () => {
    const m = mapCodexUsage('r', USAGE)!
    expect(m.event).toEqual({ type: 'usage.updated', runId: 'r', inputTokens: 41684, cachedInputTokens: 25344, outputTokens: 621, reasoningOutputTokens: 474, contextUsedTokens: 42305, contextWindow: 272000 })
    expect(m.stepInput).toBe(21092)
    expect(m.stepOutput).toBe(219)
    expect(mapCodexUsage('r', null)).toBeNull()
  })
})

describe('mapCodexTurnStatus', () => {
  it('maps completed/interrupted/error', () => {
    expect(mapCodexTurnStatus('completed', null)).toEqual({ kind: 'completed', stopReason: 'end_turn' })
    expect(mapCodexTurnStatus('interrupted', null)).toEqual({ kind: 'completed', stopReason: 'canceled' })
    expect(mapCodexTurnStatus('failed', { message: 'boom' })).toEqual({ kind: 'errored', message: 'boom' })
    expect(mapCodexTurnStatus(undefined, undefined)).toEqual({ kind: 'errored', message: 'codex turn ended without status' })
  })
})
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement `mapCodex.ts`:**

```ts
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
    phase === 'started' ? 'running' : item.status === 'failed' ? 'failed' : 'completed'
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
```

NOTE the deliberate wrinkle the test pins: `contextWindow` reads `u.modelContextWindow` where `u` is `tokenUsage` — the captured frame nests it INSIDE tokenUsage.

- [ ] **Step 4: Run to verify pass**, then full gate.

- [ ] **Step 5: Commit**
```bash
git add src/main/runtime/acp/mapCodex.ts src/main/runtime/acp/mapCodex.test.ts
git commit -m "feat(codex): pure app-server frame mappers from captured fixtures"
```

---

### Task 3: CodexSession

**Files:**
- Create: `src/main/runtime/acp/codexSession.ts`
- Test: `src/main/runtime/acp/codexSession.test.ts` (pure watchdog constant + policy reuse assertions only; lifecycle is live-verified in Task 6)

**Interfaces:**
- Consumes: `JsonRpcClient`, `TransportSession`/`PromptOpts`/`acpCwd`/`pickAutoApprove`/`shouldAutoCancelPermission` (acpSession.ts), all Task 2 mappers.
- Produces: `class CodexSession implements TransportSession` with `connect(cwd: string | undefined, existingThreadId: string | undefined): Promise<string>`; `export const TURN_WATCHDOG_MS = 1_800_000`.

- [ ] **Step 1: Write the failing test:**

```ts
import { describe, it, expect } from 'vitest'
import { TURN_WATCHDOG_MS, CodexSession } from './codexSession'
import { PROMPT_TIMEOUT_MS } from './acpSession'

describe('CodexSession constants', () => {
  it('watchdog matches the pillar-1 turn ceiling', () => {
    expect(TURN_WATCHDOG_MS).toBe(PROMPT_TIMEOUT_MS)
  })
  it('exports a TransportSession-shaped class', () => {
    expect(typeof CodexSession.prototype.prompt).toBe('function')
    expect(typeof CodexSession.prototype.respondPermission).toBe('function')
    expect(typeof CodexSession.prototype.cancel).toBe('function')
    expect(typeof CodexSession.prototype.dispose).toBe('function')
  })
})
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement `codexSession.ts`:**

```ts
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
        cwd: acpCwd(undefined), // chat cwd is set at connect via thread; per-turn cwd passed below when provided
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
    const turn = (params as { turn?: { status?: string; error?: { message?: string } | null } } | null)?.turn
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
```

IMPLEMENTATION NOTE on `cwd`: `turn/start` accepts a per-turn `cwd`. The manager passes the chat's cwd into `connect` only; pass it through to `prompt` too — change the `prompt` line `cwd: acpCwd(undefined)` to use a `private cwd: string` field captured in `connect(cwd, …)` (`this.cwd = acpCwd(cwd)`) and sent as `cwd: this.cwd`. Implement it that way (field + capture), not the literal line above.

- [ ] **Step 4: Run to verify pass**, then full gate.

- [ ] **Step 5: Commit**
```bash
git add src/main/runtime/acp/codexSession.ts src/main/runtime/acp/codexSession.test.ts
git commit -m "feat(codex): CodexSession — app-server transport behind the TransportSession seam"
```

---

### Task 4: SessionManager factory + ipc codex routing

**Files:**
- Modify: `src/main/runtime/acp/sessionManager.ts` (factory + rename + opts), `src/main/runtime/ipc.ts` (codex branch + call-site rename)
- Test: none new (manager stays lifecycle-thin; factory routing is asserted by typecheck + Task 6 live); full suite green required.

**Interfaces:**
- Consumes: `CodexSession` (Task 3), `TransportSession`/`PromptOpts` (Task 1).
- Produces: `promptViaTransport(opts: { provider: 'copilot' | 'codex'; chatId; runId; prompt; cwd?; yolo?; sessionId?; model?; effort?; onEvent }): Promise<{ ok: boolean }>` (renamed from `promptViaAcp`; `respondPermission`/`cancelRun`/`disposeAll` unchanged).

- [ ] **Step 1: Generalize the manager.** In `sessionManager.ts`:
- `import { AcpSession, type TransportSession, type PromptOpts } from './acpSession'` and `import { CodexSession } from './codexSession'`; `Entry.session: TransportSession`.
- Rename `promptViaAcp` → `promptViaTransport`; opts gains `provider: 'copilot' | 'codex'`, `model?: string`, `effort?: string`.
- Session creation becomes a factory:
```ts
    const sink = (e: AgentEvent): void => {
      if (e.type === 'run.completed' || e.type === 'run.errored') runToChat.delete(e.runId)
      ref.onEvent(e)
    }
    const session: TransportSession & { connect(cwd: string | undefined, id: string | undefined): Promise<string> } =
      opts.provider === 'codex' ? new CodexSession(sink, opts.yolo === true) : new AcpSession(sink, opts.yolo === true)
```
- The prompt call passes opts through: `entry.session.prompt(opts.runId, opts.prompt, { model: opts.model, effort: opts.effort })`.
- Update the header comment (sessions = one live transport per chat, copilot ACP or codex app-server).

- [ ] **Step 2: ipc routing.** In `ipc.ts`: update the import to `promptViaTransport`; replace the copilot-only guard with:
```ts
    if (req.provider === 'copilot' || req.provider === 'codex') {
      // Interactive-first: persistent transport session; on { ok: false } fall back to the one-shot path.
      void promptViaTransport({ provider: req.provider, chatId: req.chatId ?? runId, runId, prompt: req.prompt, cwd: req.cwd, yolo: req.yolo, sessionId: req.sessionId, model: req.model, effort: req.effort, onEvent: handler }).then(({ ok }) => {
        if (!ok) {
          // Render-only notice (never content.delta — replay must stay clean).
          handler({ type: 'tool.updated', runId, toolCallId: `fallback_${runId}`, title: 'interactive session unavailable — ran headless', kind: 'notice', status: 'failed' })
          runs.set(
            runId,
            req.provider === 'codex'
              ? startCodexRun(runId, { prompt: req.prompt, cwd: req.cwd, yolo: req.yolo, sessionId: req.sessionId, effort: req.effort, model: req.model }, handler)
              : startCopilotRun(runId, { prompt: req.prompt, cwd: req.cwd, yolo: req.yolo, sessionId: req.sessionId, effort: req.effort, model: req.model }, handler)
          )
        }
      })
      return { runId }
    }
```
and remove the codex branch from the one-shot ternary below (claude/opencode/stub remain). The ledger gate (`ledgerModel = req.provider === 'copilot' ? undefined : req.model`) is UNTOUCHED — codex verdicts stay live per spec.

- [ ] **Step 3: Verify** — `npm run typecheck && npx vitest run` green; grep `promptViaAcp` returns nothing.

- [ ] **Step 4: Commit**
```bash
git add src/main/runtime/acp/sessionManager.ts src/main/runtime/ipc.ts
git commit -m "feat(transport): provider factory in SessionManager; codex routes interactive-first"
```

---

### Task 5: Renderer — real usage into the Inspector

**Files:**
- Modify: `src/renderer/src/store/store.ts` (`Chat.contextLive` + `setLiveContext`), `src/renderer/src/store/runtime.ts` (usage.updated case), `src/renderer/src/store/persist.ts` (sanitizer), `src/renderer/src/components/Inspector.tsx` (live affordance)
- Test: `src/renderer/src/store/store.test.ts`, `src/renderer/src/store/persist.test.ts` (additive)

**Interfaces:**
- Consumes: `usage.updated` (Task 1), emitted by CodexSession (Task 3).
- Produces: `Chat.contextLive?: boolean`; store action `setLiveContext(chatId: string, usedTokens: number, windowTokens?: number): void` (rounds to K into the existing `contextK`/`windowK`; sets `contextLive: true`; ignores calls without a positive usedTokens).

- [ ] **Step 1: Write the failing tests.**

`store.test.ts`:
```ts
it('setLiveContext maps real tokens onto contextK/windowK and marks the chat live', () => {
  const s = useApp.getState()
  const id = s.activeChatId
  s.setLiveContext(id, 42305, 272000)
  const c = useApp.getState().chats[id]
  expect(c.contextK).toBe(42)
  expect(c.windowK).toBe(272)
  expect(c.contextLive).toBe(true)
  s.setLiveContext(id, 61000) // window omitted: keep the previous window
  expect(useApp.getState().chats[id].contextK).toBe(61)
  expect(useApp.getState().chats[id].windowK).toBe(272)
})
```

`persist.test.ts`:
```ts
it('never rehydrates contextLive', () => {
  const raw = { fast: false, contextLive: true, messages: [] } as never
  expect(normalizeChat(raw, 'c_ctx').contextLive).toBe(false)
})
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.**
- `store.ts`: `Chat` gains `contextLive?: boolean // context bar shows REAL harness-reported numbers (codex app-server); reset on hydrate/provider switch`; `base` gains `contextLive: false`; `setModel`'s provider-switch branch also sets `contextLive: false` when `provider !== chat.provider`; action:
```ts
  setLiveContext: (chatId, usedTokens, windowTokens) =>
    set((s) => {
      const c = s.chats[chatId]
      if (!c || usedTokens <= 0) return {}
      return {
        chats: {
          ...s.chats,
          [chatId]: {
            ...c,
            contextK: Math.max(1, Math.round(usedTokens / 1000)),
            windowK: windowTokens && windowTokens > 0 ? Math.round(windowTokens / 1000) : c.windowK,
            contextLive: true
          }
        }
      }
    }),
```
(and the `setLiveContext: (chatId: string, usedTokens: number, windowTokens?: number) => void` signature in `AppState`).
- `runtime.ts` onEvent: `case 'usage.updated': s.setLiveContext(chatId, event.contextUsedTokens ?? 0, event.contextWindow); break`.
- `persist.ts` `normalizeChat`: add `contextLive: false,` beside the other never-restore-live sanitizers.
- `Inspector.tsx`: the "Tokens this session" value renders `{active.contextLive ? '' : '~'}{active.contextK}k` (line ~67), i.e. drop the `~` when live; the Context window row needs no change (numbers just become real).

- [ ] **Step 4: Run to verify pass**, full gate.

- [ ] **Step 5: Commit**
```bash
git add src/renderer/src src/shared 2>/dev/null; git add src/renderer/src
git commit -m "feat(usage): live codex token usage drives a real Inspector context bar"
```

---

### Task 6: Live verification (controller, computer use) + docs

**Files:**
- Modify: `docs/DECISIONS.md`

- [ ] **Step 1: Live matrix** (worktree dev app, a codex chat with Account default or GPT-5.5, scratch-safe prompts):
  1. YOLO OFF + write command (`touch`) → approval card with the server's real options (Allow once / Always allow this command / Deny) → Allow once → tool row streams → reply **streams token-by-token** (visibly incremental — the pillar's headline).
  2. Deny path → command blocked, turn completes.
  3. `acceptForSession`/amendment option → next identical command runs without a card (if offered).
  4. Stop mid-turn → `turn/interrupt` → run ends `canceled`.
  5. Two-turn thread continuity (no replay block; second turn recalls the first).
  6. Restart revival: plant a codeword → quit → relaunch → recall (thread/resume path); ALSO confirm whether resume replays item history (the spec's flagged unknown) — if the transcript double-appends, the `replaying` guard has a hole to fix before merge.
  7. Fallback: break `codex` on PATH → send → render-only notice row + one-shot path completes.
  8. **Inspector**: context row loses the `~` and shows real K numbers on the codex chat; a claude chat still shows `~`.
  9. fileChange row: ask codex to edit a scratch file (YOLO on, workspace-write) → row shows diff text on expand.
- [ ] **Step 2: Final gate** — `npm run typecheck && npx vitest run && npm run build`.
- [ ] **Step 3: DECISIONS entry** at the top of Current phase (replace `<commit>`):
```markdown
**✅ Interactive run transport — pillar 2, codex app-server** (`<commit>`): codex runs are INTERACTIVE with TOKEN STREAMING (item/agentMessage/delta — no more single-blob replies). Per-chat `codex app-server` session behind the same TransportSession seam (thread/start|resume → turn/start per send; run resolves on the turn/completed notification with a 30-min watchdog). Approvals render as permission cards built from the server's own availableDecisions (accept / acceptForSession / execpolicy-amendment / cancel — echoed verbatim, NAC invents nothing); fileChange rows carry diff text; Stop = turn/interrupt. Per-turn model+effort ARE honored (unlike copilot's pillar-1 limitation) so codex ledger verdicts stay live. NEW: real token metering — thread/tokenUsage/updated drives a genuinely live Inspector context bar for codex chats (contextK/windowK stop being estimates; the `~` drops). Fallback floor: one-shot codexArgs path incl. `codex exec resume` for revival failures. Verified live (computer-use matrix): approval options / deny / streaming / interrupt / continuity / restart revival / fallback / real context numbers. Spec: `docs/superpowers/specs/2026-07-09-interactive-transport-pillar2-codex-design.md`.
```
Also update the roadmap pillar list (pillar 2 ✅; pillar 3 claude next) in the same edit.
- [ ] **Step 4: Commit**
```bash
git add docs/DECISIONS.md
git commit -m "docs: interactive transport pillar 2 done — codex app-server verified live"
```
