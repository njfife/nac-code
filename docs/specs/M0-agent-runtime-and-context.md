# Spec: Agent Runtime + Cross-Provider Context (M0-1 & M0-8)

Closes the two coupled M0 spec-closure items. Grounded in the t3code architecture review (`scratchpad/t3code`), the validated cross-provider spike (`spikes/cross-provider-portability/`), and the carrier research (`docs/research/carrier-harnesses.md`). Decisions here feed M5 (Conversation Surface + Agent Runtime) and M2 (persistence).

**Core principles (decided):**
- NAC Code is a **wrapper, never a harness** — no agent loop, no raw model connections. Every model runs inside an agentic harness CLI.
- All harnesses normalize into **one canonical event union**; the renderer/persistence never see native wire formats.
- The **provider-neutral transcript is the single source of truth** for both UI render and agent context. Native sessions are an optimization, never authoritative.
- Integrate at each harness's **structured protocol** (ACP-first); stdout-scraping is not used.

---

## Part A — M0-1: Agent runtime, adapter interface, event protocol

### A1. Canonical `AgentEvent` union

One versioned tagged union (`v1`) every adapter emits. Right-sized from t3code's ~48-variant `ProviderRuntimeEvent`; start with this set and extend additively.

```ts
type AgentEvent = { v: 1 } & Base & (
  | { type: 'run.started';   turnId: string }
  | { type: 'run.completed'; turnId: string; stopReason: 'end_turn'|'canceled'|'error'|'max_tokens' }
  | { type: 'run.errored';   turnId: string; error: AgentError }
  | { type: 'content.delta'; streamKind: 'assistant_text'|'reasoning'|'tool_output'; text: string; index?: number }
  | { type: 'item.started'   } & ItemFields
  | { type: 'item.updated'   } & ItemFields
  | { type: 'item.completed' } & ItemFields
  | { type: 'request.opened';   requestId: string; requestType: RequestType; title: string; args: unknown }
  | { type: 'request.resolved'; requestId: string; outcome: 'accepted'|'declined'|'canceled'|'answered' }
  | { type: 'usage.updated'; promptTokens: number; completionTokens: number; reasoningTokens?: number }
)

interface Base {
  eventId: string; runId: string; chatId: string;
  provider: string; instanceId: string;          // open slugs (driver vs instance)
  sessionId?: string; turnId?: string; itemId?: string;
  createdAt: number;
  raw?: { source: string; payload: unknown };     // native provenance/passthrough (e.g. 'acp.jsonrpc', 'codex.app-server.notification')
}
type ItemFields = { itemId: string; itemType: ItemType; status: 'in_progress'|'completed'|'failed'|'declined'; title?: string; detail?: string; data: unknown }
type ItemType = 'command_execution'|'file_change'|'mcp_tool_call'|'web_search'|'message'|'reasoning'|'plan'|'unknown'
type RequestType = 'command_approval'|'file_change_approval'|'apply_patch_approval'|'tool_input'|'user_input'|'unknown'
type AgentError = { code: string; message: string; retriable: boolean }
```

Rules: discriminate on `type`; every literal union includes `unknown` for forward-compat; tool-specific payloads live in opaque `data`/`args`; the original native event is preserved in `raw` (debug + unmodeled passthrough). UI renders a `content.delta` with `streamKind:'reasoning'` distinctly (collapsible) and **never persists it to the transcript** (see B).

### A2. Adapter interface (one shape per harness)

```ts
interface HarnessAdapter {
  startTurn(req: RunRequest): RunHandle;                  // returns immediately; events arrive on streamEvents
  cancel(runId: string): Promise<void>;
  respondToRequest(runId: string, requestId: string, r: ApprovalDecision | { input: unknown }): Promise<void>;
  buildContext(transcript: Transcript, target: Target): ProviderInput;   // UNIVERSAL replay (see Part B)
  capabilities(): { transport: Transport; nativeResume: boolean; sessionLoad: boolean };
  streamEvents: AsyncIterable<AgentEvent>;
}
type Transport = 'acp' | 'app-server' | 'sdk'            // NO raw 'text-stream' — everything is an agentic harness
type ApprovalDecision = 'allow_once' | 'allow_session' | 'deny' | 'cancel'
interface RunRequest { chatId: string; providerInput: ProviderInput; prompt: string; thinking: ThinkingLevel; autonomy: AutonomyPolicy }
```

"Add a harness = write one adapter." Both ACP harnesses and bespoke ones (Codex app-server, Claude SDK) implement this and emit the same `AgentEvent` union. Two-hop normalization inside each adapter: native wire → thin envelope → mapper that emits 0..n `AgentEvent`s.

### A3. Transports (per harness, from the t3code review)

| Harness | Transport | Spawn / drive |
|---|---|---|
| Cursor, Gemini, **OpenCode** | `acp` | spawn in ACP mode (e.g. `opencode acp`, `cursor-agent ... acp`), JSON-RPC over stdio; generate ACP types from the published spec |
| Codex | `app-server` | `codex app-server`, JSON-RPC over stdio; codegen types from `openai/codex` pinned to a ref |
| Claude | `sdk` | Claude Agent SDK (`claude.sdk.*` events) |

Transport must be **full-duplex** — the agent calls back into the host (approvals, fs, terminal). Spawn every subprocess inside a disposable scope (RAII) so no orphan processes leak.

### A4. Full-duplex approval round-trip

1. Agent emits `request.opened {requestId, requestType, args}`.
2. Host parks a `Deferred` keyed by `requestId`, surfaces the request to the UI per the autonomy policy (M0-2).
3. UI resolves → `respondToRequest(runId, requestId, decision)` → Deferred resolves → adapter answers the agent's inbound RPC.
4. Agent emits `request.resolved`.

Where a harness has a **native** approval/sandbox policy (Codex `approvalPolicy`+`sandboxMode`), the autonomy toggle (M0-2) drives that policy rather than re-implementing gating.

### A5. Run errors

`run.errored` carries a structured `AgentError`. The transcript and any partial output are retained; the chat returns to idle with a retry affordance. Subprocess death mid-run = `run.errored {code:'transport_closed', retriable:true}`.

---

## Part B — M0-8: Provider-neutral transcript & cross-provider context

### B1. The transcript (single source of truth)

```ts
interface Transcript {
  chatId: string;
  system: { instructions: string[]; agent?: string };   // OUR instruction/skill context (portable)
  turns: Turn[];
}
interface Turn {
  id: string; role: 'user' | 'assistant'; createdAt: number;
  provider?: string;                                     // which harness produced an assistant turn
  blocks: Block[];
  raw?: unknown;                                         // native turn blob — provenance only, NEVER read for replay
}
type Block =
  | { kind: 'text'; text: string }
  | { kind: 'tool_call';   callId: string; name: string; args: unknown }
  | { kind: 'tool_result'; callId: string; status: 'ok'|'error'; summary: string; output?: string }
```

What is **not** in the transcript: native session ids, raw reasoning/thinking content (dropped; optionally a short summary block), provider-specific system prompts. The transcript both **renders the UI** and **rebuilds agent context** — they can never diverge (this is the t3code defect we avoid).

### B2. `buildContext(transcript, target)` — the universal replay

`target = { provider, model, windowTokens, transport }`. The ONLY mechanism that survives a provider switch; it is primary, not a fallback.

```
function buildContext(transcript, target):
  ctx = renderSystem(transcript.system, target)           # instructions/skills in target's format
  turns = transcript.turns
  if overWindow(ctx, turns, target):                      # B4
     turns = compact(transcript, target)                   # FR-9: summary + recent tail
  rendered = turns.map(t => renderTurn(t, target))         # B3 (tool flattening for foreign turns)
  return assemble(ctx, rendered)                            # per transport (B5)
```

### B3. Tool-call portability (the hard part)

A turn's `tool_call`/`tool_result` blocks from a **foreign** provider cannot be replayed as the target's native tool calls. Rule:
- **Same provider, native resume available** → don't flatten; use the native session.
- **Cross-provider (or no native session)** → **flatten** each `tool_call`/`tool_result` into readable text appended to the conversation context, e.g.:
  `[tool] read_file(path="src/x.ts") → ok: <summary>`.
  The new provider learns *what happened*; its own subsequent tool calls are native. Flattening fidelity is a build-time validation item (B7).

### B4. Window/compaction on switch

Re-tokenize against the **target** model's window (M0-3), not the source's. Switching a 200k-window cloud thread to a small-window local model **requires** compaction (FR-9): keep the compacted summary + the most recent turns that fit, reserving **output/reasoning headroom** (spike finding: local reasoning models spend 200–1400+ completion tokens before answering — budget for it or you get empty replies). The full transcript is always retained; compaction produces a derived, shorter context.

### B5. Assembly per transport

- **ACP / agentic harness with `sessionLoad`** → `session/load` to restore, else `session/new` then prime the first prompt with the rendered context (system + flattened history) before the user's new message.
- **app-server / sdk** → equivalent: resume by id if same-provider + alive; else fresh session primed with rendered context.
- There is **no raw stateless path** in the product — local models are reached via the OpenCode carrier (B6), which is itself an agentic harness.

### B6. Local models via the OpenCode carrier

`CliRegistry.configureLocalBackend('opencode', backend)` writes a NAC-owned `opencode.json` (provider `@ai-sdk/openai-compatible`, `options.baseURL` = local endpoint, explicit `models` map, dummy `apiKey`) and points `OPENCODE_CONFIG` at it (idempotent; does not clobber the user's config). NAC Code then wraps OpenCode like any other ACP harness (`opencode acp`). Details + caveats: `docs/research/carrier-harnesses.md`.

### B7. Resume & switch model

| Situation | Mechanism |
|---|---|
| Resume, same provider, native session alive & matches transcript | native resume (fast path) |
| Resume, native session missing/expired/mismatched | `buildContext` replay |
| **Switch provider mid-conversation** | **always `buildContext` replay** |

`capabilities().nativeResume`/`sessionLoad` gate the fast path; everything else is replay.

### B8. UX decision (recommended)

Provider switch is **in-place on the same chat** (the chat's provider field changes; thread continues). Branch-into-new-chat is reserved for "new from compacted" (FR-9.3). Same `buildContext` machinery either way. *Confirm before M5.*

---

## Acceptance tests (CI, per harness incl. local-via-OpenCode)

1. **Resume:** chat with ≥2 prior turns → "what was the first thing I asked you?" → references the real first message.
2. **Switch:** start on harness A, ≥2 turns → switch to harness B (incl. to/from local-via-OpenCode) → same question → B answers correctly.
3. **Tool flattening:** A makes a tool call → switch to B → B can answer a question about the tool's result.
4. **Small-window switch:** switch a long thread to a small-window local model → no error, recent context preserved, compaction applied.

Baseline already validated: the transcript-carries-context principle (spike, 2026-06-28).

## Build-time validations (carry into M5, not blocking this spec)

- OpenCode ACP `session/load` vs prime-via-prompt seeding — the redirected spike; run when OpenCode is installed.
- Tool-flattening fidelity across real harnesses.
- Reasoning-token headroom defaults per local model.

## Out of scope here (other M0 items)

Autonomy policy details (M0-2), thinking-level→provider mapping (M0-3), new-chat seeding (M0-4), error/empty states (M0-5), file-context lifecycle (M0-6), Electron scaffold (M0-7).
