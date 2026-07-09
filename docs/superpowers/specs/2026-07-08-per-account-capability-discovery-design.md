# Per-account model & capability discovery (M4, pillar one)

**Date:** 2026-07-08 · **Status:** approved design, pre-implementation
**Supersedes:** the 2026-06-29 lock "codex/copilot model selection needs real per-account
model discovery (M4)" — this feature IS that discovery.

## Problem

The model picker's catalog is hardcoded. The owner wants NAC to surface the models and
configurations each harness actually provides for his account, and to configure core
model functionality (model + reasoning depth) to the full level each provider allows —
no hardcoded, possibly-wrong lists.

## Decisions made during brainstorming

- **Scope (v1): model + reasoning depth.** Per-account model lists, and each provider's
  REAL effort scale replacing the universal `none|low|medium|high`. Fast mode and the 1M
  variant stay as shipped. Service/speed tiers, capability flags (webSearch etc.),
  personality: out of scope.
- **Approach: protocol-first discovery with a learning fallback** (approach A of 3).
  Protocol clients where a harness exposes a list; outcome-learning for account gating
  where it doesn't; graceful degradation to today's behavior everywhere.
- **No raw model endpoints.** The Claude API `/v1/models` requires an API key and is
  off-architecture (wrapper invariant; CLIs own auth). Claude uses a static base +
  learning instead.
- **Effort is not portable across providers.** On provider switch, effort resets to
  harness default (`null`).

## Probed ground truth (2026-07-08, real binaries + docs agent)

| Provider | Model list surface | Effort surface | Notes |
|---|---|---|---|
| codex | **app-server v2 `model/list`, verified live 2026-07-08**: newline-delimited JSON-RPC over stdio; `initialize` (clientInfo) → `model/list` → `data[]` of `Model{id, displayName, description, isDefault, hidden, supportedReasoningEfforts[{reasoningEffort, description}], defaultReasoningEffort, serviceTiers, …}`. NOTE: responses omit the `jsonrpc` field — the parser must not require it. | per-model `supportedReasoningEfforts` (owner's gpt-5.5: low/medium/high/xhigh, default medium) | `-m gpt-5.5` (plan id) verified working on the owner's ChatGPT account; `-m gpt-5-codex` 400s ("not supported with a ChatGPT account") — gating is per-id, not blanket. app-server is EXPERIMENTAL. |
| copilot | **ACP (`copilot --acp`), verified live 2026-07-08**: `initialize` (protocolVersion 1) → `session/new` → `result.models.availableModels` (11 models on the owner's account: modelId, name, description, `_meta.copilotUsage` multiplier, `_meta.copilotEnablement`) + `currentModelId`. The docs-reported `models.list` method returns -32601 on this surface. | documented flag choices: `none, minimal, low, medium, high, xhigh, max` | Bogus model → clean error `Model "X" from --model flag is not available.` ACP also exposes session modes (agent/plan/autopilot) — out of scope, noted for the future run-transport milestone. |
| claude | none headless — alias set (fable/opus/sonnet/haiku + `[1m]`) fixed per CLI version, account-gated at request time | `--effort low|medium|high|xhigh|max` (+ `ultracode`, session-only; `max` session-only; per-model support varies; org caps may clamp) | bad model → structured result JSON with `is_error`, `api_error_status: 404` |
| opencode | `opencode models` (already wired) | `--variant`, model-dependent | unchanged |

## Design

### 1. Capability model (`src/shared/runtime.ts`)

```ts
export interface DiscoveredModel {
  id: string            // harness model id (what --model / -m receives)
  label: string         // display name
  isDefault?: boolean
  efforts?: string[]    // per-model scale (codex); absent = use provider-wide scale
  defaultEffort?: string
  variants?: { id: string; label: string }[]  // e.g. claude sonnet[1m]
  gated?: boolean       // learned: this account's harness rejected the id
  note?: string         // honest caveat (e.g. 'session-only' efforts)
}

export interface ProviderCapabilities {
  provider: string
  source: 'protocol' | 'static' | 'static+learned'
  models: DiscoveredModel[]
  efforts: string[]     // provider-wide effort scale (fallback when models carry none)
  fetchedAt: number
}
```

New IPC: `capabilities:get` `(provider: string, opts?: { refresh?: boolean }) →
ProviderCapabilities`. In-memory cache per app session; `refresh: true` bypasses it.
Run-outcome reporting reuses the existing run event path (see §3).

### 2. Discovery service (`src/main/runtime/capabilities/`)

One strategy per provider behind `discoverCapabilities(provider)`:

- **codex.ts** — spawn `codex app-server` (stdio), JSON-RPC: initialize → v2
  `model/list` (paginate via `nextCursor` if present) → map (drop `hidden: true`;
  carry id/displayName/isDefault/supportedReasoningEfforts/defaultReasoningEffort) →
  kill the child. Any protocol/spawn error, malformed frame, or timeout (5s) → static
  fallback. JSON-RPC framing + response mapping are pure, exported, fixture-tested
  against the dumped schema shapes.
- **copilot.ts** — spawn `copilot --acp` (stdio, standard ACP JSON-RPC, verified live):
  `initialize` (protocolVersion 1) → `session/new` (`cwd`: home dir, `mcpServers: []`)
  → map `result.models.availableModels` (modelId → id, name → label; carry
  `_meta.copilotUsage` into `note`, e.g. "9x usage") and `currentModelId` → `isDefault`;
  kill the child. Provider-wide efforts = the 7 documented values.
- **claude.ts** — static base: current aliases + 1M variant, efforts
  `low|medium|high|xhigh|max` (+`ultracode` with `note: 'session-only'`); merge the
  gating ledger → `source: 'static+learned'`.
- **opencode.ts** — relocate the existing `opencode models` discovery unchanged.

`providers.ts` keeps only presentation metadata (name, dot, detail, status for the
Inspector) and static fallback model sets; it is no longer the authority when discovery
succeeds.

### 3. Gating ledger

Persisted at `userData/nac-capability-ledger.json` (same atomic write pattern as
nac-state): `{ [provider]: { [modelId]: { verdict: 'gated' | 'works', at: number,
message?: string } } }`.

Writers: the main process inspects run failures for the three known model-rejection
shapes (codex 400 "not supported", copilot "is not available", claude
`api_error_status` 404 with a selected model) and records `gated`; a completed run with
an explicit model records `works`. Readers: claude strategy (and any provider, as a
merge step) → `DiscoveredModel.gated`. Ledger parsing/merging is pure and tested.

UI: gated models stay clickable (fail-honest stands) but render with a warning tint and
"rejected for this account" note — surprises don't repeat silently.

### 4. Effort becomes provider-real

- `Chat.thinking: ThinkingLevel` → `Chat.effort: string | null` (`null` = harness
  default; replaces `'none'`). `ThinkingLevel` is deleted.
- Legal values come from capabilities (per-model when present, else provider-wide).
- Composer pill cycles `[null, ...activeScale]` for the active provider/model.
- Provider switch (any `setModel` to a different provider) resets `effort` to `null`.
- Model switch within codex: if the current effort isn't in the new model's
  `efforts`, reset to `null`.
- `RunRequest.thinking` → `RunRequest.effort` (same adapter mapping; adapters unchanged
  otherwise — they already take arbitrary strings).
- Migration (`normalizeChat`): `thinking: 'none'` → `effort: null`; other stored values
  carry over as-is (they'll be validated against the provider scale at render/send
  time; invalid → treated as null). The `fast`-keyed pre/post-feature gate remains.

### 5. Model selection wiring for codex/copilot

- `codexArgs` gains `model?: string` → `-m <id>`; `copilotArgs` gains `model?: string`
  → `--model <id>`; both pure + tested; ipc passes `req.model` through (claude/opencode
  unchanged).
- The picker's chips for codex/copilot become selectable when capabilities `source ===
  'protocol'` (replacing the `modelsWired` static flag with a capability-driven one);
  the "Account default" chip remains on every provider as the null-model choice.
- `modelIdFor` consults discovered models first, then static fallback.

### 6. UI (ModelModal + composer)

- Provider page renders from `ProviderCapabilities`: models (+ per-model effort scale
  when the selected model carries one), effort chips from the real scale, default badge
  on `isDefault`, gated tint from the ledger, `fetchedAt` + a ↻ refresh control in the
  provider header.
- The modal renders instantly from cache/static and updates in place when a live
  result arrives (no blocking "Detecting…" for capabilities; the existing CLI-presence
  probe behavior is unchanged).
- Discovery failure shows one status line on the provider page: "live discovery
  unavailable — showing known set".

### 7. Error handling & degradation ladder

`protocol → static+learned → static`. Every strategy failure is caught and downgraded;
the app's floor is exactly today's shipped behavior. No renderer access to any of this
except through the typed preload bridge.

### 8. Testing & verification

- **Unit:** JSON-RPC framing/mapping fixtures (codex), copilot default-merge, ledger
  parse/merge/record, effort migration + validation, modelIdFor precedence,
  arg-builder `-m/--model` cases.
- **Live (project standard):** codex `model/list` against the real binary (non-empty,
  then `-m <a returned id>` completes end-to-end); copilot `models.list` transport
  confirmed + list retrieved; claude gating ledger exercised (known-gated id → recorded
  → surfaces in UI); GUI pass over the picker; effort chips reflect each provider's
  real scale (incl. codex per-model).
- **Docs:** dated DECISIONS entry superseding the M4 lock, in the same change.

## Out of scope (v1)

- Service/speed tiers, personality, webSearch/imageGeneration capability flags.
- Moving codex runs onto app-server as the execution transport (separate milestone).
- Copilot/claude API-key-based enumeration (violates the wrapper invariant).
- Auth-state probing (login flows stay in the CLIs).
