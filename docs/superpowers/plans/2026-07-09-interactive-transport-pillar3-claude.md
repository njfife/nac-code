# Interactive Transport Pillar 3 — claude (stream-json) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude runs become interactive — token streaming, permission cards from claude's own `can_use_tool` suggestions, tool rows, protocol-level cancel, restart revival, real cost + live context metering — behind the existing `TransportSession` seam.

**Architecture:** One long-lived `claude --print --input-format stream-json --output-format stream-json` child per chat (`ClaudeSession`), driven by a new thin `StreamJsonClient` (typed newline frames — NOT JSON-RPC). Pure mappers (`mapClaude.ts`) turn captured-frame shapes into canonical `AgentEvent`s. The SessionManager factory gains a `claude` case; ipc routes claude interactive-first with the one-shot `claude --resume` fallback floor.

**Tech Stack:** Electron main process (Node `child_process`), TypeScript, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-09-interactive-transport-pillar3-claude-design.md` (all protocol facts live-verified on claude 2.1.181, 2026-07-09).

## Global Constraints

- Wrapper, never a harness; never scrape stdout — all integration is the structured stream-json protocol.
- ONE canonical `AgentEvent` union (`src/shared/runtime.ts`) — no new event types in this pillar; reuse `tool.updated`, `permission.requested/resolved`, `content.delta`, `usage.updated`, `run.*`.
- Replay invariant: `buildReplayPrompt` reads ONLY `turn.text`. Tool/permission rows are render-only. NEVER emit `content.delta` for notices.
- Permission responses echo claude's own material verbatim: `updatedInput` is the request's `input` unchanged; suggestion options pass the suggestion object back verbatim in `updatedPermissions`. NAC invents nothing.
- Context-preservation doctrine: revival (`--resume`) failure at connect THROWS → `{ok:false}` → one-shot `claude --resume` fallback. Never silently start a fresh session over a bare message.
- Spawn args (exact): `--print --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio --allow-dangerously-skip-permissions` (+ optional `--model X --effort Y --resume <id>`).
- YOLO: live `set_permission_mode` control request — `bypassPermissions` on, `default` off. Never respawn for YOLO.
- Cancel signature: after our own interrupt, the `result` frame is `subtype:'error_during_execution', is_error:true` → stopReason `canceled`. The same subtype WITHOUT a preceding interrupt is `run.errored`.
- Bogus `--resume` exits within ~1.3s with code 1 (verified) — connect verifies resume by racing a 2000ms timer vs child exit.
- Watchdogs are INACTIVITY-based this pillar (rider 2): re-arm on every frame/notification; ceiling stays `PROMPT_TIMEOUT_MS` (30 min) of silence. Applies to `ClaudeSession` AND retrofits `CodexSession`.
- All tests: `npx vitest run` green + `npm run typecheck` clean before every commit.
- Work happens in a NEW worktree branched from current main (create via the platform worktree tool at execution start). NEVER touch `/Users/nathanielfife/Code/nac-code` (main checkout) from implementers.

## Captured frames (fixtures — copy verbatim into tests)

```jsonc
// init (per turn)
{"type":"system","subtype":"init","cwd":"/tmp/x","session_id":"dda93358-5ca5-4353-a3e4-7acb12f0d34c","tools":["Task","Bash"]}
// token streaming
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ello pillar three"}},"session_id":"s1","parent_tool_use_id":null}
// message_start (usage → context metering)
{"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-opus-4-8","id":"msg_01","type":"message","role":"assistant","content":[],"usage":{"input_tokens":4133,"cache_creation_input_tokens":2049,"cache_read_input_tokens":15626,"output_tokens":3}}},"session_id":"s1"}
// tool_use (assistant frame content block)
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_01RYD8QsoLTUUctSz6jY7sAx","name":"Bash","input":{"command":"echo 'x' > p3-perm-check.txt","description":"Create file with x content"}}]},"session_id":"s1"}
// tool_result (user frame content block)
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"Output redirection was blocked. For security...","is_error":true,"tool_use_id":"toolu_01RYD8QsoLTUUctSz6jY7sAx"}]},"session_id":"s1"}
// permission request (server→client)
{"type":"control_request","request_id":"88d3f0f7-fd62-45b1-a054-af7ca4e068fa","request":{"subtype":"can_use_tool","tool_name":"Write","display_name":"Write","input":{"file_path":"/tmp/x/p3-can-use.txt","content":"y"},"description":"p3-can-use.txt","permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}],"tool_use_id":"toolu_016S"}}
// result success (usage + real cost)
{"type":"result","subtype":"success","is_error":false,"num_turns":2,"result":"Created it.","stop_reason":"end_turn","session_id":"da2786b4","total_cost_usd":0.0946805,"usage":{"input_tokens":4481,"cache_creation_input_tokens":2100,"cache_read_input_tokens":15700,"output_tokens":50}}
// result after OUR interrupt (cancel signature)
{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":1,"result":null,"stop_reason":null,"session_id":"s1"}
// thinking counter
{"type":"system","subtype":"thinking_tokens","estimated_tokens":183,"estimated_tokens_delta":133,"session_id":"s1"}
// noise (ignore): {"type":"rate_limit_event",...} {"type":"system","subtype":"status",...} {"type":"system","subtype":"post_turn_summary",...}
```

---

### Task 1: StreamJsonClient

**Files:**
- Create: `src/main/runtime/acp/streamJson.ts`
- Test: `src/main/runtime/acp/streamJson.test.ts`

**Interfaces:**
- Consumes: `LineDecoder` (exported from `src/main/runtime/capabilities/jsonRpc.ts`).
- Produces: `class StreamJsonClient { constructor(command: string, args: string[], cwd?: string); onFrame(type: string, handler: (frame: Record<string, unknown>) => void): void; send(frame: object): void; onClose(handler: () => void): void; get isClosed(): boolean; close(): void }`. One handler per frame type (last registration wins). `onClose` is idempotent-once semantics identical to `JsonRpcClient` (fires immediately if already closed; error→close pair collapses to one firing).

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/runtime/acp/streamJson.test.ts
import { describe, it, expect } from 'vitest'
import { StreamJsonClient } from './streamJson'

describe('StreamJsonClient', () => {
  it('dispatches typed frames by exact type match', async () => {
    // Child prints two frames then exits — handler must see only its type.
    const script = `process.stdout.write(JSON.stringify({type:'a',v:1})+'\\n'+JSON.stringify({type:'b',v:2})+'\\n')`
    const client = new StreamJsonClient(process.execPath, ['-e', script])
    const got = await new Promise<Record<string, unknown>>((resolve) => client.onFrame('b', resolve))
    expect(got.v).toBe(2)
    expect(client.isClosed === false || client.isClosed === true).toBe(true) // no throw path
  })

  it('ignores non-JSON lines and frames without a string type', async () => {
    const script = `process.stdout.write('not json\\n{"v":1}\\n'+JSON.stringify({type:'ok'})+'\\n')`
    const client = new StreamJsonClient(process.execPath, ['-e', script])
    const got = await new Promise<Record<string, unknown>>((resolve) => client.onFrame('ok', resolve))
    expect(got.type).toBe('ok')
  })

  it('fires onClose once on exit, immediately for late registration, and marks isClosed', async () => {
    const client = new StreamJsonClient(process.execPath, ['-e', 'process.exit(0)'])
    let fires = 0
    await new Promise<void>((resolve) => client.onClose(() => { fires++; resolve() }))
    await new Promise((r) => setTimeout(r, 50))
    expect(fires).toBe(1)
    expect(client.isClosed).toBe(true)
    const late = await new Promise<boolean>((resolve) => client.onClose(() => resolve(true)))
    expect(late).toBe(true)
  })

  it('collapses spawn-failure error→close to one firing', async () => {
    const client = new StreamJsonClient('definitely-not-a-real-binary-xyz', [])
    let fires = 0
    await new Promise<void>((resolve) => client.onClose(() => { fires++; resolve() }))
    await new Promise((r) => setTimeout(r, 50))
    expect(fires).toBe(1)
    expect(client.isClosed).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/main/runtime/acp/streamJson.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/main/runtime/acp/streamJson.ts
import { spawn, type ChildProcess } from 'child_process'
import { LineDecoder } from '../capabilities/jsonRpc'

// Newline-delimited TYPED frames (claude stream-json). Not JSON-RPC: no id/method envelope, so no
// request/response correlation lives here — control_request/control_response matching is the
// session's job. Close semantics mirror JsonRpcClient (b9e618b/700b170): idempotent, late
// registration fires immediately, error→close collapses to one firing.
export class StreamJsonClient {
  private child: ChildProcess
  private lines = new LineDecoder()
  private frameHandlers = new Map<string, (frame: Record<string, unknown>) => void>()
  private closeHandlers: Array<() => void> = []
  private closed = false

  constructor(command: string, args: string[], cwd?: string) {
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], ...(cwd ? { cwd } : {}) })
    this.child.stdout?.on('data', (chunk: Buffer) => {
      for (const line of this.lines.push(chunk)) {
        let frame: unknown
        try {
          frame = JSON.parse(line)
        } catch {
          continue
        }
        if (!frame || typeof frame !== 'object') continue
        const t = (frame as { type?: unknown }).type
        if (typeof t === 'string') this.frameHandlers.get(t)?.(frame as Record<string, unknown>)
      }
    })
    this.child.on('error', () => this.handleClose())
    this.child.on('close', () => this.handleClose())
  }

  private handleClose(): void {
    if (this.closed) return
    this.closed = true
    for (const h of this.closeHandlers) {
      try {
        h()
      } catch {
        // a broken close handler must not crash the transport
      }
    }
  }

  onFrame(type: string, handler: (frame: Record<string, unknown>) => void): void {
    this.frameHandlers.set(type, handler)
  }

  onClose(handler: () => void): void {
    if (this.closed) {
      try {
        handler()
      } catch {
        // a broken close handler must not crash the transport
      }
      return
    }
    this.closeHandlers.push(handler)
  }

  get isClosed(): boolean {
    return this.closed
  }

  send(frame: object): void {
    this.child.stdin?.write(JSON.stringify(frame) + '\n')
  }

  close(): void {
    this.child.kill()
  }
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/main/runtime/acp/streamJson.test.ts` → PASS (4 tests). Then `npm run typecheck`.

- [ ] **Step 5: Commit** — `git add src/main/runtime/acp/streamJson.ts src/main/runtime/acp/streamJson.test.ts && git commit -m "feat(claude): StreamJsonClient — typed newline frames with pillar-2 close semantics"`

---

### Task 2: pure claude mappers + research doc

**Files:**
- Create: `src/main/runtime/acp/mapClaude.ts`
- Create: `docs/research/claude-stream-json-2.1.181.txt` (paste the "Captured frames" section of this plan verbatim, one frame per line, with a two-line header noting date + CLI version)
- Test: `src/main/runtime/acp/mapClaude.test.ts`

**Interfaces:**
- Consumes: `AgentEvent`, `PermissionOption` from `src/shared/runtime.ts`.
- Produces (exact signatures — Task 3 depends on them):
  - `claudeSessionArgs(o: { yolo: boolean; model?: string; effort?: string; sessionId?: string }): string[]`
  - `mapClaudeStreamEvent(runId: string, frame: Record<string, unknown>): AgentEvent[]` (text deltas + message_start usage)
  - `mapClaudeAssistant(runId: string, frame: Record<string, unknown>): AgentEvent[]` (tool_use → running rows)
  - `mapClaudeToolResult(runId: string, frame: Record<string, unknown>): AgentEvent[]` (user frame tool_result → completion)
  - `mapClaudeCanUseTool(runId: string, requestId: string, request: Record<string, unknown>): { event: Extract<AgentEvent, { type: 'permission.requested' }>; responses: Record<string, unknown> } | null`
  - `mapClaudeThinking(runId: string, frame: Record<string, unknown>): AgentEvent[]`
  - `mapClaudeResult(frame: Record<string, unknown>, interrupted: boolean): { kind: 'completed'; stopReason: 'end_turn' | 'canceled'; usage: { inputTokens: number; outputTokens: number; costUsd?: number }; contextUsedTokens?: number } | { kind: 'errored'; message: string }`
  - `THINKING_ROW_ID = 'thinking_'` prefix constant.

- [ ] **Step 1: Write the failing tests** (fixtures verbatim from the frames section)

```ts
// src/main/runtime/acp/mapClaude.test.ts
import { describe, it, expect } from 'vitest'
import { claudeSessionArgs, mapClaudeStreamEvent, mapClaudeAssistant, mapClaudeToolResult, mapClaudeCanUseTool, mapClaudeThinking, mapClaudeResult } from './mapClaude'

describe('claudeSessionArgs', () => {
  it('builds the exact spawn args, flags only when set', () => {
    expect(claudeSessionArgs({ yolo: false })).toEqual([
      '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--allow-dangerously-skip-permissions'
    ])
    expect(claudeSessionArgs({ yolo: true, model: 'claude-opus-4-8', effort: 'high', sessionId: 'sid1' })).toEqual([
      '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--allow-dangerously-skip-permissions',
      '--model', 'claude-opus-4-8', '--effort', 'high', '--resume', 'sid1'
    ])
  })
})

describe('mapClaudeStreamEvent', () => {
  it('maps text_delta to content.delta and ignores other SSE noise', () => {
    const frame = { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ello pillar three' } } }
    expect(mapClaudeStreamEvent('r', frame)).toEqual([{ type: 'content.delta', runId: 'r', streamKind: 'assistant_text', text: 'ello pillar three' }])
    expect(mapClaudeStreamEvent('r', { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })).toEqual([])
    expect(mapClaudeStreamEvent('r', { type: 'stream_event' })).toEqual([])
  })
  it('maps message_start usage to usage.updated with context = input + cache tokens', () => {
    const frame = { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 4133, cache_creation_input_tokens: 2049, cache_read_input_tokens: 15626, output_tokens: 3 } } } }
    const [e] = mapClaudeStreamEvent('r', frame)
    expect(e).toMatchObject({ type: 'usage.updated', runId: 'r', inputTokens: 4133, outputTokens: 3, contextUsedTokens: 4133 + 2049 + 15626 })
  })
})

describe('mapClaudeAssistant / mapClaudeToolResult', () => {
  it('maps Bash tool_use to an execute row titled by the command, Write to an edit row', () => {
    const bash = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: "echo 'x' > f.txt", description: 'd' } }] } }
    expect(mapClaudeAssistant('r', bash)).toEqual([{ type: 'tool.updated', runId: 'r', toolCallId: 't1', title: "echo 'x' > f.txt", kind: 'execute', status: 'running' }])
    const write = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: '/tmp/a.txt', content: 'y' } }] } }
    expect(mapClaudeAssistant('r', write)).toEqual([{ type: 'tool.updated', runId: 'r', toolCallId: 't2', title: 'Edit /tmp/a.txt', kind: 'edit', status: 'running' }])
    expect(mapClaudeAssistant('r', { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })).toEqual([])
  })
  it('completes rows from tool_result; is_error → failed; string content → detail', () => {
    const frame = { type: 'user', message: { content: [{ type: 'tool_result', content: 'blocked', is_error: true, tool_use_id: 't1' }] } }
    expect(mapClaudeToolResult('r', frame)).toEqual([{ type: 'tool.updated', runId: 'r', toolCallId: 't1', title: '', status: 'failed', detail: 'blocked' }])
    const ok = { type: 'user', message: { content: [{ type: 'tool_result', content: 'done', is_error: false, tool_use_id: 't2' }] } }
    expect(mapClaudeToolResult('r', ok)[0]).toMatchObject({ status: 'completed', detail: 'done' })
    expect(mapClaudeToolResult('r', { type: 'user', message: { content: [{ type: 'text', text: 'x' }] } })).toEqual([])
  })
})

describe('mapClaudeCanUseTool', () => {
  const request = {
    subtype: 'can_use_tool', tool_name: 'Write', display_name: 'Write',
    input: { file_path: '/tmp/y.txt', content: 'y' }, description: 'y.txt',
    permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }], tool_use_id: 'tu1'
  }
  it('builds allow / verbatim-suggestion / deny options with verbatim response payloads', () => {
    const m = mapClaudeCanUseTool('r', 'req1', request)!
    expect(m.event.options.map((o) => o.kind)).toEqual(['allow', 'allow_always', 'deny'])
    expect(m.event.title).toBe('Write')
    expect(m.event.detail).toBe('y.txt')
    expect(m.responses[m.event.options[0].id]).toEqual({ behavior: 'allow', updatedInput: request.input })
    expect(m.responses[m.event.options[1].id]).toEqual({ behavior: 'allow', updatedInput: request.input, updatedPermissions: [request.permission_suggestions[0]] })
    expect(m.event.options[1].label).toBe('Allow edits for session')
    expect(m.responses[m.event.options[2].id]).toEqual({ behavior: 'deny', message: 'Denied via NAC Code' })
  })
  it('returns null on junk', () => {
    expect(mapClaudeCanUseTool('r', 'x', {})).toBeNull()
  })
})

describe('mapClaudeThinking', () => {
  it('renders a running Thinking row keyed to the run', () => {
    const [e] = mapClaudeThinking('r', { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 183 })
    expect(e).toMatchObject({ type: 'tool.updated', toolCallId: 'thinking_r', title: 'Thinking…', kind: 'reasoning', status: 'running', detail: '~183 tokens' })
  })
})

describe('mapClaudeResult', () => {
  const success = { type: 'result', subtype: 'success', is_error: false, result: 'ok', stop_reason: 'end_turn', total_cost_usd: 0.0946805, usage: { input_tokens: 4481, cache_creation_input_tokens: 2100, cache_read_input_tokens: 15700, output_tokens: 50 } }
  it('success → completed end_turn with real usage + cost + context', () => {
    const r = mapClaudeResult(success, false)
    expect(r).toMatchObject({ kind: 'completed', stopReason: 'end_turn', usage: { inputTokens: 4481, outputTokens: 50, costUsd: 0.0946805 }, contextUsedTokens: 4481 + 2100 + 15700 })
  })
  it('error_during_execution after OUR interrupt → canceled; without → errored', () => {
    const err = { type: 'result', subtype: 'error_during_execution', is_error: true, result: null }
    expect(mapClaudeResult(err, true)).toMatchObject({ kind: 'completed', stopReason: 'canceled' })
    expect(mapClaudeResult(err, false)).toMatchObject({ kind: 'errored' })
  })
})
```

- [ ] **Step 2: Verify failure**, **Step 3: Implement**

```ts
// src/main/runtime/acp/mapClaude.ts
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

interface Usage {
  input_tokens?: unknown
  cache_creation_input_tokens?: unknown
  cache_read_input_tokens?: unknown
  output_tokens?: unknown
}
const contextOf = (u: Usage): number => n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens)

export function mapClaudeStreamEvent(runId: string, frame: Record<string, unknown>): AgentEvent[] {
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
  return { title: arg ? `${b.name} ${arg}` : (b.name ?? 'tool') }
}

export function mapClaudeAssistant(runId: string, frame: Record<string, unknown>): AgentEvent[] {
  const content = (frame.message as { content?: ToolUseBlock[] } | undefined)?.content ?? []
  const out: AgentEvent[] = []
  for (const b of content) {
    if (b?.type !== 'tool_use' || !b.id) continue
    const { title, kind } = titleAndKind(b)
    out.push({ type: 'tool.updated', runId, toolCallId: b.id, title, ...(kind ? { kind } : {}), status: 'running' })
  }
  return out
}

export function mapClaudeToolResult(runId: string, frame: Record<string, unknown>): AgentEvent[] {
  const content = (frame.message as { content?: { type?: string; content?: unknown; is_error?: unknown; tool_use_id?: unknown }[] } | undefined)?.content ?? []
  const out: AgentEvent[] = []
  for (const b of content) {
    if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
    const detail = s(b.content)
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
```

- [ ] **Step 4: Verify pass** — `npx vitest run src/main/runtime/acp/mapClaude.test.ts` → PASS. `npm run typecheck`.
- [ ] **Step 5: Write `docs/research/claude-stream-json-2.1.181.txt`** (frames from this plan's fixture section, one per line, header: `claude 2.1.181 stream-json frames, live-captured 2026-07-09`).
- [ ] **Step 6: Commit** — `git add src/main/runtime/acp/mapClaude.ts src/main/runtime/acp/mapClaude.test.ts docs/research/claude-stream-json-2.1.181.txt && git commit -m "feat(claude): pure stream-json mappers from captured fixtures"`

---

### Task 3: ClaudeSession

**Files:**
- Create: `src/main/runtime/acp/claudeSession.ts`
- Test: `src/main/runtime/acp/claudeSession.test.ts`

**Interfaces:**
- Consumes: `StreamJsonClient` (Task 1), all Task 2 mappers, `acpCwd`, `pickAutoApprove`, `shouldAutoCancelPermission`, `PROMPT_TIMEOUT_MS`, `TransportSession`, `PromptOpts` from `./acpSession`.
- Produces: `class ClaudeSession implements TransportSession { constructor(onEvent: (e: AgentEvent) => void, yolo: boolean, opts?: PromptOpts); connect(cwd: string | undefined, existingSessionId: string | undefined): Promise<string>; ... }` — the manager treats it exactly like the other two. Also exported for tests: `RESUME_VERIFY_MS = 2000`.

**Design notes the implementer must respect:**
- claude has NO handshake: `connect` spawns the child (args from `claudeSessionArgs({ yolo: false, model: opts?.model, effort: opts?.effort, sessionId: existingSessionId })` — spawn always in non-bypass mode; YOLO is applied via `set_permission_mode` in `prompt()` so toggling stays live). `cwd` = `acpCwd(cwd)` passed to the StreamJsonClient constructor (claude's working dir is the process cwd).
- Resume verification: when `existingSessionId` is set, `connect` waits `RESUME_VERIFY_MS` racing a timer vs `onClose`; if the child closed in the window (bogus/expired session exits in ~1.3s with code 1 — verified), THROW (→ one-shot fallback keeps context). Fresh sessions resolve immediately with `''` (the real id arrives on the first `system/init` frame → `run.started` + internal capture).
- `prompt(runId, text, opts)`: if `opts.model/effort` differ from the SPAWNED values AND a sessionId is known → internal respawn: `this.client.close()`, new `StreamJsonClient` with `claudeSessionArgs({ ..., sessionId })`, re-register all frame handlers (factor a private `attach(client)` method), then proceed. Then: apply YOLO if pending (`set_permission_mode` — send `{"type":"control_request","request_id":"mode_<n>","request":{"subtype":"set_permission_mode","mode": yolo ? 'bypassPermissions' : 'default'}}` only when the mode CHANGED since last applied), emit `run.started` (sessionId = last known or ''), arm the inactivity watchdog, write the user frame `{"type":"user","message":{"role":"user","content":[{"type":"text","text":text}]}}`.
- Frame handlers (registered in `attach`): `system` (subtype init → capture session_id + emit `run.started` once per turn if not yet emitted... — emit `run.started` in `prompt()` with the KNOWN id and update via a second `run.started`? NO: emit `run.started` from the `system/init` frame when the captured id CHANGED or the turn hasn't announced yet; keep one `run.started` per run, carrying the freshest id — the renderer's `setSession` just records it) and subtype thinking_tokens → `mapClaudeThinking` (suppress when `replaying`); `stream_event` → `mapClaudeStreamEvent` (also: on the FIRST text delta or tool_use of the turn, if a thinking row was emitted, complete it: `{ type:'tool.updated', runId, toolCallId: thinking_<runId>, title:'Thinking…', kind:'reasoning', status:'completed' }`); `assistant` → `mapClaudeAssistant`; `user` → `mapClaudeToolResult`; `control_request` → if `request.subtype === 'can_use_tool'` handle approval (below), else ignore; `control_response` → ignore (mode acks); `result` → finishRun via `mapClaudeResult(frame, this.interrupted)`; every handler call re-arms the watchdog (inactivity semantics — rider 2).
- Approvals: `shouldAutoCancelPermission(this.replaying, this.currentRunId)` → immediate deny response. YOLO on → immediate allow (`responses.allow`). Otherwise emit the card and store `{ requestId → { client-request_id, responses, denyId: 'deny' } }`; `respondPermission(requestId, optionId)` sends `{"type":"control_response","response":{"subtype":"success","request_id":<claude's request_id>,"response": responses[optionId] ?? responses[denyId]}}` and emits `permission.resolved`. `expireApprovals()` BEFORE the terminal event (pillar-1 ordering) answers deny.
- `finishRun`: same shape as CodexSession (disarm watchdog, expireApprovals, emit `run.completed`/`run.errored`, clear per-turn state incl. `interrupted` and thinking-row flag). `usage.updated` context numbers also flow from `mapClaudeResult`'s `contextUsedTokens` (emit a final `usage.updated` before `run.completed` when present).
- `cancel()`: set `this.interrupted = true`, send `{"type":"control_request","request_id":"int_<n>","request":{"subtype":"interrupt"}}`.
- `onClose` → `finishRun({ kind: 'errored', message: 'claude exited mid-turn' })` when a run is active (parity with b9e618b).
- `busy` = currentRunId !== null; `dead` = client.isClosed; `dispose()` = disarm + expire + client.close().

- [ ] **Step 1: One-off probe (NOT committed): confirm `updatedPermissions` is accepted.** Run a scratch python/node script that spawns the exact args, sends a Write-triggering prompt, answers the `can_use_tool` with `{behavior:'allow', updatedInput, updatedPermissions:[<the suggestion verbatim>]}`, then triggers a SECOND edit and asserts no second `can_use_tool` arrives (acceptEdits took effect). If the response errors, remove `updatedPermissions` from `mapClaudeCanUseTool`'s suggestion responses and DROP the suggestion options (fall back to allow/deny only) — update the Task 2 test accordingly and note it in the commit message. Record the outcome in the progress ledger.
- [ ] **Step 2: Write the failing tests** — pure surface only (lifecycle is live-verified in Task 6):

```ts
// src/main/runtime/acp/claudeSession.test.ts
import { describe, it, expect } from 'vitest'
import { RESUME_VERIFY_MS, needsRespawn } from './claudeSession'
import { PROMPT_TIMEOUT_MS } from './acpSession'

describe('ClaudeSession constants + respawn predicate', () => {
  it('verifies resume inside a window well under the prompt ceiling', () => {
    expect(RESUME_VERIFY_MS).toBe(2000)
    expect(RESUME_VERIFY_MS).toBeLessThan(PROMPT_TIMEOUT_MS)
  })
  it('needsRespawn: only when a known session exists and model/effort actually changed', () => {
    expect(needsRespawn({ model: 'a', effort: 'high' }, { model: 'a', effort: 'high' }, 'sid')).toBe(false)
    expect(needsRespawn({ model: 'a' }, { model: 'b' }, 'sid')).toBe(true)
    expect(needsRespawn({ model: 'a' }, { model: 'b' }, null)).toBe(false) // no session to resume — never respawn mid-air
    expect(needsRespawn({}, {}, 'sid')).toBe(false)
    expect(needsRespawn({ effort: 'high' }, {}, 'sid')).toBe(false) // requested field undefined = no preference
  })
})
```

`needsRespawn(spawned: PromptOpts, requested: PromptOpts, sessionId: string | null): boolean` is an exported pure helper: `sessionId !== null && ((requested.model ?? undefined) !== (spawned.model ?? undefined) || (requested.effort ?? undefined) !== (spawned.effort ?? undefined))` — with the wrinkle that `requested.model === undefined` means "no preference" and must NOT force a respawn: compare only fields that are defined on `requested`.

- [ ] **Step 3: Verify failure**, **Step 4: Implement `claudeSession.ts`** per the design notes (single file, mirrors `codexSession.ts` structure: constructor stores sink/yolo/opts, `attach(client)` registers handlers, `connect` spawns + resume-verifies, `prompt` respawns-if-needed + mode-syncs + user frame, `finishRun` idempotent). Reuse `PROMPT_TIMEOUT_MS` as the inactivity ceiling; `private touchWatchdog()` re-arms on every frame.
- [ ] **Step 5: Verify pass** — targeted file then `npx vitest run` full + `npm run typecheck`.
- [ ] **Step 6: Commit** — `git commit -m "feat(claude): ClaudeSession — stream-json transport behind the TransportSession seam"`

---

### Task 4: manager factory + ipc routing + codex inactivity rider

**Files:**
- Modify: `src/main/runtime/acp/sessionManager.ts` (provider union + factory)
- Modify: `src/main/runtime/ipc.ts` (claude joins the interactive guard)
- Modify: `src/main/runtime/acp/codexSession.ts` (watchdog re-arms on every notification — rider 2)
- Test: `src/main/runtime/acp/codexSession.test.ts` (extend)

**Interfaces:**
- Consumes: `ClaudeSession` (Task 3).
- Produces: `promptViaTransport` accepts `provider: 'copilot' | 'codex' | 'claude'`; Entry.provider widens the same way.

- [ ] **Step 1: sessionManager** — widen the union in `promptViaTransport` opts and `Entry.provider` to `'copilot' | 'codex' | 'claude'`; factory line becomes:

```ts
const session: TransportSession & { connect(cwd: string | undefined, id: string | undefined): Promise<string> } =
  opts.provider === 'codex'
    ? new CodexSession(sink, opts.yolo === true)
    : opts.provider === 'claude'
      ? new ClaudeSession(sink, opts.yolo === true, { model: opts.model, effort: opts.effort })
      : new AcpSession(sink, opts.yolo === true)
```

- [ ] **Step 2: ipc.ts** — the interactive guard becomes `req.provider === 'copilot' || req.provider === 'codex' || req.provider === 'claude'`; the fallback ternary gains the claude case dispatching the EXISTING one-shot:

```ts
req.provider === 'codex'
  ? startCodexRun(runId, { prompt: req.prompt, cwd: req.cwd, yolo: req.yolo, sessionId: req.sessionId, effort: req.effort, model: req.model }, handler)
  : req.provider === 'claude'
    ? startClaudeRun(runId, { prompt: req.prompt, sessionId: req.sessionId, cwd: req.cwd, yolo: req.yolo, model: req.model, effort: req.effort, fast: req.fast }, handler)
    : startCopilotRun(runId, { prompt: req.prompt, cwd: req.cwd, yolo: req.yolo, sessionId: req.sessionId, effort: req.effort, model: req.model }, handler)
```

Remove `claude` from the lower one-shot dispatch (it is now unreachable there for provider 'claude' — the lower block keeps opencode + stub only). Ledger gate: NO change (`ledgerModel` already excludes only copilot; claude verdicts stay live). NOTE: `req.fast` (fast mode) is a one-shot-only flag today — the interactive path ignores it this pillar; the fallback path still honors it (rider for a later pass; do not invent a stream-json fast-mode mechanism).
- [ ] **Step 3: codex inactivity watchdog (rider 2)** — in `codexSession.ts`, add `private touchWatchdog(): void { if (this.currentRunId) this.armWatchdog(this.currentRunId) }` and call it at the top of the four `onNotification` handlers (`item/started`, `item/completed`, `item/agentMessage/delta`, `thread/tokenUsage/updated`). Update the header comment: the watchdog now measures SILENCE, not turn duration. Extend `codexSession.test.ts` with a comment-anchored assertion that `TURN_WATCHDOG_MS === PROMPT_TIMEOUT_MS` still holds (ceiling unchanged).
- [ ] **Step 4: Full gate** — `npx vitest run && npm run typecheck && npm run build`.
- [ ] **Step 5: Commit** — `git commit -m "feat(claude): interactive-first routing; codex watchdog measures inactivity"`

---

### Task 5: renderer — real cost row + contextLive fallback rider

**Files:**
- Modify: `src/renderer/src/components/Inspector.tsx:139` (cost line)
- Modify: `src/renderer/src/store/store.ts` (`endTurn` flips `contextLive` off when the turn carries a fallback notice row)
- Test: `src/renderer/src/store/store.test.ts`, `src/renderer/src/data/providers.test.ts` untouched; cost formatting test lives in `store.test.ts` only if a helper is added — otherwise Inspector change is presentational and covered by the live matrix.

- [ ] **Step 1: Failing test — endTurn contextLive rider**

```ts
// append to src/renderer/src/store/store.test.ts
it('endTurn drops contextLive when the turn fell back to one-shot (fallback notice row)', () => {
  const s = useApp.getState()
  const id = s.activeChatId
  s.setLiveContext(id, 42000, 200000)
  expect(useApp.getState().chats[id].contextLive).toBe(true)
  s.pushTurn(id, { id: 'a20', role: 'assistant', text: '', streaming: true })
  s.upsertTool(id, { toolCallId: 'fallback_run9', title: 'interactive session unavailable — ran headless', kind: 'notice', status: 'failed' })
  s.endTurn(id)
  expect(useApp.getState().chats[id].contextLive).toBe(false) // stale live numbers get the ~ back
})

it('endTurn keeps contextLive on a normal interactive turn', () => {
  const s = useApp.getState()
  const id = s.activeChatId
  s.setLiveContext(id, 42000, 200000)
  s.pushTurn(id, { id: 'a21', role: 'assistant', text: 'done', streaming: true })
  s.endTurn(id)
  expect(useApp.getState().chats[id].contextLive).toBe(true)
})
```

- [ ] **Step 2: Verify failure**, **Step 3: Implement** — in `endTurn` (store.ts), after computing `messages`, detect the notice: the LAST message's tools (post-sweep) contain a `toolCallId` starting with `'fallback_'`. Return `{ chats: { ...s.chats, [chatId]: { ...c, messages, ...(fellBack ? { contextLive: false } : {}) } } }`:

```ts
endTurn: (chatId, error) =>
  set((s) => {
    const c = s.chats[chatId]
    if (!c) return {}
    // Interrupted/errored turns can leave tool rows mid-flight (codex turn/interrupt never
    // completes the open item) — same doctrine as the hydration sanitizer: nothing stays
    // live-looking once the run is over.
    const messages = updateLast(c.messages, (t) => ({
      ...t,
      streaming: false,
      error: Boolean(error),
      text: error ? `${t.text}\n[error] ${error}` : t.text,
      tools: t.tools?.map((x) => (x.status === 'pending' || x.status === 'running' ? { ...x, status: 'failed' as const } : x))
    }))
    // A fallback turn ran one-shot: no usage.updated arrived, so the last live context number is
    // stale — demote it to an estimate (the ~ returns) until the transport recovers.
    const fellBack = messages.at(-1)?.tools?.some((x) => x.toolCallId.startsWith('fallback_')) === true
    return { chats: { ...s.chats, [chatId]: { ...c, messages, ...(fellBack ? { contextLive: false } : {}) } } }
  }),
```

- [ ] **Step 4: Inspector real cost** — replace line 139's constant with accumulated real cost when present:

```ts
// Inspector.tsx — replace: return provider === 'opencode' ? 'free · local' : '$0.42'
// with (costFor receives the active chat):
function costFor(chat: Chat): string {
  if (chat.provider === 'opencode') return 'free · local'
  const real = Object.values(chat.usage).reduce((sum, u) => sum + (u.costUsd ?? 0), 0)
  return real > 0 ? `$${real.toFixed(2)}` : '$0.42'
}
```

Adjust the call site to pass the chat (it currently passes only `provider` — rename the helper accordingly and keep the `~` semantics of neighboring rows untouched). `Chat` and its `usage` record are already imported/typed in the file's neighborhood; extend imports as needed.
- [ ] **Step 5: Verify pass** — `npx vitest run src/renderer/src/store/store.test.ts` then full gate.
- [ ] **Step 6: Commit** — `git commit -m "feat(claude): real cost row when available; fallback demotes contextLive (rider 1)"`

---

### Task 6: live verification (controller, computer use) + docs + final review

**Files:**
- Modify: `docs/DECISIONS.md`

- [ ] **Step 1: Live matrix** (worktree dev app, a claude chat, scratch-safe prompts; controller drives via computer use):
  1. Approve: YOLO OFF, ask for a file write → card shows "Allow once / Allow edits for session / Deny" (claude's own suggestion) → Allow once → tool row ✓ → reply streams token-by-token.
  2. Suggestion option: trigger a second write → choose "Allow edits for session" → a THIRD write runs with no card.
  3. Deny → row ✗, file not created, turn continues gracefully.
  4. YOLO toggle mid-chat → no card on next write; toggle off → card returns (no respawn either way — same PID).
  5. Stop mid-turn → interrupt → run ends canceled, open rows swept ✗.
  6. Continuity: bare follow-up recalls turn 1 (no replay block).
  7. Restart revival: plant codeword → quit app → relaunch → recall (--resume). No transcript double-append.
  8. Model-switch respawn: switch claude model mid-chat → next turn honors it (verify via Inspector/model chip + reply) with context intact.
  9. Fallback: PATH-shadow `claude` (fail only when args include `--input-format`; pass through otherwise — mirrors the pillar-2 shim) → notice row + one-shot completes → `~` returns on the context row (rider 1 visible) → unshadow → next send recovers interactive.
  10. Inspector: context row live (no `~`) during interactive claude turns; REAL cost accumulates on the cost row; thinking row appears then collapses.
- [ ] **Step 2: Final gate** — `npm run typecheck && npx vitest run && npm run build`.
- [ ] **Step 3: DECISIONS entry** at the top of Current phase (replace `<commit>`):

```markdown
**✅ Interactive run transport — pillar 3, claude stream-json** (`<commit>`): claude runs are INTERACTIVE — token streaming via stream_event deltas, permission cards built from claude's own can_use_tool requests INCLUDING its permission_suggestions ("Allow edits for session" = setMode acceptEdits echoed back verbatim via updatedPermissions), tool rows from tool_use/tool_result blocks, Stop = control_request interrupt (error_during_execution signature → canceled), YOLO = live set_permission_mode (spawn carries --allow-dangerously-skip-permissions; no respawn). Long-lived `claude --print --input/output-format stream-json --permission-prompt-tool stdio` child per chat behind the same TransportSession seam via a new StreamJsonClient (typed frames — claude is NOT JSON-RPC). Revival: --resume verified fast-fail (~1.3s) on bogus ids → connect races a 2s window and THROWS into the one-shot fallback (context doctrine). Model/effort are spawn-bound: mid-chat changes respawn-with-resume transparently. NEW surfaces: REAL cost (result.total_cost_usd → Inspector cost row) and live context metering (message_start/result usage → usage.updated). Riders landed: fallback turns demote contextLive (the ~ honesty marker returns), and BOTH claude + codex watchdogs now measure inactivity, not turn duration. Verified live (computer-use matrix): approve / suggestion-escalation / deny / YOLO toggle / interrupt / continuity / restart revival / model-switch respawn / fallback + recovery / real cost + live context + thinking row. Spec: `docs/superpowers/specs/2026-07-09-interactive-transport-pillar3-claude-design.md`.
```

Also update the roadmap pillar list (pillar 3 ✅; pillar 4 opencode next) in the same edit.
- [ ] **Step 4: Commit** — `git add docs/DECISIONS.md && git commit -m "docs: interactive transport pillar 3 done — claude stream-json verified live"`

Then: final whole-branch review (most capable model) with a review package from the branch base, one fix subagent for findings, re-review, `superpowers:finishing-a-development-branch`.
