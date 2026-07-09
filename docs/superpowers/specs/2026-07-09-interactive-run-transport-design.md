# Interactive run transport — pillar 1: copilot ACP

**Date:** 2026-07-09 · **Status:** approved design, pre-implementation
**Roadmap:** item 1 of the 2026-07-09 locked order (interactive runs first). Pillars 2–4
(codex app-server, claude, opencode acp) are separate follow-up specs reusing this
pillar's event model, UI, and transport seam.

## Problem

Every run today is one-shot headless: YOLO on, or tools silently restricted; tool
activity renders as flattened text (`[tool: Read]`); cancel kills the process without a
protocol-level stop; codex can't token-stream. A daily-drivable NAC needs the harness to
*ask* ("run `npm test`?"), needs tool activity as live structure, and needs real
cancellation — over the structured protocols the M4 discovery clients already speak.

## Decisions made during brainstorming (owner, 2026-07-09)

- **Decomposition:** one transport per pillar; **pillar 1 = copilot ACP** (lowest risk —
  ACP client proven in M4, cleanest protocol).
- **Permission UX = inline transcript card** (request title + detail + the harness's own
  option buttons; run pauses; answered cards collapse to a one-line record). YOLO on =
  auto-approve (first allow option), no card.
- **Tool rendering = compact rows + expand** (one line: status glyph, title; expands to
  args/output). Rich per-tool renderers (diff viewers) arrive with the codex pillar.
- **Architecture = approach A:** persistent ACP session process per active copilot chat,
  behind a provider-generic `TransportSession` seam; fallback ladder to today's one-shot
  path.

## Probed ground truth (2026-07-09, live `copilot --acp` v1.0.69 prompt flow)

Captured frames (full log: `docs/research/acp-prompt-frames-copilot-1.0.69.txt`; shapes verbatim):

- Tool call announce — notification `session/update`:
  `{ sessionUpdate: 'tool_call', toolCallId: 'call_…', title: 'Run echo nac-probe-ok',
  kind: 'execute', status: 'pending', rawInput: { command, description, mode } }`
- Permission — **server→client REQUEST** `session/request_permission` (id-bearing; NAC
  must respond): `{ sessionId, toolCall: {toolCallId, title, kind, status, rawInput},
  options: [{optionId:'allow_once',kind:'allow_once',name:'Allow once'},
  {optionId:'allow_always',kind:'allow_always',name:'Always allow'},
  {optionId:'reject_once',kind:'reject_once',name:'Deny'}] }`.
  Response shape (verified accepted): `{ outcome: { outcome: 'selected', optionId } }`.
- Tool progress/finish — `session/update` `tool_call_update` frames carrying `content`
  chunks and finally `status: 'completed'` + `rawOutput` (incl. `shell_exit` entries with
  `exitCode`, `cwd`, `outputPreview`).
- Assistant text streams as `session/update` `agent_message_chunk` frames (M4-era
  knowledge, re-confirmed in the full log).
- Prompt completion — the `session/prompt` RESPONSE: `{ stopReason: 'end_turn' }`.
- `initialize` result advertises `loadSession: true` and `sessionCapabilities.list`;
  ACP defines `session/cancel` (notification) for mid-turn stop.

## Design

### 1. Canonical event expansion (`src/shared/runtime.ts`)

```ts
| { type: 'tool.updated'; runId: string; toolCallId: string; title: string;
    kind?: string; status: 'pending' | 'running' | 'completed' | 'failed'; detail?: string }
| { type: 'permission.requested'; runId: string; requestId: string; title: string;
    detail?: string; options: { id: string; label: string; kind: 'allow' | 'allow_always' | 'deny' }[] }
| { type: 'permission.resolved'; runId: string; requestId: string; optionId: string }
```

One upsert-style `tool.updated` (ACP is create-then-update on `toolCallId`; the renderer
reducer upserts by id). `detail` carries rawInput command text on announce and output
text on completion — plain text in pillar 1. `run.completed` `stopReason: 'canceled'`
already exists and becomes reachable via real protocol cancel. Mapping from ACP frames
to these events is a pure, exported, fixture-tested function (`mapAcpUpdate`).

### 2. Transport seam + AcpSession (`src/main/runtime/acp/`)

```ts
interface TransportSession {
  prompt(text: string): void            // one turn; events flow to onEvent
  respondPermission(requestId: string, optionId: string): void
  cancel(): void                        // session/cancel; turn ends with stopReason canceled
  dispose(): void                       // kill child
}
```

`AcpSession` implements it over a persistent `copilot --acp` child:
- First send: spawn → `initialize` (protocolVersion 1, fs read/write false) →
  `session/new` (cwd = chat workspace, `mcpServers: []`) → store `sessionId` in the
  existing `chat.sessionId`/`sessionProvider` fields.
- Later sends: `session/prompt` on the live session (true native continuity — no replay
  block). After app restart: `session/load` with the persisted id; on failure → fresh
  `session/new` seeded by the standard replay prompt (existing cross-provider invariant,
  unchanged).
- `SessionManager` (same module) keys sessions by chatId: dispose on provider switch,
  app quit, and a 15-minute idle timer.
- YOLO on: `request_permission` auto-answered with the first `allow*` option; no
  permission events emitted.
- Permission requests with zero options (defensive): respond `reject_once`-equivalent
  (first option or error) and emit `run.errored` context — never hang a turn.

### 3. JsonRpcClient extension (`src/main/runtime/capabilities/jsonRpc.ts`)

Backward-compatible additions (M4 discovery callers unchanged):
- `onNotification(method, handler)` — subscribe to server notifications.
- `onRequest(method, handler)` — handler's resolved value is written back as the
  JSON-RPC response for the server's request id; a thrown error responds with a JSON-RPC
  error. This is the `session/request_permission` answer path.
- Existing pending-map, `LineDecoder`, per-request timeout reused. `session/prompt` is
  sent with a LONG timeout (turns are minutes; 30-minute cap) — cancellation, not
  timeout, is the user's stop lever.

### 4. Renderer state (`src/renderer/src/store/store.ts`)

- `Turn` gains `tools?: ToolRow[]` and `permissions?: PermissionCard[]` on the streaming
  assistant turn. `ToolRow = { toolCallId, title, kind?, status, detail? }`;
  `PermissionCard = { requestId, title, detail?, options, resolvedOptionId? }`.
- Reducers `upsertTool(chatId, row)` and `upsertPermission(chatId, card)` mirror the
  events; `runtime.ts`'s `onEvent` switch routes the three new event types.
- **Replay invariant: `buildReplayPrompt` reads only `turn.text`.** Tools/permissions
  are render-only history — cross-provider replay stays `summary + text tail`, bounded,
  with zero tool chatter.
- Persistence: tool rows/permission records persist as history; `normalizeChat` maps any
  hydrated `pending`/`running` tool status to `failed` and unresolved permission cards to
  a `resolvedOptionId: 'stale'` marker (never restore live-looking state — the
  `compacting` doctrine).

### 5. UI (`ChatView.tsx` + `ToolRow.tsx` + `PermissionCard.tsx`)

- `ToolRow`: one line — status glyph (⟳ running / ✓ completed / ✗ failed), `title`;
  click toggles an expanded monospace block showing `detail`. Rendered in-flow inside
  the assistant turn, in arrival order relative to text (pillar 1: tools listed before
  the accumulated text block is acceptable; strict interleaving arrives with rich
  rendering).
- `PermissionCard`: inline card — title (e.g. "Run echo nac-probe-ok"), detail (the
  command), one button per harness option. Buttons call
  `runs.respondPermission(runId, requestId, optionId)`. Answered/stale cards collapse to
  one line ("✓ Allow once — Run echo nac-probe-ok" / "· expired"). The run pauses while
  a card is open (that's the protocol semantics, not a UI trick).
- Composer: Stop button while streaming → `runs.cancel(runId)`.

### 6. IPC + routing (`ipc.ts`, `preload`, `store/runtime.ts`)

- `RUN_CHANNELS.respondPermission = 'run:respondPermission'`; preload
  `runs.respondPermission(runId, requestId, optionId)`.
- `runs.start` provider `copilot` routes to `SessionManager.prompt(...)`; other
  providers unchanged. `runs.cancel` dispatches to the owning session (fallback: kill,
  as today). The runId→session map lives in the manager.
- `sendMessage` copilot path: when a live session exists for the chat, send the bare
  message (no context block, no replay); otherwise seed exactly as today (replay prompt
  + context block) into a fresh session. Ledger/metering hooks keep working off
  `run.completed`.

### 7. Errors + fallback ladder

- ACP spawn/`initialize`/`session/new`/`session/load` failure → this send falls back to
  the one-shot `copilotArgs` path, with one transcript status line ("interactive session
  unavailable — ran headless"). The floor is the current release.
- Mid-turn child death → `run.errored` (stderr tail), session disposed; next send starts
  fresh. Unanswered permission cards on error/cancel collapse to stale.
- Fallback and session-revival decisions are pure functions where practical, tested.

### 8. Testing & verification

- **Unit (fixtures = the captured live frames):** `mapAcpUpdate` (tool_call,
  tool_call_update incl. completed+rawOutput, agent_message_chunk, request_permission →
  events), onRequest response plumbing, reducers (upsert, resolve, stale-collapse),
  replay-excludes-tools invariant, hydrate drops live statuses, YOLO auto-approve
  selection, zero-option defense.
- **Live (project standard):** with YOLO off, a copilot run that executes a shell
  command → card appears → Allow once → tool row streams to ✓ → reply lands; Deny path;
  Stop mid-run → `canceled`; two-turn continuity (no replay block on turn 2, verified in
  the session log); app-restart `session/load` revival; forced-ACP-failure fallback to
  headless.
- **Docs:** DECISIONS entry marking roadmap item 1 pillar 1 done, in the same change.

## Out of scope (pillar 1)

- Codex app-server, claude, and opencode acp transports (pillars 2–4).
- Rich per-tool renderers (diffs, terminal panes), strict text/tool interleaving.
- ACP session modes (plan/autopilot), `fs` capability handlers (NAC as file proxy),
  copilot token-usage metering beyond what session/update provides.
- Allow-always persistence beyond the harness's own session scope (NAC stores no
  permission policy in pillar 1).
