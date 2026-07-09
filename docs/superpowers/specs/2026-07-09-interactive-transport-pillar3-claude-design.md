# Interactive Run Transport — Pillar 3: claude (stream-json) — Design

**Date:** 2026-07-09
**Status:** Approved (approach A — long-lived per-chat session)
**Depends on:** Pillar 1 (copilot ACP, PR #3/#4) and pillar 2 (codex app-server, PR #5): the `TransportSession` seam, canonical `AgentEvent` union, permission cards, tool rows, `usage.updated`, fallback ladder, hydration/endTurn sanitizers.

## Goal

Claude runs become interactive behind the same `TransportSession` seam: token streaming, permission cards built from the harness's own suggestions, tool rows with detail, protocol-level cancel, restart revival — plus real cost and live context metering for claude chats, and the two riders deferred from the pillar-2 review.

## Live-verified protocol surface (claude 2.1.181, probed 2026-07-09)

All facts below were captured against the real CLI; the captured frames become mapper test fixtures (`docs/research/claude-stream-json-2.1.181.txt` — written during implementation from the probe transcripts).

1. **Spawn:** `claude --print --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio --allow-dangerously-skip-permissions [--model X] [--effort Y] [--resume <sessionId>]`. Long-lived; multiple turns on one stdin. NOT JSON-RPC: newline-delimited typed frames (`type` field, no id/method envelope).
2. **Turn shape:** client writes one `{"type":"user","message":{role:'user',content:[{type:'text',text}]}}` frame. Server emits `system/init` (carries `session_id`, tools), `stream_event` frames wrapping raw SSE (`content_block_delta`/`text_delta` = token streaming), whole `assistant`/`user` message frames (tool_use / tool_result blocks), and a terminal `result` frame. The process stays alive after `result`.
3. **No handshake needed:** `can_use_tool` works without a control initialize (verified — probe 3 sent none).
4. **Permissions:** server→client `{"type":"control_request", request_id, request:{subtype:'can_use_tool', tool_name, display_name, input, description, permission_suggestions, tool_use_id}}`. Client answers `{"type":"control_response","response":{subtype:'success', request_id, response:{behavior:'allow', updatedInput}}}` or `{behavior:'deny', message}`. Deny is graceful (turn continues; denied file verified not created). `permission_suggestions` example: `[{type:'setMode', mode:'acceptEdits', destination:'session'}]` — the harness's own escalation options.
5. **Cancel:** client sends `{"type":"control_request", request_id, request:{subtype:'interrupt'}}` → acked with `control_response` → turn ends with `result` `subtype:'error_during_execution', is_error:true` (the cancel signature).
6. **YOLO:** `set_permission_mode` control request switches modes LIVE — `bypassPermissions` is refused unless spawned with `--allow-dangerously-skip-permissions` (that flag enables-but-does-not-activate). Verified: mode switch → bash write ran with **no** `can_use_tool` card. Always spawn with the enabling flag; YOLO on/off = `set_permission_mode bypassPermissions` / `default`.
7. **Revival:** `--resume <session_id>` in a fresh process recalled a planted secret word. Resume does NOT replay history frames (verified: init → answer only). Keep the cheap `replaying` guard anyway.
8. **Usage/cost:** `result` frame carries `usage` (input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens) and `total_cost_usd`. `stream_event message_start` carries the same usage shape per API call — context used ≈ input + cache_read + cache_creation of the LAST message_start in the turn.
9. **Noise frames** (ignore): `rate_limit_event`, `system/status`, `system/post_turn_summary`. `system/thinking_tokens` (estimated_tokens counter) drives the thinking row. Default-mode `-p` WITHOUT the stdio permission tool auto-denies tools — that is the pre-pillar-3 status quo and the fallback floor's behavior.

## Architecture

Approach A: one long-lived `ClaudeSession` per chat behind `TransportSession`, registered in the SessionManager provider factory (now copilot | codex | claude). The ipc interactive guard becomes three-provider; claude's one-shot adapter remains the fallback floor (`claude --resume` preserves context — resume failure THROWS per the context-preservation doctrine).

### New units

- **`src/main/runtime/acp/streamJson.ts` — `StreamJsonClient`**: spawn + `LineDecoder` (reused) + typed-frame dispatch. API: `onFrame(type, handler)` (exact `type` match), `send(frame)`, `onClose(handler)` (idempotent, fires immediately if already closed — pillar-2 semantics), `isClosed`, `close()`. No request/response correlation — control responses are matched by the session, not the client.
- **`src/main/runtime/acp/mapClaude.ts`** — pure mappers (fixtures from captured frames):
  - `stream_event` + `content_block_delta.text_delta` → `content.delta` (assistant_text).
  - `assistant.tool_use` → tool row `running`. Title: Bash → the command string; Write/Edit/NotebookEdit → `Edit <file_path>` kind `edit`; Read/Grep/Glob → name + primary arg; anything else → `display_name`/name. Detail: pretty input summary.
  - `user.tool_result` → completes the row by `tool_use_id` (`is_error` → `failed`; content string → detail).
  - `control_request can_use_tool` → `permission.requested`: options = "Allow once" (kind allow) + one option per `permission_suggestion` (kind allow_always; label derived from the suggestion, e.g. setMode acceptEdits → "Allow edits for session") + "Deny" (kind deny). The decisions map stores what to send back verbatim: allow → `{behavior:'allow', updatedInput: <echoed input>}`; suggestion options → same allow response PLUS the suggestion object passed back verbatim in `updatedPermissions: [<suggestion>]`; deny → `{behavior:'deny', message:'Denied via NAC Code'}`. **One-off probe during implementation confirms the `updatedPermissions` response field**; if it is rejected, suggestion options degrade to plain allow (and the card option is dropped, never invented).
  - `result` → terminal mapping: `subtype:'success'` → `run.completed` end_turn; `error_during_execution` **after our own interrupt** → canceled; any other error subtype / `is_error` → `run.errored`. Usage: `usage` + `total_cost_usd` → `run.completed.usage` (inputTokens/outputTokens/costUsd).
  - `stream_event message_start` usage → `usage.updated` with `contextUsedTokens = input + cache_read + cache_creation` (window: static per-model until a real field is observed).
  - `system/thinking_tokens` → tool row `toolCallId:'thinking_<runId>'` kind `reasoning`, title "Thinking…", detail = estimated_tokens; completes (collapses) when the first text delta or tool_use arrives.
  - Ignore list: `rate_limit_event`, `system/status`, `system/post_turn_summary`, empty `thinking` blocks.
- **`src/main/runtime/acp/claudeSession.ts` — `ClaudeSession implements TransportSession`**: spawn args from (cwd, yolo, model, effort, existingSessionId); `prompt(runId, text, opts)` writes the user frame; captures `session_id` from `system/init` → `run.started`; resolves on `result`; **inactivity watchdog** (re-armed on every frame, 30-min silence ceiling — rider 2); `onClose` → `finishRun(errored 'claude exited mid-turn')`; `respondPermission` sends the stored verbatim response; `cancel()` sends interrupt and remembers it (to map the subsequent `error_during_execution` to canceled); `setYolo` sends `set_permission_mode`; **model/effort mismatch** between `opts` and spawned flags → the SESSION MANAGER disposes and recreates with `--resume` (the session exposes its spawned model/effort for the comparison).

### Touched units

- `sessionManager.ts`: factory adds `claude`; recreate-on-model/effort-mismatch for sessions that expose spawn-bound opts.
- `ipc.ts`: interactive guard includes claude; claude's fallback = existing one-shot claude path with `sessionId` (resume) + render-only notice row.
- Codex rider changes: `codexSession.ts` watchdog re-arms on every notification (same constant, now measuring silence); fallback path (both providers) flips `contextLive` to false — new store action `setContextEstimated(chatId)` invoked from the renderer when a run carries the fallback notice (detected via the notice tool row event) OR simpler: ipc emits `usage.reset`? — **decision: the renderer flips `contextLive:false` in `endTurn` when the turn contains the fallback notice row id `fallback_`** (the notice row's `toolCallId` is stable: `fallback_<runId>` (kind `notice` — the existing pillar-2 id); `endTurn` checks for a `toolCallId` starting with `fallback_`). No event-shape change.
- Inspector: cost row shows accumulated real `usage[*].costUsd` when > 0, else the existing placeholder (full fake-pixel removal stays in the no-fake-pixels sweep).

## Error handling

- Spawn/connect failure or resume-death before first result → throw → `{ok:false}` → one-shot fallback with notice row (floor = today).
- Mid-turn child death → `onClose` → `run.errored` (parity with pillar-2 fix b9e618b).
- `can_use_tool` while no active run/replaying → auto-deny (reuse `shouldAutoCancelPermission`).
- Unknown/junk frames → ignored (mapper returns []).
- Interrupt send failure → swallow; inactivity watchdog remains the backstop.

## Testing

- Mapper tests from captured probe frames (fixtures, incl. the deny/interrupt/result variants).
- `StreamJsonClient` tests mirror `jsonRpc.test.ts` close-handling suite (real short-lived children).
- Session tests: pure helpers (spawn-args builder, cancel-signature mapping, watchdog re-arm predicate) — lifecycle is live-verified.
- **Live computer-use matrix (mandatory final task):** approve card / suggestion option ("Allow edits for session" → next edit silent) / deny / YOLO toggle mid-chat (no respawn) / Stop mid-turn / two-turn continuity / restart revival / model-switch respawn-resume (context intact) / fallback + recovery / real cost + live context numbers in Inspector / thinking row appears and collapses.

## Non-goals

- Pillar 4 (opencode ACP). Full no-fake-pixels sweep (only the cost row's real-when-available wiring lands here). Per-turn model switching without respawn. MCP tool-call special-casing beyond generic rows.
