# No-Fake-Pixels Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every pixel is real or honestly marked as an estimate — fresh-install empty state, per-model window table, real cost everywhere it exists, real CLI-connection status, plus the five transport riders.

**Architecture:** Removals (seed chats, fake catalog entries, fake agent surfaces, fake literals) + rewires onto seams that already exist (registry probe IPC, usage events, capability catalog, app.getVersion). One new optional field on the canonical `run.completed` event (`modelMismatch`). AcpSession gains an injectable client factory enabling its first stateful tests.

**Tech Stack:** Electron + React + TS, zustand store, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-09-no-fake-pixels-sweep-design.md`.

## Global Constraints

- Replay invariant untouched: `buildReplayPrompt` reads only `turn.text`.
- ONE canonical AgentEvent union — the ONLY change is `run.completed` gaining OPTIONAL `modelMismatch?: boolean` (precedent: P2's `usage`).
- Hydration-safe removals: `normalizeChat`/workspace normalization drops `agent`, `compactError`, and attachedIds referencing removed context-item ids. Existing users' persisted chats must survive unchanged otherwise.
- Copy strings (exact): empty rail "No chats yet"; chat hero button "Start your first chat"; compaction error "Compaction failed — transcript unchanged"; cost em dash "—"; local cost "free · local".
- costFor matrix (exact): accumulated real > 0 → `$X.XX` (2dp, `<$0.01` for positive sub-cent); opencode chats whose model id starts with `lmstudio` → 'free · local'; any provider with ≥1 metered turn and zero accumulated cost → '$0.00'; zero turns → '—'.
- windowKFor fallback 200; footer `~` conditional on `!contextLive` (identical rule to the Inspector row).
- Copilot behavior may now include `usage` on run.completed (deliberate change this sweep — cost honesty beats the P4 bit-identical framing; ledger gate for copilot is UNTOUCHED).
- All tests green + `npm run typecheck` clean before every commit. Work in the existing worktree `/Users/nathanielfife/Code/nac-code/.claude/worktrees/no-fake-pixels` (branch worktree-no-fake-pixels, base 3fdba95). NEVER touch the main checkout.

---

### Task 1: per-model window table + windowK reseed

**Files:**
- Modify: `src/shared/capabilities.ts`
- Modify: `src/shared/runtime.ts` (ProviderModel type gains `contextWindowK?`)
- Modify: `src/renderer/src/store/store.ts` (`newChat`, `setModel`)
- Test: `src/shared/capabilities.test.ts`, `src/renderer/src/store/store.test.ts`

**Interfaces:**
- Produces: `windowKFor(provider: string, modelLabel: string, caps?: ProviderCapabilities): number` exported from `src/shared/capabilities.ts` — checks live caps then STATIC_CAPABILITIES for a model (or variant) whose label matches, returns its `contextWindowK ?? 200`; unknown model → 200.

- [ ] **Step 1: Failing tests**

```ts
// append to src/shared/capabilities.test.ts
describe('windowKFor', () => {
  it('resolves per-model windows from the static floor, variants included', () => {
    expect(windowKFor('claude', 'Opus 4.8')).toBe(200)
    expect(windowKFor('claude', 'Sonnet 4.6 · 1M')).toBe(1000)
    expect(windowKFor('claude', 'Haiku 4.5')).toBe(200)
  })
  it('prefers live caps and falls back to 200 for unknown models', () => {
    const caps = { provider: 'codex', source: 'live', fetchedAt: 1, efforts: [], models: [{ id: 'gpt-5.5', label: 'GPT-5.5', contextWindowK: 272 }] } as never
    expect(windowKFor('codex', 'GPT-5.5', caps)).toBe(272)
    expect(windowKFor('codex', 'Mystery Model')).toBe(200)
  })
})
```

```ts
// append to src/renderer/src/store/store.test.ts
it('setModel reseeds windowK from the model table (stale denominators die)', () => {
  const s = useApp.getState()
  s.setModel('claude', 'Sonnet 4.6 · 1M')
  expect(useApp.getState().chats[s.activeChatId].windowK).toBe(1000)
  s.setModel('claude', 'Opus 4.8')
  expect(useApp.getState().chats[s.activeChatId].windowK).toBe(200)
})
```

- [ ] **Step 2: Verify RED. Step 3: Implement.** `src/shared/runtime.ts`: the provider-model interface (find `ProviderModel`/the `models:` element type) gains `contextWindowK?: number`. `capabilities.ts`: claude models gain `contextWindowK: 200` (opus/sonnet/haiku) and the sonnet variant `{ id: 'sonnet[1m]', label: 'Sonnet 4.6 · 1M', contextWindowK: 1000 }`; add:

```ts
/** Per-model context window in K tokens: live caps first, then the static floor, else 200 (an estimate). */
export function windowKFor(provider: string, modelLabel: string, caps?: ProviderCapabilities): number {
  for (const source of [caps, STATIC_CAPABILITIES[provider]]) {
    for (const m of source?.models ?? []) {
      if (m.label === modelLabel && m.contextWindowK) return m.contextWindowK
      const v = m.variants?.find((x) => x.label === modelLabel)
      if (v) return v.contextWindowK ?? m.contextWindowK ?? 200 // variants inherit the parent's window
    }
  }
  return 200
}
``` `store.ts`: `setModel` sets `windowK: windowKFor(provider, model, s.caps[provider])` alongside its existing resets; `newChat` seeds `windowK: windowKFor(provider, model, s.caps[provider])` instead of `src?.windowK ?? 200` (import from '../../../shared/capabilities' — match the file's existing import path style for shared modules).
- [ ] **Step 4: GREEN + full suite + typecheck. Step 5: Commit** — `git commit -m "feat(sweep): per-model context-window table; setModel/newChat reseed windowK"`

---

### Task 2: fresh state + empty-state UX

**Files:**
- Modify: `src/renderer/src/store/store.ts` (initial state ~lines 145-155; `selectActiveChat` and any `active.` consumer assumptions)
- Modify: `src/renderer/src/store/persist.ts` (~line 67 gate)
- Modify: `src/renderer/src/components/LeftRail.tsx`, `src/renderer/src/components/ChatView.tsx`, `src/renderer/src/components/Shell.tsx` (null-active tolerance), `src/renderer/src/components/Inspector.tsx` (null-active tolerance)
- Test: `src/renderer/src/store/store.test.ts`, `src/renderer/src/store/persist.test.ts`

**Design notes:** initial state = one workspace `{ id: 'ws_default', name: 'Workspace', path: '' }`, `chats: {}`, `activeChatId: ''`. `selectActiveChat` currently assumes a chat exists — make it return `Chat | undefined` OR keep a synthetic empty-chat object; DECISION: return `undefined` and guard consumers (`Shell` StatusBar omits the metering span; `Inspector` renders a small "No active chat" body; `ChatView` renders the hero: headline "No fake pixels here — start something real." is NOT the copy; use plain "Start your first chat" button that calls `newChat()` (check `newChat`'s signature for required args — it may take provider/model defaults from the workspace; use its existing invocation from LeftRail's + Chat button)). LeftRail: workspace with zero chats renders `<div>No chats yet</div>` muted copy above the existing + button. `persist.ts`: hydrate whatever is on disk (even zero chats); only fall back to initial state when no file exists — and the initial state is now the empty one either way.

- [ ] **Step 1: Failing tests**

```ts
// store.test.ts — NOTE: existing tests may assume seed chats exist (activeChatId 'c1' etc.).
// Update their setup: most already create their own chats via newChat/pushTurn; where a test
// relies on a seeded chat, insert `s.newChat()` first. The two new tests:
it('fresh state has one empty workspace and no chats', () => {
  // exercise the raw initial state factory (export it as INITIAL_STATE or reconstruct via a fresh store if the file exposes one;
  // simplest: assert the module-level constants the initial state is built from)
  expect(useApp.getState().workspaces.some((w) => w.id === 'ws_default')).toBe(true)
})
it('newChat works from the empty state (first-chat flow)', () => {
  const s = useApp.getState()
  s.newChat()
  expect(Object.keys(useApp.getState().chats).length).toBeGreaterThan(0)
  expect(useApp.getState().activeChatId).not.toBe('')
})
```

```ts
// persist.test.ts
it('hydrates an EMPTY persisted state without resurrecting demo chats', () => {
  // feed loadState-equivalent an empty chats object through the exported normalize path used by initPersistence
  // (persist.test.ts already tests normalizeChat — follow its existing harness pattern for the gate)
})
```

The persist test must follow the file's existing test harness (read it first); the assertion: given `{ chats: {}, workspaces: [...] }`, the hydrated store has zero chats and does NOT contain ids `c1`/`c2`/`c3`.
- [ ] **Step 2: RED (store initial state still seeds demos). Step 3: Implement** per the design notes. Vitest runs share module state — the store module's initial state change will ripple through existing tests; fix their setup minimally (prefer adding `newChat()` to affected tests' arrange step over keeping any seed).
- [ ] **Step 4: GREEN + typecheck. Step 5: Commit** — `git commit -m "feat(sweep): fresh installs boot empty — demo chats/workspaces removed, real empty states"`

---

### Task 3: fake catalog trim + deferred-agent surface removal

**Files:**
- Modify: `src/renderer/src/data/context.ts`, `src/renderer/src/data/configs.ts`
- Delete: `src/renderer/src/components/AgentModal.tsx`
- Modify: `src/renderer/src/components/Shell.tsx` (drop AgentModal import/case), `src/renderer/src/components/ChatView.tsx` (composer agent chip), `src/renderer/src/components/WorkspaceModal.tsx` (default-agent select), `src/renderer/src/components/Inspector.tsx` (TYPE_ORDER drops 'agent'), `src/renderer/src/components/ContextLibrary.tsx` (WINDOW_TOKENS → active chat windowK)
- Modify: `src/renderer/src/store/store.ts` (remove `Chat.agent`, `setAgent`, modal type 'agent'; `Workspace.defaults` agent field), `src/renderer/src/store/persist.ts` (drop `agent`, filter attachedIds)
- Test: `src/renderer/src/store/persist.test.ts`, `src/renderer/src/data/providers.test.ts` untouched; context tokens test in a new small block

**Design notes:**
- `context.ts`: remove items `ag-nac`, `ag-infra`, `ag-reviewer`, `ag-frontend`, `fl-readme`, `fl-spec`, `fl-deploy`, `fl-plan`, `fl-tokens`, and content-less `sk-debug`, `sk-brainstorm`, `sk-review`, `in-commit` (keep ONLY items with real `content`: `sk-tdd`, `in-style`, `in-security`). Kept items' `tokens` become `Math.ceil(content.length / 4)` computed inline (`tokens: est('...')` with `const est = (c: string) => Math.ceil(c.length / 4)` — or compute after the array literal; keep it simple). `ItemType` keeps 'agent'/'file' (user file-attach items still use 'file'; TYPE_META stays).
- `configs.ts`: CONFIGURATIONS shrink to bundles referencing only surviving ids: `standard: ['sk-tdd','in-style']`, `security: ['in-security','in-style']`, `minimal: ['in-style']` (names 'Standard', 'Security', 'Minimal').
- `persist.ts` normalizeChat: `attachedIds: m.attachedIds?.filter((id) => ITEMS_BY_ID[id] || <userItems membership>)` — check how userItems hydrate; filter against `ITEMS_BY_ID` for non-user ids only (user item ids start with their existing prefix — read `addNote`/`addFileItem` to confirm, e.g. `u_`), plus drop the `agent` field.
- `ContextLibrary.tsx:27-28`: replace `WINDOW_TOKENS` with `(activeChat?.windowK ?? 128) * 1000`; `budgetColor` thresholds become fractions of the window (green <60%, amber 60-85%, red >85%) instead of absolute constants.
- Grep for every `chat.agent`/`setAgent`/`'agent'` modal usage before deleting; ChatView's chip and WorkspaceModal's select go entirely.

- [ ] **Step 1: Failing test** (persist migration):

```ts
// persist.test.ts
it('drops the removed agent field and dead attachedIds on hydrate', () => {
  // via the file's normalize harness: a chat with agent: 'ag-nac' and attachedIds ['sk-tdd','ag-nac','fl-readme']
  // hydrates with no agent property and attachedIds ['sk-tdd']
})
```

(Write it against the real harness in the file.)
- [ ] **Step 2: RED. Step 3: Implement (grep-audit every removed symbol; typecheck is the net). Step 4: GREEN + full suite. Step 5: Commit** — `git commit -m "feat(sweep): remove fake catalog entries and deferred-agent UI surfaces"`

---

### Task 4: metering honesty — copilot cost, costFor, footer, version, working dir

**Files:**
- Modify: `src/main/runtime/acp/acpSession.ts` (ungate the cost fold-in)
- Modify: `src/renderer/src/components/Inspector.tsx` (costFor + Working dir row)
- Modify: `src/renderer/src/components/Shell.tsx` (footer: conditional `~`, drop `@you`/`MCP not checked`, real version), `src/renderer/src/components/StatsModal.tsx` (footnote)
- Modify: `src/main/index.ts` or the ipc module (new `app:version` handle), `src/preload/index.ts` (expose `window.nac.app.version()`)
- Test: `src/renderer/src/store/store.test.ts` (costFor moves to a pure exported helper — put it in `src/renderer/src/store/store.ts` or a new `src/renderer/src/data/format.ts`; DECISION: new file `src/renderer/src/data/format.ts` exporting `costLabel(chat: Pick<Chat, 'provider' | 'model' | 'usage'>): string`), new `src/renderer/src/data/format.test.ts`, `src/main/runtime/acp/acpSession.test.ts`

- [ ] **Step 1: Failing tests**

```ts
// src/renderer/src/data/format.test.ts
import { describe, it, expect } from 'vitest'
import { costLabel } from './format'

const chat = (provider: string, model: string, usage: Record<string, { turns: number; inputTokens: number; outputTokens: number; costUsd: number }>) =>
  ({ provider, model, usage }) as never

describe('costLabel', () => {
  it('shows real accumulated dollars', () => {
    expect(costLabel(chat('claude', 'Opus 4.8', { claude: { turns: 3, inputTokens: 1, outputTokens: 1, costUsd: 1.234 } }))).toBe('$1.23')
  })
  it('sub-cent positive cost is <$0.01, never $0.00', () => {
    expect(costLabel(chat('claude', 'Opus 4.8', { claude: { turns: 1, inputTokens: 1, outputTokens: 1, costUsd: 0.004 } }))).toBe('<$0.01')
  })
  it('opencode local models are free · local', () => {
    expect(costLabel(chat('opencode', 'lmstudio-local/qwen/qwen3.6-27b', {}))).toBe('free · local')
  })
  it('metered turns with zero cost are an honest $0.00', () => {
    expect(costLabel(chat('opencode', 'opencode/big-pickle', { opencode: { turns: 2, inputTokens: 1, outputTokens: 1, costUsd: 0 } }))).toBe('$0.00')
  })
  it('no turns yet is an em dash', () => {
    expect(costLabel(chat('codex', 'GPT-5.5', {}))).toBe('—')
  })
})
```

```ts
// acpSession.test.ts addition (pure): the copilot gate is structural — pin it via the stateful suite
// arriving in Task 6; here add only the shape note. SKIP a test in this task; Task 6's fake-client
// suite asserts copilot run.completed carries usage {costUsd} when usage_update flowed.
```

- [ ] **Step 2: RED. Step 3: Implement.**
  - `format.ts`: implement `costLabel` per the matrix (order: real>0 branches first incl. `<$0.01`; then `provider==='opencode' && model.startsWith('lmstudio')` → 'free · local'; then `Object.values(usage).some(u => u.turns > 0)` → '$0.00'; else '—'). Inspector imports it; delete the local `costFor`.
  - `acpSession.ts` `runTurn`: build `usage` for BOTH profiles: `{ inputTokens: n(u?.inputTokens), outputTokens, ...(this.turnCost !== null ? { costUsd: this.turnCost } : {}) }` — drop the `provider === 'opencode'` gate around it. (mapAcpUpdate's usage_update case stays opencode-gated for the EVENT; copilot's cost extraction happens via `usageUpdateCost` which is already unconditional. VERIFY live during Task 7 that copilot actually emits usage_update frames — if it never does, `turnCost` stays null and copilot's usage carries only tokens, which is still honest.)
  - `Shell.tsx` StatusBar: drop the `@you` span + `MCP not checked`; metering span becomes `{active ? `${active.attachedIds.length} attached · ${active.contextLive ? '' : '~'}${active.contextK}k / ${active.windowK}K tokens` : 'no active chat'}`; version span renders state from `window.nac.app.version()` (useEffect + useState, fallback '');
  - main ipc: `ipcMain.handle('app:version', () => app.getVersion())`; preload exposes `app: { version: () => ipcRenderer.invoke('app:version') }` following the existing preload bridge pattern; TopBar's `@you` chip (Shell.tsx:144-146) removed; `const ACCOUNT` deleted.
  - `Inspector.tsx` Working dir row: replace the literal with the active chat's workspace path (`useApp` → workspaces.find by `active.workspaceId`, render its `path || '(no folder)'`).
  - `StatsModal.tsx` footnote: replace the copilot no-cost claim with "copilot reports cost via ACP usage frames".
- [ ] **Step 4: GREEN + full suite + typecheck + build. Step 5: Commit** — `git commit -m "feat(sweep): real cost/version/footer metering — the last placeholder dollars die"`

---

### Task 5: M0-5 — real CLI panel, compaction error, palette fix

**Files:**
- Modify: `src/renderer/src/components/Inspector.tsx` (CLI Connections panel), new hook `src/renderer/src/hooks/useProviderProbe.ts` (or colocate; check for an existing hooks dir — ModelModal keeps its own load; extract shared hook)
- Modify: `src/renderer/src/components/ModelModal.tsx` (consume the shared hook — keep behavior identical)
- Modify: `src/renderer/src/store/store.ts` (`compactChat` failure sets `compactError`; `clearCompactError`), `src/renderer/src/store/persist.ts` (drop compactError), `src/renderer/src/components/ChatView.tsx` (inline error next to Compact)
- Modify: `src/renderer/src/components/CommandPalette.tsx:31` (wire `newChat`)
- Delete usage of: `src/renderer/src/data/providers.ts` static statuses in Inspector (the file may still serve labels/colors — trim to what survives; if nothing imports the static PROVIDERS array afterwards, delete it and its test's stale parts)
- Test: `src/renderer/src/store/store.test.ts` (compactError lifecycle)

**Design notes:** `useProviderProbe()` returns `{ probing: boolean, providers: DetectedProvider[] | null, refresh: () => void }` wrapping `window.nac.registry.providers()` (read ModelModal.tsx:56-75 for the existing call shape + types). Inspector panel rows render real ids with status pill: authenticated (green) / `not installed` (grey) / error string (amber, title-attr hover). No Re-auth button (delete `miniBtn`/`reauthed`). Palette: `run: () => { newChat(); close() }` using the store action (read how other palette commands invoke store actions).

- [ ] **Step 1: Failing test (compactError)**

```ts
// store.test.ts — follow compactChat's existing test/mocking pattern (it calls window.nac summarize IPC;
// the test suite already stubs window.nac somewhere — find and extend it)
it('compaction failure sets a transient inline error and leaves the transcript intact', async () => {
  // arrange a chat with messages; stub the summarize IPC to reject; await compactChat
  // assert chats[id].compactError === 'Compaction failed — transcript unchanged'
  // assert messages unchanged; then s.clearCompactError(id) → undefined
})
```

- [ ] **Step 2: RED. Step 3: Implement all four surfaces. Step 4: GREEN + typecheck. Step 5: Commit** — `git commit -m "feat(sweep): real CLI-connections panel, compaction error state, palette New chat (M0-5)"`

---

### Task 6: transport riders

**Files:**
- Modify: `src/shared/runtime.ts` (`run.completed` gains `modelMismatch?: boolean`)
- Modify: `src/main/runtime/acp/acpSession.ts` (modelMismatch on fail-open; cancel-during-config bail; thinking predicate; injectable client factory)
- Modify: `src/main/runtime/ipc.ts` (works-recording skips on modelMismatch)
- Modify: `src/main/runtime/capabilities/ledger.ts` (`isWorksEvidence` gains the mismatch param — signature: `isWorksEvidence(stopReason: string, usage?: { outputTokens?: number }, modelMismatch?: boolean)`)
- Test: `src/main/runtime/capabilities/ledger.test.ts`, `src/main/runtime/acp/acpSession.test.ts` (NEW stateful suite)

**Design notes:**
- Extract `interface JsonRpcClientLike { request(m: string, p?: unknown, t?: number): Promise<unknown>; notify(m: string, p?: unknown): void; onNotification(m: string, h: (p: unknown) => void): void; onRequest(m: string, h: (p: unknown) => Promise<unknown> | unknown): void; onClose(h: () => void): void; readonly isClosed: boolean; close(): void }` in acpSession.ts; constructor gains optional 4th param `clientFactory?: () => JsonRpcClientLike` (default `() => new JsonRpcClient(profile.command, profile.args)`).
- runTurn: after the set_config_option try/catch — on catch set `this.modelMismatchThisTurn = true`; then `if (this.interrupted) { this.expirePermissions(); this.closeThinkingRow(); this.onEvent({ type: 'run.completed', runId, stopReason: 'canceled' }); return }` (inside the try, before session/prompt; the finally still clears currentRunId). run.completed spreads `...(this.modelMismatchThisTurn ? { modelMismatch: true } : {})`; the flag resets in prompt().
- Thinking predicate: the session/update handler's reasoning check becomes `e.type === 'tool.updated' && e.toolCallId.startsWith(THINKING_ROW_PREFIX)` (and the else-branch close check excludes those rows).
- ipc: works-condition becomes `isWorksEvidence(event.stopReason, event.usage, event.modelMismatch)`.
- **Stateful suite** (the payoff): a `FakeClient implements JsonRpcClientLike` with scripted responses per method + recorded sends. Tests: (1) ordering on success: expire→thinking-close→(notice?)→run.completed; (2) interrupted maps any stopReason to canceled; (3) fail-open: set_config_option rejects → session/prompt still sent → run.completed carries modelMismatch: true; (4) cancel-during-config-await: interrupt while set_config_option pending → NO session/prompt sent, run.completed canceled; (5) per-turn state reset (second prompt has clean flags); (6) copilot profile run.completed carries usage with costUsd when a usage_update frame flowed (Task 4's ungate). Write the fake so `onNotification` handlers are capturable and the test can inject `session/update` frames between prompt issuance and response resolution.
- Ledger tests: `isWorksEvidence('end_turn', { outputTokens: 5 }, true)` → false; existing cases keep passing with the param absent.
- **Cost-semantics probe** (one-off, not committed): two consecutive turns on an opencode HOSTED model via a scratch ACP script, print `cost.amount` per usage_update; if cumulative across turns, change the fold to per-turn delta (`this.turnCost = amount - this.sessionCostBase` bookkeeping) and note in the fixture doc; if per-turn or only zeros available, keep as-is and append one line to docs/research/opencode-acp-1.17.11.txt recording what was observed. Report the outcome.

- [ ] **Step 1: Failing tests (ledger + the stateful suite). Step 2: RED. Step 3: Implement. Step 4: GREEN + full suite + typecheck. Step 5: Commit** — `git commit -m "feat(sweep): transport riders — mismatch attribution, cancel-during-config bail, stateful AcpSession tests"`

---

### Task 7: live verification (controller, computer use) + docs + final review

**Files:**
- Modify: `docs/DECISIONS.md`

- [ ] **Step 1: Live matrix** (controller drives; adversarial):
  1. **True first-run**: stop the dev app; move `~/Library/Application Support/nac-code/nac-state.json` aside (restore after!); launch → one empty "Workspace", "No chats yet" rail copy, hero button → first chat created and usable. No demo chats anywhere.
  2. Restore the real state file; relaunch → all existing chats intact (hydration unchanged), removed fields dropped silently.
  3. CLI-connections panel: real probe shows the machine's actual four authenticated CLIs; PATH-hide one CLI (shim dir without it) + refresh → `not installed` grey for that provider; unhide → green.
  4. Footer honesty: codex or opencode chat mid-live-turn shows NO `~`; a claude chat shows `~` until its live usage lands; version string equals `package.json` version; no `@you`, no "MCP not checked".
  5. Cost rows: fresh chat `—`; claude chat accumulates real $; copilot chat after a turn shows real $ (the ungated fold) or honest tokens-only if no usage_update flows (record which); opencode local `free · local`.
  6. Window numbers: switch a claude chat Sonnet→Sonnet 1M → denominator 1000K immediately (table reseed); Inspector Working dir shows the real workspace path.
  7. ⌘K → New chat actually creates one.
  8. Agent surfaces gone: no agent chip in composer, no Agent modal anywhere, workspace modal has no default-agent select.
  9. Regression smokes: one interactive turn each on claude, codex, copilot, opencode (shared seams moved — Task 6 touched AcpSession; Task 4 its usage shape).
  10. Compaction error: unit-covered; live only if cheaply triggerable (skip otherwise, note in ledger).
- [ ] **Step 2: Final gate** — `npm run typecheck && npx vitest run && npm run build`.
- [ ] **Step 3: DECISIONS entry** at the top of Current phase (replace `<commit>`) + roadmap item 2 checked off (next: #3 context library polish or the deferred agent feature — list both):

```markdown
**✅ No-fake-pixels sweep** (`<commit>`): every pixel is real or marked as an estimate. Fresh installs boot EMPTY (demo chats/workspaces deleted; real first-run hero — verified live with a scratch state file). Per-model context-window table (windowKFor) reseeds windowK on model switch — stale denominators die; footer adopts the Inspector's `~` honesty convention. Cost: copilot's parsed-then-discarded ACP cost now folds into run.completed (Stats footnote corrected); costLabel matrix (`$X.XX` / `<$0.01` / `free · local` / honest `$0.00` / `—`) replaces the $0.42 placeholder. Fake CLI-connections panel replaced by the real registry probe (live states verified incl. a PATH-hidden CLI showing `not installed`); the fake Re-auth button is gone (real re-auth = future feature). Compaction failure surfaces inline ("Compaction failed — transcript unchanged"). @you/`MCP not checked`/hardcoded version replaced (app:version IPC). ⌘K New chat fixed (was a no-op). Deferred-agent UI surfaces removed until the real --agent feature. Transport riders closed: fail-open model switches mark run.completed modelMismatch (ledger skips works — the P4 attribution gap CLOSED), Stop during the config await no longer starts the turn, thinking-row detection keys on the row id, AcpSession gained an injectable client + its first stateful runTurn suite, cost-accumulation semantics probed and pinned. Spec: `docs/superpowers/specs/2026-07-09-no-fake-pixels-sweep-design.md`.
```

- [ ] **Step 4: Commit** — `git add docs/DECISIONS.md && git commit -m "docs: no-fake-pixels sweep done — verified live incl. true first-run"`

Then: final whole-branch review (most capable model), one fix subagent, re-review, finishing-a-development-branch.
