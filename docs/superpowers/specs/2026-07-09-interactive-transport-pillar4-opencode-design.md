# Interactive Run Transport — Pillar 4: opencode ACP — Design

**Date:** 2026-07-09
**Status:** Approved (approach A — provider-profile AcpSession)
**Depends on:** Pillars 1–3 (PR #3/#4, #5, #6): the `TransportSession` seam, canonical `AgentEvent` union, permission cards, tool rows, `usage.updated`, thinking rows, fallback ladder, hydration/endTurn sanitizers.

## Goal

opencode runs (the local-model carrier harness) become interactive behind the same seam: streaming, permission cards, tool rows, real cancel, restart revival — plus live per-session model switching over ACP (hosted ↔ LM Studio local, no respawn), native live context/window/cost metering, and three riders queued from the pillar-3 final review. This closes the interactive-transport milestone.

## Live-verified protocol surface (opencode 1.17.11, probed 2026-07-09)

1. **`opencode acp`** speaks standard ACP over stdio JSON-RPC — the same protocol family AcpSession (pillar 1) already implements for copilot. `initialize` reports `loadSession: true` and `sessionCapabilities: {close, fork, list, resume}`.
2. **`session/new {cwd, mcpServers}`** → `{sessionId, configOptions}`. `configOptions` includes `{id:'model', type:'select', currentValue, options:[{value,name}...]}` — the options list includes LM Studio local models (`lmstudio/...`, `lmstudio-remote/...`).
3. **`session/set_config_option {sessionId, configId:'model', value}`** → responds with updated configOptions (currentValue flipped). Verified live: switched to an `lmstudio/...` model per session, no respawn. (Param is `configId` — `configOptionId` is rejected with -32602.)
4. **Turn**: `session/prompt` responds at turn end with `{stopReason, usage:{inputTokens, outputTokens, totalTokens, thoughtTokens, cachedReadTokens}}`. `session/update` notification kinds observed: `agent_message_chunk` (streaming text), `agent_thought_chunk` (streaming reasoning), `tool_call` / `tool_call_update` (with `rawInput`, `locations`, `kind`, `status` — richer than copilot's), `usage_update {used, size, cost:{amount, currency}}`, `available_commands_update` (ignore).
5. **Cancel**: `session/cancel` notification; the in-flight `session/prompt` then resolves — observed stopReason was `end_turn` (NOT `cancelled`) in the probe, so the session must remember its own cancel and map any terminal to canceled.
6. **Revival**: fresh process → `session/load {sessionId, cwd, mcpServers}` → codeword recalled ("durian"). Load may replay history via session/update — pillar 1's `replaying` guard already covers this.
7. **Silent empty turn**: prompting while the selected local model is NOT loaded in LM Studio returns immediately with `stopReason:'end_turn'`, zero tokens, zero text — no error. Fail-honest handling required.
8. **Permissions**: no `session/request_permission` surfaced in probes (default opencode agent config auto-allowed a cwd write). AcpSession's existing generic handling covers it if/when opencode sends one; the live matrix checks with a restrictive scenario and records the observed behavior.

## Architecture

Approach A: parameterize `AcpSession` with a provider profile rather than adding a fourth session class — opencode is a protocol twin of copilot.

### Changed units

- **`src/main/runtime/acp/acpSession.ts`** — constructor gains a profile: `{ provider: 'copilot' | 'opencode'; command: string; args: string[] }` (default = copilot's current spawn). Internally:
  - Spawn uses the profile's command/args.
  - The `session/update` switch gains profile-gated cases (opencode only):
    - `usage_update` → `usage.updated { runId, inputTokens: 0, outputTokens: 0, contextUsedTokens: used, contextWindow: size }`; the latest `cost.amount` is remembered and folded into `run.completed.usage.costUsd`.
    - `agent_thought_chunk` → thinking row (`toolCallId: thinking_<runId>`, kind `reasoning`, title "Thinking…", running; completed on the first `agent_message_chunk` or `tool_call` of the turn — mirrors pillar 3).
    - `available_commands_update` → ignored.
  - **Model config**: the session records `appliedModel` (seeded from the connect response's `configOptions` `currentValue`). `prompt(runId, text, opts)`: when `opts.model` is set and differs, `await session/set_config_option {configId:'model', value: opts.model}` BEFORE `session/prompt`; update `appliedModel` on ack; on error, proceed with the prompt (the harness keeps its current model — fail-open, ledger records the outcome honestly). Copilot profile ignores `opts.model` exactly as today.
  - **Cancel mapping**: `cancel()` sets an `interrupted` flag (cleared per turn); when resolving the prompt response, `interrupted` maps ANY stopReason to `canceled` (pillar 2/3 precedent; covers opencode's observed `end_turn`-after-cancel).
  - **Empty-turn notice**: for the opencode profile, if the turn completes `end_turn` with zero streamed `agent_message_chunk` text AND `usage.outputTokens === 0`, emit a render-only notice row (`toolCallId: empty_<runId>`, kind `notice`, status `failed`, title "model returned nothing — is the local model loaded?") BEFORE `run.completed`. Never `content.delta`.
- **`src/main/runtime/acp/sessionManager.ts`** — factory: `opencode` → `new AcpSession(sink, yolo, OPENCODE_PROFILE)`; provider union widens to all four. Entry stays provider-tagged.
- **`src/main/runtime/ipc.ts`** — opencode joins the interactive guard; fallback ternary gains the opencode case dispatching the existing `startOpenCodeRun` (with sessionId + `variant: req.effort`) after the standard `fallback_<runId>` notice row. The lower one-shot block keeps only the stub. Ledger gate unchanged (opencode verdicts live — model is honored via set_config_option).

### Riders (from the pillar-3 final review)

- **`src/main/runtime/capabilities/jsonRpc.ts`**: `notify()`/`request()`/`answer()` writes guard on `closed`; constructor adds a swallowed stdin `'error'` listener — parity with streamJson (ab1b129). `request()` on a closed client already rejects; the guard covers the raw writes. Tests mirror streamJson's.
- **`src/main/runtime/acp/mapClaude.ts`**: `tool_result.content` array form (`[{type:'text', text}...]`) → joined text into row detail (string form unchanged). Test with the array fixture.
- **`src/main/runtime/acp/claudeSession.ts`**: `FRESH_VERIFY_MS` 500 → 1000 (cold-start flag-rejection headroom; cost is one-time at fresh-chat connect). Constant test updated.

## Error handling

- Connect failure (spawn dead, initialize/session-new error, session/load failure) → throw → `{ok:false}` → one-shot fallback with notice row (unchanged pillar-1 ladder; opencode's one-shot resume uses `-s <sessionId>`).
- `set_config_option` error → log-free fail-open (prompt proceeds on the harness's current model); the empty-turn notice and ledger capture real outcomes.
- Mid-turn child death → existing `JsonRpcClient` close path → run.errored (pillar-2 hardening, now with the stdin write guards).
- Junk/unknown update kinds → ignored (existing default).

## Testing

- Fixture tests for the new update kinds + set_config_option request shape (frames from the probes, recorded in `docs/research/opencode-acp-1.17.11.txt` written during implementation).
- Cancel-mapping and empty-turn-notice unit tests through AcpSession's existing test seams.
- Rider tests as above.
- **Live computer-use matrix (mandatory final task):** local-model turn (LM Studio-loaded model streams a real reply); mid-chat hosted→local model switch with context intact (the SUPER-HARD local leg); permission card behavior recorded (approve/deny if surfaced; note if opencode auto-allows by default); Stop mid-turn → canceled; two-turn continuity; restart revival via session/load; fallback (PATH-shadowed `opencode acp`) + `~` return + recovery; empty-turn notice with an unloaded local model; live context/window/cost in the Inspector; thinking row appears and collapses; copilot regression smoke (one interactive copilot turn — the shared class changed).

## Non-goals

- Effort/variant over ACP (one-shot keeps `variant`; configOptions exposed only `model`). pi.dev (still deferred, non-ACP). Fast mode (claude-specific). No-fake-pixels sweep beyond what the riders touch.
