# Provider-first model picker with real per-provider options

**Date:** 2026-07-08 · **Status:** approved design, pre-implementation

## Problem

The Model & provider modal today renders a hardcoded five-provider catalog as one flat
scroll of model chips. Three problems (owner feedback, 2026-07-08):

1. It shows providers that aren't actually usable (Cursor appears as "Expired" but has
   no adapter at all); availability is not detected.
2. Navigation should be provider-first: pick a provider, then see its models — not one
   long chip wall.
3. Per-provider capabilities aren't selectable: context-window variant (e.g. Sonnet 1M),
   fast mode, and thinking/effort level are either missing or fake (the composer
   "Thinking" pill cycles UI state that is never sent to any harness).

## Decisions made during brainstorming

- **"Context option" = context-window variant** (e.g. Sonnet 1M), modeled as a model
  variant, not a standalone toggle.
- **Availability = real detection** (adapter exists AND CLI binary responds), starting
  the M4 CliRegistry direction. No manual enable list, no static filtering.
- **Gated/unverifiable options: show and fail honestly.** Expose what the CLI documents;
  if the account/plan rejects it at run time, surface the harness's real error in the
  transcript and keep the setting. No silent hiding, no fake toggles.
- **The provider page owns all options** (models, variant, fast mode, effort). Composer
  pills (Thinking, YOLO) remain as shortcuts editing the same chat state.
- **Approach chosen:** lean CliRegistry in the main process + capability catalog in the
  renderer (approach 1 of 3). Full M4 (auth probing, capability caching) deferred.

## CLI ground truth (probed 2026-07-08 against installed binaries)

| Capability | claude | codex exec | copilot | opencode run |
|---|---|---|---|---|
| Effort/thinking | `--effort low\|medium\|high\|xhigh\|max` | `-c model_reasoning_effort=<v>` | `--effort/--reasoning-effort <level>` | `--variant <v>` |
| Model | `--model` alias or full name | `-m` (400s on ChatGPT accounts — gated) | `--model` (plan-gated) | `-m provider/model` |
| Fast mode | **no flag visible in `--help`** — verify during impl | n/a | n/a | n/a |
| 1M context | `[1m]` model-id syntax — **verify during impl** | n/a | n/a | n/a |

## Design

### 1. Detection — CliRegistry v0 (`src/main/runtime/registry.ts`, new)

- `ADAPTER_PROVIDERS = ['claude', 'codex', 'copilot', 'opencode']` — only providers with
  a real adapter are ever probed. Cursor leaves the catalog until it has an adapter.
- Probe = spawn `<cli> --version`, short timeout (~3s), `available` = exit 0.
  Result: `{ id: string; installed: boolean; version?: string }[]`.
- New IPC channel `registry:providers` (constant in `src/shared/runtime.ts`, handler in
  `src/main/runtime/ipc.ts`, exposed through the preload bridge). Probed at first modal
  open and re-probed on each modal open (cheap, keeps status honest).
- Version-string parsing is a pure exported function, unit-tested (pattern:
  `discovery.ts` / `parseOpenCodeModels`).

### 2. Capability catalog + chat state

**providers.ts** is reshaped: drop Cursor; each `ProviderDef` gains

```ts
interface OptionDef {
  id: 'effort' | 'fast'      // v1 option surface
  label: string
  kind: 'enum' | 'toggle'
  values?: string[]          // for enums, provider-specific levels
  note?: string              // honest caveat, e.g. "plan-gated" / "interactive-only"
}
```

`ModelDef` gains optional `variants?: { id: string; label: string }[]`
(Sonnet → `1M` variant whose id maps to the `[1m]` model syntax via `modelIdFor`).

**Chat state** (`store.ts`):
- `thinking` (existing `none|low|medium|high`) becomes the real, universal effort level.
  `none` = omit the flag (harness default). Adapters map/clamp to their own scale.
- New `chat.fast: boolean` (default false; Claude-only in v1). Persisted like `yolo`.
- 1M context selection is just a model id — no new field.

**Run plumbing:** `RunRequest` gains `thinking?: string` and `fast?: boolean`.
Each adapter's pure arg-builder (`claudeArgs`, `codexArgs`, `copilotArgs`, opencode's)
translates: claude `--effort <v>`, codex `-c model_reasoning_effort="<v>"`, copilot
`--reasoning-effort <v>`, opencode `--variant <v>`. Fast: claude only, verify-then-wire
(see §5). `sendMessage` in `store/runtime.ts` passes both from the chat.

### 3. UI — two-page modal (`ModelModal.tsx` rewritten)

- Internal state `page: 'providers' | providerId`.
- **Page 1 (providers):** one row per *detected* provider — dot, name, probed version,
  status, and the active chat's current model when this provider is active. Undetected
  providers do not render. Empty state: "No providers detected" + install hint.
- **Page 2 (provider):** ← back button, provider header, model chips (live-discovered
  for OpenCode, static otherwise), variant chips rendered inline with their base model,
  then an **Options** section: effort selector (enum chips), fast-mode toggle (Claude).
- Selection semantics unchanged: applies to the active chat only; Escape/backdrop close.
- Composer "Thinking" pill keeps cycling `chat.thinking`; YOLO unchanged.

### 4. Error handling

- No preflight validation of gated options. A rejected selection (codex `-m` 400,
  copilot plan-gated model) fails at run time; the existing `run.errored` → `endTurn`
  path already prints the harness stderr into the transcript. Verify the message is
  legible; the chat keeps its setting so the user can switch back.
- Probe failure (binary missing/timeout) = provider excluded from page 1. No error UI
  beyond the empty state.

### 5. Verification & testing

- **Unit (vitest):** registry probe parsing; each adapter arg-builder ×
  {thinking levels, fast on/off, variant ids}; `modelIdFor` variant mapping;
  modal list filtering by probe results.
- **Live verification (project standard, vs real binaries):**
  1. each effort flag accepted end-to-end (one run per provider);
  2. `[1m]` variant: works → keep; rejected → drop the variant chip and record why;
  3. fast mode headless: find the mechanism (flag/env/setting) or ship the toggle
     disabled with an "interactive-only" note. Either way the verdict is recorded.
- **Docs:** dated `docs/DECISIONS.md` entry in the same change (this also closes the
  "thinking-level wiring" item from the next-options list); update `docs/README.md`
  if this spec directory is new.

## Out of scope (v1)

- Auth-state probing and per-account verified-capability caching (full M4).
- A Cursor adapter.
- Agent-picker changes (`--agent` wiring is a separate next-option).
- Codex/copilot model *discovery* (no CLI surface exists; their catalogs stay static
  and gated selections fail honestly).
