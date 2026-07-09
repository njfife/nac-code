# Interactive run transport — pillar 2: codex app-server

**Date:** 2026-07-09 · **Status:** approved design, pre-implementation
**Roadmap:** item 1 pillar 2 of the 2026-07-09 locked order. Reuses pillar 1's
`TransportSession` seam, canonical events, permission cards, tool rows, and fallback
ladder (spec: `2026-07-09-interactive-run-transport-design.md`, shipped in PR #3/#4).

## Problem

Codex runs are still one-shot headless: replies arrive as a single blob (no token
streaming), tool activity is flattened, approvals are impossible (YOLO or silently
sandboxed), cancel kills the process. Codex's app-server v2 protocol carries all of it —
richer than copilot's ACP — and the M4 discovery client already speaks its handshake.

## Decisions made during brainstorming (owner, 2026-07-09)

- **Real usage wiring (option: "Yes, wire it"):** `thread/tokenUsage/updated` feeds a
  new `usage.updated` canonical event → the chat's `contextK`/`windowK` become REAL for
  codex chats (Inspector context bar live), plus existing metering. Other providers keep
  estimates until their pillars.
- **Diff depth (option: "diff-in-tool-row"):** `fileChange` items render as tool rows
  whose expanded detail is the diff text. A dedicated diff pane is future work; the
  Changes view remains the deep-inspection surface.
- **Architecture (approach A):** per-chat `codex app-server` child behind the existing
  seam, mirroring pillar 1's AcpSession. The shared-daemon multi-thread shape (approach
  B) is a later optimization; full migration off the one-shot adapter (C) rejected —
  the fallback floor stays.

## Probed ground truth (2026-07-09, live `codex app-server` v0.142.3; frames in `docs/research/codex-turn-frames-0.142.3.txt`)

- **Handshake:** `initialize {clientInfo}` → `thread/start {}` → response
  `{thread: {id, sessionId, …}}` (id == sessionId == the same id `codex exec resume`
  accepts). `thread/resume {threadId}` revives a prior thread.
- **Turn:** `turn/start {threadId, input: [{type:'text', text}], cwd, approvalPolicy,
  sandboxPolicy, model?, effort?}` → response `{turn: {id, status: 'inProgress'}}`.
  `sandboxPolicy` is type-tagged: `{type: 'readOnly'|'workspaceWrite'|'dangerFullAccess'|
  'externalSandbox'}` (NOT `mode` — live-verified error `-32600 missing field type`).
  `approvalPolicy`: `'untrusted'|'on-failure'|'on-request'|'never'`. `model`/`effort`
  are per-turn overrides — **codex honors the picked model on the interactive path**
  (no copilot-style limitation; ledger hooks stay live for codex).
- **Streaming:** `item/agentMessage/delta {itemId, delta}` — real token deltas
  (live-verified word-by-word).
- **Items:** `item/started` / `item/completed` with typed `item`: `userMessage`,
  `reasoning` (summary/content often empty), `commandExecution` `{id, command
  ('/bin/zsh -lc …' wrapped), cwd, status, aggregatedOutput?}`, `agentMessage`
  `{text, phase}`, `fileChange` (+ `turn/diff/updated` unified diff), `mcpToolCall`.
- **Approvals are server→client REQUESTS** (id-bearing; answered like copilot's
  permission requests): `item/commandExecution/requestApproval {threadId, turnId,
  itemId, command, cwd, commandActions, proposedExecpolicyAmendment?,
  availableDecisions: ['accept', {acceptWithExecpolicyAmendment:{…}}, 'cancel']}` and
  `item/fileChange/requestApproval {itemId, reason?, grantRoot?}`. Response
  `{decision: 'accept'}` live-verified: command executed, file created, turn completed.
  Decision space (schema `CommandExecutionApprovalDecision`): `accept`,
  `acceptForSession`, `{acceptWithExecpolicyAmendment}`, `cancel` (reject).
- **Usage:** `thread/tokenUsage/updated {tokenUsage: {total: {totalTokens, inputTokens,
  cachedInputTokens, outputTokens, reasoningOutputTokens}, last: {…},
  modelContextWindow}}` after each step; `account/rateLimits/updated` alongside.
- **Completion:** `turn/completed {turn: {id, status: 'completed', error,
  durationMs}}`. Cancel = client request `turn/interrupt {threadId, turnId}`.
- Codex responses omit the `jsonrpc` field (handled since M4); the stream is chatty
  (mcpServer startup, thread/status, rateLimits) — unknown methods must be ignored.

## Design

### 1. Canonical event addition (`src/shared/runtime.ts`)

```ts
| { type: 'usage.updated'; runId: string; inputTokens: number; cachedInputTokens?: number;
    outputTokens: number; reasoningOutputTokens?: number; contextUsedTokens?: number; contextWindow?: number }
```

Mapped from `thread/tokenUsage/updated` (`total` → context numbers, `last` → per-step
tokens accumulated by the session for the final `run.completed.usage`). All other events
reuse pillar 1's union unchanged.

### 2. Pure mapper (`src/main/runtime/acp/mapCodex.ts`)

Fixtures = the captured live frames. Exported pure functions:

- `mapCodexItem(runId, phase: 'started'|'completed', item): AgentEvent[]` —
  `commandExecution` → `tool.updated` (title = `readableCommand(command)` — reuse/move
  the zsh-unwrap helper from codexAdapter; status: started→running,
  completed→completed|failed from item status; detail = command, then
  `aggregatedOutput` when present); `fileChange` → `tool.updated` (title
  `Edit <paths>`, kind `edit`, detail = diff text when carried); `reasoning` → `[]`
  when summary/content empty, else a collapsed `tool.updated` row (kind `reasoning`,
  title 'Reasoning', detail = summary text); `agentMessage` → `[]` (deltas already
  streamed it); `userMessage` → `[]`; unknown types → generic row (pillar-1 fallback
  behavior).
- `mapCodexDelta(runId, params): AgentEvent[]` — `item/agentMessage/delta` →
  `content.delta` (assistant_text).
- `mapCodexApproval(runId, requestId, method, params)` → `permission.requested`:
  title = `readableCommand(command)` or `Edit files` (fileChange); detail = command /
  reason; options from `availableDecisions`: `accept` → `{id:'accept', kind:'allow',
  label:'Allow once'}`, `acceptForSession` → allow_always 'Allow for session',
  `{acceptWithExecpolicyAmendment}` → allow_always labeled 'Always allow this command'
  (id carries a stable key), `cancel` → deny 'Deny'. The session stores the ORIGINAL
  decision value per option id and echoes it verbatim in the response
  (`{decision: <original>}`) — NAC never invents decisions.
- `mapCodexUsage(runId, params)` → `usage.updated` (+ returns the `last` step tokens
  for session-side accumulation).
- `mapCodexTurnCompleted(status, error)` → run.completed stopReason
  (`completed`→end_turn, interrupted/cancelled→canceled, else errored with message).

### 3. CodexSession (`src/main/runtime/acp/codexSession.ts`)

Implements the pillar-1 `TransportSession` interface (which grows an optional
`prompt` opts param — see §4) over a per-chat `codex app-server` child via
`JsonRpcClient`:

- **connect(cwd, existingThreadId):** `initialize {clientInfo}` →
  `thread/resume {threadId}` when an id exists — **on failure THROW** (pillar-1
  doctrine: the caller sent a bare message; falling through would drop context; the
  ladder falls back to one-shot `codex exec resume <id>`) — else `thread/start {}`;
  store the threadId. Whether `thread/resume` replays item history is UNVERIFIED
  (not probed) — keep pillar 1's `replaying` suppression guard active around resume;
  the plan's live verification confirms the actual behavior and the guard's necessity.
- **prompt(runId, text, opts):** `turn/start` with `threadId`, `input:
  [{type:'text',text}]`, `cwd: acpCwd(cwd)`, per-turn `model`/`effort` from opts when
  set, and the YOLO mapping: yolo → `approvalPolicy:'never'`,
  `sandboxPolicy:{type:'workspaceWrite'}`; off → `'untrusted'` + `{type:'readOnly'}`
  (same semantics as today's `-s` flags). Long timeout (pillar 1's
  PROMPT_TIMEOUT_MS)… note: `turn/start` RESPONDS immediately (`inProgress`) — the
  turn's END is the `turn/completed` notification, so the session resolves the run on
  that notification, not on the request promise. Capture `turnId` from the response
  for interrupt. `run.started` emits with the threadId as sessionId.
- **Notifications** (filtered to our threadId): `item/started`/`item/completed` →
  mapper; `item/agentMessage/delta` → mapper; `thread/tokenUsage/updated` → emit
  `usage.updated` + accumulate step tokens; `turn/completed` → expire permissions
  FIRST (pillar-1 ordering), emit `run.completed` with accumulated usage, clear
  turn state. Unknown methods ignored.
- **Server requests:** `item/commandExecution/requestApproval` and
  `item/fileChange/requestApproval` registered via `onRequest`; YOLO auto-answers
  `{decision:'accept'}` without emitting events (belt-and-braces — `approvalPolicy:
  'never'` should prevent these); auto-cancel guard when no active run (pillar-1
  deadlock fix applies identically: respond `{decision:'cancel'}`).
- **cancel():** `turn/interrupt {threadId, turnId}` (no-op when no active turn).
- **busy/dead/dispose:** same contract as AcpSession (dead = client closed; dispose
  expires permissions + closes).

### 4. SessionManager generalization (`src/main/runtime/acp/sessionManager.ts`)

- `TransportSession.prompt` becomes `prompt(runId: string, text: string, opts?:
  { model?: string; effort?: string })`. AcpSession ignores opts (documented pillar-1
  copilot limitation stands).
- Entries hold `TransportSession` (typed by the interface + `busy`/`dead` — promote
  those to the interface). Creation goes through a factory:
  `codex` → `new CodexSession(sink, yolo)`, `copilot` → `new AcpSession(sink, yolo)`.
  Keying stays by chatId (a chat has at most one live transport; provider switch
  disposal from pillar 1 covers codex↔copilot switches automatically since the
  renderer's sessionId goes undefined).
- `promptViaAcp` is renamed `promptViaTransport` and gains `provider` + `model` +
  `effort` in opts (ipc passes `req.model`/`req.effort` through). All pillar-1
  lifecycle behavior (idle reaper with busy guard, force-dispose on quit, dead-entry
  recovery, mutable event sink, runToChat cleanup) applies unchanged.
- ipc.ts: the codex branch routes through the manager exactly like copilot — same
  `{ok:false}` → one-shot `startCodexRun` fallback with the render-only notice.
  **Codex ledger hooks stay LIVE** (per-turn model honored), unlike copilot's gate.

### 5. Renderer: real usage (`store.ts`, `runtime.ts`, `Inspector.tsx`)

- `runtime.ts` onEvent gains `usage.updated` → new store action
  `setLiveContext(chatId, usedTokens, windowTokens)` mapping
  `contextUsedTokens`/`contextWindow` onto the existing `contextK`/`windowK` fields
  (rounded to K). The fields simply become true for codex chats.
- The Inspector context-window row drops its `~` prefix when the numbers came from a
  live `usage.updated` (a `contextLive: boolean` on Chat, reset on provider switch,
  not persisted as true — hydration resets it with the other live-state sanitizers).
- Metering: the session accumulates per-step `last` tokens; `run.completed.usage`
  carries totals so `recordUsage`/StatsModal work unchanged (now with real cached +
  reasoning numbers folded into input/output as today's fields allow).

### 6. Errors + fallback ladder

Identical doctrine: spawn/initialize/thread failure → this send falls back to the
one-shot `codexArgs` path (render-only notice row); mid-turn child death →
`run.errored` + dead-entry recovery on next send; revival failure throws → one-shot
`codex exec resume` preserves context. The floor is the current release.

### 7. Testing & live verification

- **Unit (fixtures from the captured frames):** every mapper function (incl. the
  zsh-unwrap title, availableDecisions option mapping with the amendment object,
  decision echo-back integrity, usage math, turn-completed status mapping); manager
  factory routing; sandbox/approval-policy YOLO mapping (pure helper).
- **Live matrix (controller, computer use):** approval card on a write command
  (YOLO off) with the THREE codex options → accept runs it; deny (cancel) blocks;
  acceptForSession suppresses the next prompt; token streaming visibly incremental;
  fileChange row shows diff text; Stop mid-turn → interrupted; two-turn thread
  continuity; restart revival (codeword) via thread/resume; fallback with app-server
  broken; cross-provider switch replay-clean; **Inspector context bar shows real
  numbers on a codex chat**.
- **Docs:** DECISIONS entry (pillar 2 done; codex unaffected by the copilot
  model-forwarding limitation), same change.

## Out of scope (pillar 2)

- Shared multi-thread daemon (approach B), full one-shot retirement (approach C).
- Dedicated diff pane; reasoning stream rendering beyond collapsed summary rows.
- `thread/compact`, `thread/fork`, steering (`turn/steer`), realtime, guardian
  review flows beyond the two approval requests above.
- Pillars 3 (claude) and 4 (opencode acp).
