# Interactive Transport Pillar 4 — opencode ACP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** opencode runs become interactive behind the `TransportSession` seam via a provider-profiled `AcpSession` — streaming, tool rows, cancel, revival, live per-session model switching (hosted ↔ LM Studio local), native context/window/cost metering — plus three riders from the pillar-3 review. Final transport pillar.

**Architecture:** opencode is a protocol twin of copilot (standard ACP over `opencode acp`), so `AcpSession` gains a small constructor profile instead of a fourth class. Pure mapper extensions handle opencode-only update kinds; the session adds model-config, cancel-intent, and empty-turn bookkeeping. Manager/ipc widen to four providers.

**Tech Stack:** Electron main (Node child_process via existing JsonRpcClient), TypeScript, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-09-interactive-transport-pillar4-opencode-design.md` (all protocol facts live-verified on opencode 1.17.11, 2026-07-09).

## Global Constraints

- Wrapper, never a harness; ONE canonical `AgentEvent` union — no new event types this pillar.
- Replay invariant: tool/permission/notice rows are render-only; never `content.delta` for notices; `buildReplayPrompt` reads only `turn.text`.
- Context-preservation doctrine: `session/load` failure THROWS (existing pillar-1 code) → one-shot fallback (`startOpenCodeRun` with sessionId).
- Model config: `session/set_config_option {sessionId, configId:'model', value}` (param is `configId`; `configOptionId` is rejected -32602). Await the ack BEFORE `session/prompt`; on error proceed fail-open (harness keeps its current model).
- Cancel: the session sets an `interrupted` flag; ANY stopReason maps to `canceled` when set (probe showed opencode reports `end_turn` after cancel).
- Empty-turn (opencode only): completed turn with zero streamed text AND `usage.outputTokens === 0` AND not interrupted → render-only notice row `empty_<runId>`, kind `notice`, status `failed`, title exactly `model returned nothing — is the local model loaded?` BEFORE `run.completed`.
- usage_update mapping: `{used, size, cost}` → `usage.updated { contextUsedTokens: used, contextWindow: size, inputTokens: 0, outputTokens: 0 }`; latest `cost.amount` → `run.completed.usage.costUsd`.
- Copilot behavior must be bit-identical when the profile is copilot (default) — its tests must pass unchanged.
- All tests green + `npm run typecheck` clean before every commit. Work in a NEW worktree from current main; NEVER touch `/Users/nathanielfife/Code/nac-code` from implementers.

## Captured frames (fixtures — copy verbatim into tests)

```jsonc
// session/new result (trimmed)
{"sessionId":"ses_0b781c29cffeuHhwhwfFSxeRlQ","configOptions":[{"id":"model","name":"Model","category":"model","type":"select","currentValue":"opencode/big-pickle","options":[{"value":"lmstudio/qwen/qwen3-coder-30b","name":"LMStudio/Qwen3 Coder 30B"}]}]}
// streaming text
{"sessionUpdate":"agent_message_chunk","messageId":"msg_1","content":{"type":"text","text":"Created"}}
// thought stream
{"sessionUpdate":"agent_thought_chunk","messageId":"msg_2","content":{"type":"text","text":"The user wants me"}}
// tool call (richer than copilot: rawInput + locations)
{"sessionUpdate":"tool_call","toolCallId":"call_c95bdab20b584813b28ef777","title":"write","kind":"edit","status":"pending","locations":[],"rawInput":{}}
{"sessionUpdate":"tool_call_update","toolCallId":"call_c95bdab20b584813b28ef777","status":"in_progress","kind":"edit","title":"write","locations":[{"path":"/tmp/p4/p4-check.txt"}],"rawInput":{"content":"okra","filePath":"/tmp/p4/p4-check.txt"}}
// live context + cost
{"sessionUpdate":"usage_update","used":11524,"size":200000,"cost":{"amount":0,"currency":"USD"}}
// ignore
{"sessionUpdate":"available_commands_update","availableCommands":[]}
// session/prompt result
{"stopReason":"end_turn","usage":{"inputTokens":196,"outputTokens":15,"totalTokens":11552,"thoughtTokens":13,"cachedReadTokens":11328}}
// set_config_option: request params {"sessionId":"ses_x","configId":"model","value":"lmstudio/qwen/qwen3-coder-30b"} → result carries updated configOptions (currentValue flipped)
```

Note: opencode's `tool_call_update` uses status `in_progress` — NOT in copilot's observed set. `mapAcpUpdate`'s `TOOL_STATUSES` gate treats unknown statuses as `running` for `tool_call_update`, which is correct here; no change needed (Task 2 pins this with a fixture test).

---

### Task 1: riders — jsonRpc stdin hardening, claude array tool_result, FRESH_VERIFY_MS

**Files:**
- Modify: `src/main/runtime/capabilities/jsonRpc.ts` (constructor + `notify` + `answer`'s write)
- Modify: `src/main/runtime/acp/mapClaude.ts` (tool_result content extraction)
- Modify: `src/main/runtime/acp/claudeSession.ts` (`FRESH_VERIFY_MS` 500 → 1000)
- Test: `src/main/runtime/capabilities/jsonRpc.test.ts`, `src/main/runtime/acp/mapClaude.test.ts`, `src/main/runtime/acp/claudeSession.test.ts`

**Interfaces:** no signature changes; `FRESH_VERIFY_MS` value changes to 1000.

- [ ] **Step 1: Failing tests**

```ts
// append to the 'JsonRpcClient close handling' describe in jsonRpc.test.ts
it('notify() after the child exited is a no-op (no write attempt on a dead stdin)', async () => {
  const client = new JsonRpcClient(process.execPath, ['-e', 'process.exit(0)'])
  await new Promise<void>((resolve) => client.onClose(resolve))
  expect(() => client.notify('session/cancel', {})).not.toThrow()
  expect(client.isClosed).toBe(true)
})

it('registers a stdin error listener (EPIPE while alive must not crash main)', () => {
  const client = new JsonRpcClient(process.execPath, ['-e', 'setTimeout(()=>{},200)'])
  // @ts-expect-error private child access for the assertion
  expect(client.child.stdin.listenerCount('error')).toBeGreaterThan(0)
  client.close()
})
```

```ts
// append to the mapClaudeToolResult tests in mapClaude.test.ts
it('extracts detail from array-form tool_result content', () => {
  const frame = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't9', is_error: false, content: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }] }] } }
  expect(mapClaudeToolResult('r', frame)[0]).toMatchObject({ status: 'completed', detail: 'line one\nline two' })
})
```

```ts
// in claudeSession.test.ts, update the constants test:
expect(FRESH_VERIFY_MS).toBe(1000)
```

- [ ] **Step 2: Verify all three fail.**
- [ ] **Step 3: Implement.** jsonRpc.ts: in the constructor after spawn add `this.child.stdin?.on('error', () => { /* EPIPE on a dying child must not crash the transport */ })`; add a private `write(payload: string): void { if (this.closed) return; this.child.stdin?.write(payload + '\n') }` and route `notify`, `answer`'s `write`, and `request`'s trailing write through it. mapClaude.ts: in `mapClaudeToolResult`, replace `const detail = s(b.content)` with:

```ts
const detail = s(b.content) ?? (Array.isArray(b.content)
  ? (b.content as { type?: string; text?: unknown }[]).map((c) => (c?.type === 'text' ? s(c.text) : undefined)).filter(Boolean).join('\n') || undefined
  : undefined)
```

(widen the block type's `content?: unknown`). claudeSession.ts: `export const FRESH_VERIFY_MS = 1000` and update its doc comment (cold-start flag-rejection headroom; one-time cost at fresh connect).
- [ ] **Step 4: All three test files pass; `npx vitest run` full + `npm run typecheck` clean.**
- [ ] **Step 5: Commit** — `git commit -m "fix(riders): jsonRpc dead-stdin guards; claude array tool_result detail; FRESH_VERIFY_MS 1000"`

---

### Task 2: mapAcp opencode extensions (pure)

**Files:**
- Modify: `src/main/runtime/acp/mapAcp.ts`
- Create: `docs/research/opencode-acp-1.17.11.txt` (paste this plan's fixture block verbatim, one frame per line, header `opencode 1.17.11 ACP frames, live-captured 2026-07-09`)
- Test: `src/main/runtime/acp/mapAcp.test.ts`

**Interfaces:**
- `mapAcpUpdate(runId: string, update: unknown, provider?: 'copilot' | 'opencode')` — third param optional, default `'copilot'`; existing call sites stay valid.
- New export: `usageUpdateCost(update: unknown): number | null` — `cost.amount` when the update is a `usage_update` with a numeric amount, else null.
- New export: `THINKING_ROW_PREFIX = 'thinking_'` (same convention as pillar 3).

- [ ] **Step 1: Failing tests**

```ts
// append to mapAcp.test.ts
describe('opencode profile extensions', () => {
  it('maps usage_update to usage.updated with real window size (opencode only)', () => {
    const u = { sessionUpdate: 'usage_update', used: 11524, size: 200000, cost: { amount: 0, currency: 'USD' } }
    expect(mapAcpUpdate('r', u, 'opencode')).toEqual([{ type: 'usage.updated', runId: 'r', inputTokens: 0, outputTokens: 0, contextUsedTokens: 11524, contextWindow: 200000 }])
    expect(mapAcpUpdate('r', u)).toEqual([]) // copilot profile ignores it — bit-identical behavior
  })
  it('maps agent_thought_chunk to a running thinking row (opencode only)', () => {
    const u = { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'The user wants me' } }
    const [e] = mapAcpUpdate('r', u, 'opencode')
    expect(e).toMatchObject({ type: 'tool.updated', toolCallId: 'thinking_r', title: 'Thinking…', kind: 'reasoning', status: 'running' })
    expect(mapAcpUpdate('r', u)).toEqual([])
  })
  it('treats in_progress tool_call_update as running (fixture status not in the copilot set)', () => {
    const u = { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'in_progress', kind: 'edit', title: 'write', rawInput: { content: 'okra', filePath: '/tmp/x' } }
    expect(mapAcpUpdate('r', u, 'opencode')[0]).toMatchObject({ status: 'running', title: 'write' })
  })
  it('usageUpdateCost extracts cost.amount, null otherwise', () => {
    expect(usageUpdateCost({ sessionUpdate: 'usage_update', used: 1, size: 2, cost: { amount: 0.12, currency: 'USD' } })).toBe(0.12)
    expect(usageUpdateCost({ sessionUpdate: 'usage_update', used: 1, size: 2 })).toBeNull()
    expect(usageUpdateCost({ sessionUpdate: 'agent_message_chunk' })).toBeNull()
    expect(usageUpdateCost(null)).toBeNull()
  })
  it('ignores available_commands_update in both profiles', () => {
    expect(mapAcpUpdate('r', { sessionUpdate: 'available_commands_update', availableCommands: [] }, 'opencode')).toEqual([])
  })
})
```

- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement** in mapAcp.ts:

```ts
export const THINKING_ROW_PREFIX = 'thinking_'

export function usageUpdateCost(update: unknown): number | null {
  const u = update as { sessionUpdate?: string; cost?: { amount?: unknown } } | null
  if (!u || u.sessionUpdate !== 'usage_update') return null
  return typeof u.cost?.amount === 'number' ? u.cost.amount : null
}
```

Extend `mapAcpUpdate(runId, update, provider: 'copilot' | 'opencode' = 'copilot')`; before the existing switch's default, add opencode-gated cases:

```ts
case 'usage_update': {
  if (provider !== 'opencode') return []
  const used = typeof (u as { used?: unknown }).used === 'number' ? (u as { used: number }).used : 0
  const size = typeof (u as { size?: unknown }).size === 'number' ? (u as { size: number }).size : undefined
  return used > 0 ? [{ type: 'usage.updated', runId, inputTokens: 0, outputTokens: 0, contextUsedTokens: used, ...(size ? { contextWindow: size } : {}) }] : []
}
case 'agent_thought_chunk': {
  if (provider !== 'opencode') return []
  return [{ type: 'tool.updated', runId, toolCallId: `${THINKING_ROW_PREFIX}${runId}`, title: 'Thinking…', kind: 'reasoning', status: 'running' }]
}
```

(the `AcpUpdate` interface gains `used?: unknown; size?: unknown; cost?: { amount?: unknown }` as needed for typing).
- [ ] **Step 4: Pass + full suite + typecheck.**
- [ ] **Step 5: Write the research doc, then commit** — `git commit -m "feat(opencode): mapAcp opencode profile extensions from captured fixtures"`

---

### Task 3: AcpSession provider profile

**Files:**
- Modify: `src/main/runtime/acp/acpSession.ts`
- Test: `src/main/runtime/acp/acpSession.test.ts`

**Interfaces:**
- New export: `interface AcpProfile { provider: 'copilot' | 'opencode'; command: string; args: string[] }`
- New exports: `COPILOT_PROFILE: AcpProfile = { provider: 'copilot', command: 'copilot', args: ['--acp'] }`, `OPENCODE_PROFILE: AcpProfile = { provider: 'opencode', command: 'opencode', args: ['acp'] }`
- `AcpSession` constructor: `(onEvent, yolo, profile: AcpProfile = COPILOT_PROFILE)`.
- New pure export for tests: `shouldEmitEmptyTurnNotice(provider: 'copilot' | 'opencode', hadText: boolean, outputTokens: number, interrupted: boolean): boolean` — true only for opencode, no text, zero output tokens, not interrupted.

**Design notes (the class changes, complete):**

1. Constructor: store `this.profile = profile`; spawn `new JsonRpcClient(profile.command, profile.args)`. The session/update handler becomes:

```ts
this.client.onNotification('session/update', (params) => {
  if (this.replaying || !this.currentRunId) return
  const update = (params as { update?: unknown } | null)?.update
  const cost = usageUpdateCost(update)
  if (cost !== null) this.turnCost = cost
  for (const e of mapAcpUpdate(this.currentRunId, update, this.profile.provider)) {
    if (e.type === 'content.delta') {
      this.turnHadText = true
      this.closeThinkingRow()
    } else if (e.type === 'tool.updated' && e.kind === 'reasoning') {
      this.thinkingOpen = true
    } else if (e.type === 'tool.updated') {
      this.closeThinkingRow()
    }
    this.onEvent(e)
  }
})
```

with per-turn fields `turnHadText = false`, `turnCost: number | null = null`, `thinkingOpen = false`, `interrupted = false`, `appliedModel: string | null = null`, and:

```ts
private closeThinkingRow(): void {
  if (!this.thinkingOpen || !this.currentRunId) return
  this.thinkingOpen = false
  this.onEvent({ type: 'tool.updated', runId: this.currentRunId, toolCallId: `${THINKING_ROW_PREFIX}${this.currentRunId}`, title: 'Thinking…', kind: 'reasoning', status: 'completed' })
}
```

2. `connect`: both the session/new and session/load results are read as `{ sessionId?, configOptions? }`; seed `this.appliedModel` from `configOptions?.find(o => o.id === 'model')?.currentValue` (string check). (session/load returns configOptions too — captured fixture.)

3. `prompt(runId, text, opts)` keeps its sync signature; body resets per-turn state, emits run.started, then `void this.runTurn(runId, text, opts)`:

```ts
private async runTurn(runId: string, text: string, opts?: PromptOpts): Promise<void> {
  try {
    if (this.profile.provider === 'opencode' && opts?.model && opts.model !== this.appliedModel) {
      try {
        await this.client.request('session/set_config_option', { sessionId: this.sessionId, configId: 'model', value: opts.model }, HANDSHAKE_TIMEOUT_MS)
        this.appliedModel = opts.model
      } catch {
        // fail-open: the harness keeps its current model; the ledger records real outcomes
      }
    }
    const res = await this.client.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] }, PROMPT_TIMEOUT_MS)
    const stop = (res as { stopReason?: string } | null)?.stopReason
    const u = (res as { usage?: { inputTokens?: number; outputTokens?: number } } | null)?.usage
    this.expirePermissions()
    this.closeThinkingRow()
    const outputTokens = typeof u?.outputTokens === 'number' ? u.outputTokens : 0
    if (shouldEmitEmptyTurnNotice(this.profile.provider, this.turnHadText, outputTokens, this.interrupted)) {
      this.onEvent({ type: 'tool.updated', runId, toolCallId: `empty_${runId}`, title: 'model returned nothing — is the local model loaded?', kind: 'notice', status: 'failed' })
    }
    const usage = this.profile.provider === 'opencode'
      ? { inputTokens: typeof u?.inputTokens === 'number' ? u.inputTokens : 0, outputTokens, ...(this.turnCost !== null ? { costUsd: this.turnCost } : {}) }
    : undefined
    this.onEvent({ type: 'run.completed', runId, stopReason: this.interrupted || stop === 'cancelled' ? 'canceled' : 'end_turn', ...(usage ? { usage } : {}) })
  } catch (e) {
    this.expirePermissions()
    this.onEvent({ type: 'run.errored', runId, message: (e as Error).message })
  } finally {
    this.currentRunId = null
  }
}
```

4. `cancel()` adds `this.interrupted = true` before the existing notify. `prompt` resets it to false at turn start.

- [ ] **Step 1: Failing tests** (append to acpSession.test.ts — it already tests the pure helpers):

```ts
import { shouldEmitEmptyTurnNotice, COPILOT_PROFILE, OPENCODE_PROFILE } from './acpSession'

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
```

- [ ] **Step 2: Verify failure. Step 3: Implement per the notes (complete code above). Step 4: full suite + typecheck (copilot tests MUST pass unchanged). Step 5: Commit** — `git commit -m "feat(opencode): AcpSession provider profile — model config, cancel intent, empty-turn notice"`

---

### Task 4: manager + ipc four-provider routing

**Files:**
- Modify: `src/main/runtime/acp/sessionManager.ts`
- Modify: `src/main/runtime/ipc.ts`

- [ ] **Step 1: sessionManager** — widen unions to `'copilot' | 'codex' | 'claude' | 'opencode'` (promptViaTransport opts + Entry.provider); factory:

```ts
opts.provider === 'codex'
  ? new CodexSession(sink, opts.yolo === true)
  : opts.provider === 'claude'
    ? new ClaudeSession(sink, opts.yolo === true, { model: opts.model, effort: opts.effort })
    : opts.provider === 'opencode'
      ? new AcpSession(sink, opts.yolo === true, OPENCODE_PROFILE)
      : new AcpSession(sink, opts.yolo === true)
```

Update the header comment (four providers). Import `OPENCODE_PROFILE` from './acpSession'.
- [ ] **Step 2: ipc.ts** — interactive guard: `req.provider === 'copilot' || req.provider === 'codex' || req.provider === 'claude' || req.provider === 'opencode'`; fallback ternary gains:

```ts
: req.provider === 'opencode'
  ? startOpenCodeRun(runId, { prompt: req.prompt, model: req.model, cwd: req.cwd, yolo: req.yolo, sessionId: req.sessionId, variant: req.effort }, handler)
```

Lower dispatch keeps ONLY the stub (`startOpenCodeRun` becomes unreachable there for provider 'opencode'; delete its case). Ledger gate unchanged.
- [ ] **Step 3: full suite + typecheck + `npm run build` clean. Step 4: Commit** — `git commit -m "feat(opencode): interactive-first routing — all four providers on the transport seam"`

---

### Task 5: live verification (controller, computer use) + docs + final review

**Files:**
- Modify: `docs/DECISIONS.md`

- [ ] **Step 1: Live matrix** (worktree dev app, a fresh opencode chat; controller drives via computer use — adversarial, not just happy-path):
  1. Hosted-default turn: streaming reply, thinking row appears/collapses, live context bar with REAL window size (200K from usage_update), tool row on a file write.
  2. **Local-model turn**: pick an LM Studio model that IS currently loaded (check `curl localhost:1234/v1/models` first) → real streamed reply from the local model.
  3. **Mid-chat hosted→local switch**: same session, context recalled after the switch (set_config_option path; same child PID).
  4. Permission behavior: attempt a write outside cwd / restrictive op — record whether opencode surfaces session/request_permission (card renders + approve/deny work) or auto-allows (note in DECISIONS).
  5. Stop mid-turn → run ends canceled (interrupted-flag mapping covers `end_turn`-after-cancel).
  6. Two-turn continuity + restart revival (quit app → relaunch → recall via session/load; no double-append).
  7. Fallback: PATH-shadow `opencode` (fail only when argv contains `acp`) → notice row + one-shot completes + `~` returns → unshadow → recovery to interactive.
  8. **Empty-turn notice**: select an lmstudio model that is NOT loaded → notice row "model returned nothing — is the local model loaded?" renders, no fake success.
  9. Cost row: hosted turn accumulates real dollars if nonzero; local shows honest $0.00 → footer/Inspector consistent.
  10. Copilot regression smoke: one interactive copilot turn (card or tool row + reply) — the shared class changed.
- [ ] **Step 2: Final gate** — `npm run typecheck && npx vitest run && npm run build`.
- [ ] **Step 3: DECISIONS entry** at the top of Current phase (replace `<commit>`) + roadmap update (pillar 4 ✅ — interactive transport milestone COMPLETE; next roadmap item #2 no-fake-pixels sweep):

```markdown
**✅ Interactive run transport — pillar 4, opencode ACP** (`<commit>`): opencode runs are INTERACTIVE — the LAST pillar; every provider now runs on the TransportSession seam. opencode speaks standard ACP (`opencode acp`), so pillar 1's AcpSession gained a provider PROFILE instead of a fourth class: shared streaming/tool-rows/permissions/cancel/revival, plus opencode-gated extras — usage_update drives the live context bar with the REAL window size and real cost, agent_thought_chunk renders the thinking row. HEADLINE: per-session model switching over ACP via session/set_config_option (configId 'model'), hosted ↔ LM Studio LOCAL models, live, no respawn — the SUPER-HARD local-model requirement's interactive leg. Cancel intent is remembered session-side (opencode reports end_turn after session/cancel). Fail-honest: a completed turn with zero text and zero output tokens (unloaded local model) renders a notice row instead of a fake success. Riders landed: JsonRpcClient dead-stdin guards (parity with streamJson), claude array-form tool_result detail, FRESH_VERIFY_MS→1000ms. Verified live (computer-use matrix): hosted + LOCAL turns / mid-chat hosted→local switch with context intact / permission behavior recorded / Stop / continuity / restart revival / fallback + recovery / empty-turn notice / real window+cost / copilot regression smoke. Spec: `docs/superpowers/specs/2026-07-09-interactive-transport-pillar4-opencode-design.md`.
```

- [ ] **Step 4: Commit** — `git add docs/DECISIONS.md && git commit -m "docs: interactive transport pillar 4 done — opencode ACP verified live; milestone complete"`

Then: final whole-branch review (most capable model) with a review package from the branch base, one fix subagent for findings, re-review, `superpowers:finishing-a-development-branch`.
