# No-Fake-Pixels Sweep — Design

**Date:** 2026-07-09
**Status:** Approved (approach A — remove fakes, wire the real seams that already exist)
**Scope decision:** Honesty sweep only. Agent wiring (`--agent`) is DEFERRED to its own feature (net-new capability needing per-CLI probing); its fake UI surfaces are removed by this sweep rather than left lying.

## Goal

Every pixel the app shows is real or honestly marked as an estimate. Rooted in roadmap item 2 (seed chats, window/cost rows, M0-5 error/empty states) plus the fake surfaces the 2026-07-09 survey found and the five transport riders queued by the pillar-3/4 final reviews.

## Survey findings driving this spec (file references as of main @ 32c1886)

1. **Seed/demo state**: `store.ts:145-155` compile-time demo workspaces (`ws_nac`/`ws_infra`) + chats (`c1..c3`); `persist.ts:67` falls back to them on fresh install; no empty-state UX (`LeftRail.tsx:74-78`).
2. **Fake catalog**: `data/context.ts:26-43` static skills/agents/instructions/files with hand-typed token counts; fake agents (`ag-*`) and phantom files (`README.md`, `deploy.yml`) referenced by `configs.ts:10-16`, `AgentModal.tsx`, `WorkspaceModal.tsx:90-94`.
3. **Window estimates**: no per-model window table anywhere; `newChat` defaults `windowK` 200; `setModel` never resets `windowK` (`store.ts:213-221`); footer `~` unconditional (`Shell.tsx:174-176`) while the Inspector row conditions on `contextLive`; second constant `WINDOW_TOKENS=128_000` (`context.ts:47`) drives the library meter. Live windows exist only for codex (`modelContextWindow`) and opencode (`usage_update.size`).
4. **Cost**: `$0.42` placeholder (`Inspector.tsx:141`); **copilot's real cost is parsed then discarded** (`acpSession.ts` extracts `usageUpdateCost` unconditionally but folds it into usage only for opencode); codex has no cost source (either transport); `StatsModal.tsx:71` footnote wrongly claims copilot cost is unavailable.
5. **M0-5 gaps**: Inspector CLI-connections panel is compile-time `authenticated` for all providers (`data/providers.ts:29-65`) while a real probe (`registry:providers` → `probeProviders()`) already feeds `ModelModal`; Re-auth button is a `useState` flip (`Inspector.tsx:13,41,48-54`); compaction failure is silent (`store.ts:252-282`); footer literals `MCP not checked`, `@you`, `Version 0.10.0` (`Shell.tsx:14,171-177`; package.json says 0.0.0).
6. **Outright bug**: ⌘K "New chat" closes the palette without calling `newChat()` (`CommandPalette.tsx:31`).
7. **Riders** (pillar-3/4 final reviews): fail-open model-switch ledger attribution (can overwrite a prior `gated` with a false `works`); Stop during the `set_config_option` await still starts the turn; thinking-row detection keys off `kind === 'reasoning'` instead of the row id; `cost.amount` per-turn-vs-cumulative semantics unverified for nonzero values; `AcpSession.runTurn` orchestration has no stateful tests (JsonRpcClient not injectable).

## Design

### 1. Fresh state & empty-state UX

- Remove `seedChats` and the demo `workspaces` from the store's initial state. Initial state: ONE workspace `{ id: 'ws_default', name: 'Workspace', path: '' }`, zero chats, `activeChatId: ''`.
- `persist.ts`: hydration keeps existing behavior for non-empty persisted state (users' real chats are untouched); the "only overwrite when ≥1 chat" special case goes away (nothing fake left to protect).
- Empty-state UI: LeftRail shows "No chats yet — ⌘N or + Chat" copy when a workspace has zero chats; ChatView (no active chat) renders a create-first-chat hero (one button → `newChat()`). All components must tolerate `activeChatId: ''` / missing active chat without crashing (survey: several `active.x` reads assume a chat exists — audit `Inspector`, `Shell` footer, `ChatView`, `StatsModal`).
- `Chat.agent` and `Workspace.defaults.agent` are removed (see §2); `normalizeChat`/workspace hydration drops the fields from old persisted state.

### 2. Fake catalog & deferred-agent surface removal

- `data/context.ts`: remove the fake agent items (`ag-*`) and phantom file items; keep skills/instructions that carry REAL content strings (they genuinely inject). Token counts for kept items: recompute with the existing `Math.ceil(content.length / 4)` estimate at module init instead of hand-typed numbers.
- `data/configs.ts`: drop references to removed ids.
- Remove `AgentModal.tsx`, the composer agent chip (`ChatView.tsx:153-155`), `WorkspaceModal`'s default-agent select, `setAgent`, and the `Inspector` attached-context "Agents" row. These return with the real `--agent` feature.
- `WINDOW_TOKENS` constant deleted; `ContextLibrary`'s budget meter reads the ACTIVE chat's `windowK` (falls back to 128 only when no chat exists).

### 3. Real window & cost metering

- **Window table**: `src/shared/capabilities.ts` model entries gain `contextWindowK?: number` with documented values (claude: Opus/Sonnet 200, Sonnet-1M 1000, Haiku 200; codex: from capability discovery when `model/list` supplies it, else static per known model; copilot: 128 static for its catalog; opencode: from `configOptions` when discovery supplies it, else 200 static). New helper `windowKFor(caps, provider, model): number` (fallback 200). `newChat` and `setModel` seed/reset `windowK` via it; live `usage.updated.contextWindow` still overrides.
- **Footer honesty** (`Shell.tsx`): `~` prefix conditional on `!active.contextLive` (same rule as Inspector); when no active chat, the metering line is omitted.
- **Copilot cost**: in `acpSession.ts` `runTurn`, fold `turnCost` into `run.completed.usage` for BOTH ACP profiles (usage objects become `{ inputTokens, outputTokens, costUsd? }` for copilot too, using the prompt-response usage when present, else zeros + cost). Correct the `StatsModal` footnote (copilot reports real cost via ACP `usage_update`).
- **costFor** (Inspector): real accumulated > 0 → `$X.XX` (2dp; `<$0.01` renders `<$0.01`, not `$0.00`); opencode chats on `lmstudio*` models → `free · local`; metered turns (any provider) with zero accumulated cost → `$0.00`; zero turns → `—`. `$0.42` is deleted.
- **Identity/version**: `@you` chips removed (top bar, status bar, rail footer). Footer version: new `app:version` IPC (main returns `app.getVersion()`), preload-exposed, rendered in the footer; "MCP not checked" removed (the Inspector's honest "No MCP servers configured" panel stays).

### 4. M0-5 error/empty states

- **CLI connections panel** (`Inspector.tsx`): replace the static `data/providers.ts` status array with the real probe — reuse the ModelModal's `window.nac.registry.providers()` load (share a small hook `useProviderProbe()`; cache per mount, manual refresh icon). States: probing (spinner), per-provider `authenticated` (green) / `not installed` (grey) / `error` (amber, with the probe's message on hover). The fake Re-auth button is REMOVED.
- **Compaction failure**: `compactChat` failure sets a transient `compactError: string` on the chat (cleared on next compact attempt or chat switch); `ChatView` renders it inline next to the Compact button ("Compaction failed — transcript unchanged"). Persisted state never stores it (hydration drops).
- **⌘K New chat**: wire to `newChat()` + close.

### 5. Transport riders

- **Fail-open attribution**: `run.completed` gains OPTIONAL `modelMismatch?: boolean` (canonical-union field addition, same precedent as P2's `usage`). `AcpSession.runTurn` sets it when `set_config_option` failed (requested ≠ applied). ipc's works-recording skips when `modelMismatch === true` (compose with `isWorksEvidence`). DECISIONS' "known attribution gap" entry is closed by this.
- **Cancel-during-config-await**: after the `set_config_option` await in `runTurn`, `if (this.interrupted)` → expire/close/emit `run.completed` canceled WITHOUT sending `session/prompt`.
- **Thinking-row predicate**: session handler detects the synthetic row via `e.toolCallId.startsWith(THINKING_ROW_PREFIX)`, not `kind === 'reasoning'`.
- **Cost semantics probe**: one-off live probe (implementation step, not committed): two+ consecutive turns on an opencode hosted model, capture `usage_update.cost.amount` per turn — if cumulative, fold the DELTA per turn into `run.completed.usage.costUsd`; if per-turn, keep as-is. Either way, pin with a fixture comment. If no nonzero-cost model is available on the account, keep current behavior and record the open question in DECISIONS (fail-honest).
- **AcpSession injectability + stateful tests**: constructor accepts an optional `clientFactory?: () => JsonRpcClientLike` (interface extracted for the methods AcpSession uses: request/notify/onNotification/onRequest/onClose/isClosed/close). New stateful tests drive `runTurn` with a scripted fake client: ordering (expirePermissions → closeThinkingRow → empty-turn notice → terminal), interrupted mapping, fail-open model switch sets `modelMismatch`, cancel-during-config-await bail-out, per-turn state reset.

## Error handling

- Probe failures in the CLI panel render the amber error state (never crash, never fake green).
- `windowKFor` unknown model → 200 fallback (an estimate — footer/Inspector still show `~` until live data).
- All removals are hydration-safe: `normalizeChat`/workspace normalization silently drops `agent`, `compactError`, and references to removed context-item ids in `attachedIds`.

## Testing

- Store: fresh-state shape (one empty workspace, no chats), empty-state selectors, `windowK` reseed on setModel, costFor matrix, compactError lifecycle, attachedIds cleanup of removed ids.
- Shared: `windowKFor` table + fallback.
- Transport: the new stateful AcpSession suite (scripted fake client) covering the riders; `modelMismatch` → no works-recording (ledger test).
- **Live computer-use matrix (mandatory final task):** fresh-install boot with a scratch `nac-state.json` (true first-run: one empty workspace, hero, no demo chats); create-first-chat flow; real CLI-connections panel vs the machine's actual CLIs (all four authenticated here — also temporarily PATH-hide one CLI to see `not installed` for real); footer `~` honesty on a live-metered codex/opencode chat vs an estimate chat; cost rows (claude real $, copilot real $ after the fix, opencode free · local, fresh chat `—`); ⌘K New chat; version string matches package.json; regression smokes on all four transports (shared seams moved).

## Non-goals

Agent wiring / real agent discovery (own feature next). Real re-auth flows. MCP integration. Context-library discovery scan (roadmap #3). Codex cost (no source exists — Stats keeps `—` honestly).
