# Provider-First Model Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provider-first model picker showing only really-detected providers, with real per-provider options (effort/thinking on all four harnesses, Claude fast mode, Sonnet 1M context variant) wired to actual CLI flags.

**Architecture:** A lean CliRegistry in the Electron main process probes adapter-backed CLIs (`--version`) on modal open; the renderer catalog (`providers.ts`) gains capability metadata (options, model variants); each adapter's pure arg-builder translates chat state (`thinking`, `fast`, model id) into verified CLI flags; `ModelModal` becomes a two-page component (provider list → provider page).

**Tech Stack:** Electron + React + TypeScript (electron-vite), Zustand, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-08-provider-first-model-picker-design.md`

## Global Constraints

- Wrapper, never a harness: adapters spawn harness CLIs; no model endpoints.
- All parsing/arg-building logic is pure, exported, and unit-tested (existing repo pattern).
- `npm run typecheck` must pass before every commit; `npx vitest run` must stay green.
- Renderer styling = inline `CSSProperties` objects + CSS variables (`var(--…)`) — match existing components.
- Verified CLI facts (2026-07-08, real binaries): `claude --effort low|medium|high|xhigh|max`; fast mode has NO flag — per-run injection via `--settings '{"fastMode":true}'` (verified accepted headless); `sonnet[1m]` model-id syntax works headless; `codex -c model_reasoning_effort=<v>`; `copilot --reasoning-effort <v>`; `opencode --variant <v>`.
- Universal effort scale in v1 = existing `ThinkingLevel` (`none|low|medium|high`); `none` = omit the flag.
- Docs: dated `docs/DECISIONS.md` entry lands in the same change as the final task.

---

### Task 1: CliRegistry v0 — detection probe + IPC + preload

**Files:**
- Create: `src/main/runtime/registry.ts`
- Create: `src/main/runtime/registry.test.ts`
- Modify: `src/shared/runtime.ts` (add `REGISTRY_CHANNELS`, `ProviderProbe`)
- Modify: `src/main/runtime/ipc.ts` (register handler)
- Modify: `src/preload/index.ts` (expose `nac.registry.providers()`)

**Interfaces:**
- Produces: `ProviderProbe { id: string; installed: boolean; version?: string }` (shared), `probeProviders(): Promise<ProviderProbe[]>`, `parseVersionLine(stdout: string): string | undefined`, `window.nac.registry.providers(): Promise<ProviderProbe[]>` (Task 5 consumes).

- [ ] **Step 1: Write the failing test** — `src/main/runtime/registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseVersionLine, ADAPTER_PROVIDERS } from './registry'

describe('parseVersionLine', () => {
  it('extracts the version token from real CLI outputs', () => {
    expect(parseVersionLine('2.0.14 (Claude Code)')).toBe('2.0.14')
    expect(parseVersionLine('codex-cli 0.46.0')).toBe('0.46.0')
    expect(parseVersionLine('0.0.339\n')).toBe('0.0.339')
  })
  it('falls back to the first line when no version token exists', () => {
    expect(parseVersionLine('dev build')).toBe('dev build')
  })
  it('returns undefined for empty output', () => {
    expect(parseVersionLine('')).toBeUndefined()
    expect(parseVersionLine('  \n ')).toBeUndefined()
  })
  it('probes exactly the adapter-backed providers', () => {
    expect([...ADAPTER_PROVIDERS]).toEqual(['claude', 'codex', 'copilot', 'opencode'])
  })
})
```

- [ ] **Step 2: Run it to verify it fails** — `npx vitest run src/main/runtime/registry.test.ts` → FAIL (module not found).

- [ ] **Step 3: Add shared types** — in `src/shared/runtime.ts`, after `CHANGES_CHANNELS`:

```ts
export const REGISTRY_CHANNELS = {
  providers: 'registry:providers'
} as const

// Live CLI detection (CliRegistry v0, starts M4): a provider is available only if NAC has an
// adapter AND its binary responds to --version.
export interface ProviderProbe {
  id: string
  installed: boolean
  version?: string
}
```

- [ ] **Step 4: Implement `src/main/runtime/registry.ts`**:

```ts
import { spawn } from 'child_process'
import type { ProviderProbe } from '../../shared/runtime'

// CliRegistry v0 (starts M4): probe each adapter-backed CLI with `--version`. Probed on each
// modal open — cheap and always honest. Cursor is absent until it has an adapter.

export const ADAPTER_PROVIDERS = ['claude', 'codex', 'copilot', 'opencode'] as const

/** Pure + exported for testing: extract a version token from `<cli> --version` stdout. */
export function parseVersionLine(stdout: string): string | undefined {
  const first = stdout.trim().split('\n')[0]?.trim()
  if (!first) return undefined
  return first.match(/\d+\.\d+[\w.-]*/)?.[0] ?? first
}

function probeOne(id: string, timeoutMs = 3000): Promise<ProviderProbe> {
  return new Promise((resolve) => {
    let settled = false
    const done = (p: ProviderProbe): void => {
      if (!settled) {
        settled = true
        resolve(p)
      }
    }
    let out = ''
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(id, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      done({ id, installed: false })
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      done({ id, installed: false })
    }, timeoutMs)
    child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')))
    child.on('error', () => {
      clearTimeout(timer)
      done({ id, installed: false })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done(code === 0 ? { id, installed: true, version: parseVersionLine(out) } : { id, installed: false })
    })
  })
}

export function probeProviders(): Promise<ProviderProbe[]> {
  return Promise.all(ADAPTER_PROVIDERS.map((id) => probeOne(id)))
}
```

- [ ] **Step 5: Run test to verify it passes** — `npx vitest run src/main/runtime/registry.test.ts` → PASS (4 tests).

- [ ] **Step 6: Register the IPC handler** — in `src/main/runtime/ipc.ts`: add `REGISTRY_CHANNELS` to the shared-runtime import list, add `import { probeProviders } from './registry'`, and inside `registerRuntimeIpc` (next to the `DISCOVERY_CHANNELS.models` handler):

```ts
  // Live CLI detection for the provider-first model picker (CliRegistry v0).
  ipcMain.handle(REGISTRY_CHANNELS.providers, () => probeProviders())
```

- [ ] **Step 7: Expose on the preload bridge** — in `src/preload/index.ts`: add `REGISTRY_CHANNELS` and `type ProviderProbe` to the shared-runtime import, and in the `api` object after `models`:

```ts
  registry: {
    providers: (): Promise<ProviderProbe[]> => ipcRenderer.invoke(REGISTRY_CHANNELS.providers)
  },
```

(`window.nac` typing flows automatically via `NacApi` → `env.d.ts`.)

- [ ] **Step 8: Verify** — `npm run typecheck && npx vitest run` → clean, 63 tests.

- [ ] **Step 9: Commit**

```bash
git add src/main/runtime/registry.ts src/main/runtime/registry.test.ts src/shared/runtime.ts src/main/runtime/ipc.ts src/preload/index.ts
git commit -m "feat(registry): CliRegistry v0 — probe adapter-backed CLIs for the model picker"
```

---

### Task 2: Effort + fast mode in the four arg builders

**Files:**
- Modify: `src/main/runtime/claudeAdapter.ts:69-75` (`claudeArgs`), `src/main/runtime/codexAdapter.ts:68-72` (`codexArgs`), `src/main/runtime/copilotAdapter.ts:43-47` (`copilotArgs`), `src/main/runtime/openCodeAdapter.ts:23-29` (`openCodeArgs`)
- Test: the four sibling `*.test.ts` files (additive cases)

**Interfaces:**
- Produces (Task 3 consumes): `claudeArgs(prompt, sessionId?, yolo?, model?, effort?: string, fast?: boolean)`, `codexArgs(prompt, yolo?, sessionId?, effort?: string)`, `copilotArgs(prompt, yolo?, sessionId?, effort?: string)`, `openCodeArgs(prompt, model?, yolo?, sessionId?, variant?: string)`. All new params optional — existing call sites/tests unaffected.

- [ ] **Step 1: Write the failing tests** — append one `describe`-level `it` per adapter test file:

`claudeAdapter.test.ts`:
```ts
  it('passes effort and injects fastMode via per-run settings', () => {
    expect(claudeArgs('hi', undefined, false, 'opus', 'high')).toEqual(expect.arrayContaining(['--effort', 'high']))
    expect(claudeArgs('hi')).not.toContain('--effort')
    expect(claudeArgs('hi', undefined, false, 'opus', undefined, true)).toEqual(expect.arrayContaining(['--settings', '{"fastMode":true}']))
    expect(claudeArgs('hi')).not.toContain('--settings')
  })
```

`codexAdapter.test.ts`:
```ts
  it('passes reasoning effort as a config override, before the resume subcommand', () => {
    const args = codexArgs('hi', false, undefined, 'high')
    expect(args).toEqual(expect.arrayContaining(['-c', 'model_reasoning_effort=high']))
    expect(codexArgs('hi')).not.toContain('-c')
    const resumed = codexArgs('hi', false, 's1', 'low')
    expect(resumed.indexOf('-c')).toBeLessThan(resumed.indexOf('resume'))
  })
```

`copilotAdapter.test.ts`:
```ts
  it('passes reasoning effort', () => {
    expect(copilotArgs('hi', false, undefined, 'medium')).toEqual(expect.arrayContaining(['--reasoning-effort', 'medium']))
    expect(copilotArgs('hi')).not.toContain('--reasoning-effort')
  })
```

`openCodeAdapter.test.ts`:
```ts
  it('passes the effort variant', () => {
    expect(openCodeArgs('hi', undefined, false, undefined, 'high')).toEqual(expect.arrayContaining(['--variant', 'high']))
    expect(openCodeArgs('hi')).not.toContain('--variant')
  })
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/main/runtime` → the 4 new tests FAIL (arity/flag missing).

- [ ] **Step 3: Implement.** Replace the four builders:

`claudeAdapter.ts`:
```ts
/** Pure + exported for testing: build the claude argv. model = alias (opus/sonnet/haiku, opt. [1m]); yolo → skip prompts. */
export function claudeArgs(prompt: string, sessionId?: string, yolo?: boolean, model?: string, effort?: string, fast?: boolean): string[] {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose']
  if (model) args.push('--model', model)
  if (effort) args.push('--effort', effort)
  if (fast) args.push('--settings', '{"fastMode":true}') // no --fast flag exists; per-run settings injection (verified 2026-07-08)
  if (yolo) args.push('--dangerously-skip-permissions')
  if (sessionId) args.push('--resume', sessionId) // continue the prior turn's session (FR-4.2)
  return args
}
```

`codexAdapter.ts`:
```ts
/** Pure + exported for testing: build the codex argv. yolo → workspace-write; sessionId → resume that thread. */
export function codexArgs(prompt: string, yolo?: boolean, sessionId?: string, effort?: string): string[] {
  // exec flags must precede the `resume` subcommand: `codex exec <flags> resume <id> <prompt>`.
  const base = ['exec', '--json', '--skip-git-repo-check', '-s', yolo ? 'workspace-write' : 'read-only']
  if (effort) base.push('-c', `model_reasoning_effort=${effort}`) // bare value: codex config parses it as a string
  return sessionId ? [...base, 'resume', sessionId, prompt] : [...base, prompt]
}
```

`copilotArgs`: after the existing `args` literal, before the `sessionId` push:
```ts
  if (effort) args.push('--reasoning-effort', effort)
```

`openCodeArgs`: after the `if (model)` push:
```ts
  if (variant) args.push('--variant', variant) // provider-specific reasoning effort
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/main/runtime` → all pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/runtime/*Adapter.ts src/main/runtime/*Adapter.test.ts
git commit -m "feat(adapters): effort/thinking flags on all four harnesses + claude fastMode injection"
```

---

### Task 3: Plumb thinking + fast from chat state to the adapters

**Files:**
- Modify: `src/shared/runtime.ts` (`RunRequest`), `src/main/runtime/ipc.ts` (pass-through), the four adapters' `start*Run` request types, `src/renderer/src/store/store.ts` (`Chat.fast`, `toggleFast`), `src/renderer/src/store/persist.ts` (`normalizeChat`), `src/renderer/src/store/runtime.ts` (`sendMessage`)
- Test: `src/renderer/src/store/store.test.ts` (additive)

**Interfaces:**
- Consumes: Task 2 builder signatures.
- Produces (Task 5 consumes): `Chat.fast: boolean`, store action `toggleFast: () => void` (active chat), `RunRequest.thinking?: string`, `RunRequest.fast?: boolean`.

- [ ] **Step 1: Write the failing store test** — append to `store.test.ts` (match the file's existing state-reset pattern):

```ts
it('toggleFast flips fast on the active chat only', () => {
  const before = useApp.getState()
  const id = before.activeChatId
  expect(before.chats[id].fast).toBe(false)
  before.toggleFast()
  const after = useApp.getState()
  expect(after.chats[id].fast).toBe(true)
  for (const [cid, c] of Object.entries(after.chats)) if (cid !== id) expect(c.fast).toBe(false)
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/renderer/src/store/store.test.ts` → FAIL (`fast` undefined / `toggleFast` missing).

- [ ] **Step 3: Store changes** in `store.ts`:
  - `Chat` interface, after `yolo: boolean`: `fast: boolean // Claude fast mode (research preview); injected per-run via --settings`
  - `base` literal (`const base = { yolo: false, thinking: 'medium' as ThinkingLevel, … }`): add `fast: false,` right after `yolo: false,`.
  - `AppState` interface, after `toggleYolo`: `toggleFast: () => void`
  - Implementation, after `toggleYolo`:
```ts
  toggleFast: () => set((s) => ({ chats: { ...s.chats, [s.activeChatId]: { ...s.chats[s.activeChatId], fast: !s.chats[s.activeChatId].fast } } })),
```
  - `newChat`'s chat literal: add `fast: false,` after `yolo: false,` (`newFromCompacted` spreads `src` and inherits it).
  - Line 45 comment: change `(claude | codex | cursor | opencode)` → `(claude | codex | copilot | opencode)`.

- [ ] **Step 4: Persistence** — `persist.ts` `normalizeChat`, after the `yolo` line: `fast: c.fast ?? false,`

- [ ] **Step 5: RunRequest** — `src/shared/runtime.ts`, inside `RunRequest`:

```ts
  thinking?: string // universal effort level (low|medium|high); each adapter maps it to its own flag. Omitted = harness default
  fast?: boolean // Claude fast mode (research preview) — injected per-run via --settings
```

- [ ] **Step 6: IPC pass-through** — `src/main/runtime/ipc.ts`, the `RUN_CHANNELS.start` ternary becomes:

```ts
    const run =
      req.provider === 'claude'
        ? startClaudeRun(runId, { prompt: req.prompt, sessionId: req.sessionId, cwd: req.cwd, yolo: req.yolo, model: req.model, effort: req.thinking, fast: req.fast }, handler)
        : req.provider === 'codex'
          ? startCodexRun(runId, { prompt: req.prompt, cwd: req.cwd, yolo: req.yolo, sessionId: req.sessionId, effort: req.thinking }, handler)
          : req.provider === 'copilot'
            ? startCopilotRun(runId, { prompt: req.prompt, cwd: req.cwd, yolo: req.yolo, sessionId: req.sessionId, effort: req.thinking }, handler)
            : req.provider === 'opencode'
              ? startOpenCodeRun(runId, { prompt: req.prompt, model: req.model, cwd: req.cwd, yolo: req.yolo, sessionId: req.sessionId, variant: req.thinking }, handler)
              : startHarnessRun(/* … */)
```

Only the four adapter branches change (each gains `effort`/`fast`/`variant` as shown); leave the final `startHarnessRun` stub branch byte-for-byte as it is today.

- [ ] **Step 7: Adapter request types** — extend each `start*Run` req type and builder call:
  - `startClaudeRun` req: `+ effort?: string; fast?: boolean`; call `claudeArgs(req.prompt, req.sessionId, req.yolo, req.model, req.effort, req.fast)`
  - `startCodexRun` req: `+ effort?: string`; call `codexArgs(req.prompt, req.yolo, req.sessionId, req.effort)`
  - `startCopilotRun` req: `+ effort?: string`; call `copilotArgs(req.prompt, req.yolo, req.sessionId, req.effort)`
  - `startOpenCodeRun` req: `+ variant?: string`; call `openCodeArgs(req.prompt, req.model, req.yolo, req.sessionId, req.variant)`

- [ ] **Step 8: Send path** — `src/renderer/src/store/runtime.ts`, in the `window.nac.runs.start({...})` call after `model:`:

```ts
      thinking: chat.thinking === 'none' ? undefined : chat.thinking, // 'none' = harness default
      fast: chat.fast || undefined,
```

- [ ] **Step 9: Verify** — `npm run typecheck && npx vitest run` → clean (fix any test literal missing `fast: false` if typecheck flags one).

- [ ] **Step 10: Commit**

```bash
git add src/shared/runtime.ts src/main/runtime/ipc.ts src/main/runtime/*Adapter.ts src/renderer/src/store
git commit -m "feat(runtime): thinking + fast mode flow from chat state to every harness run"
```

---

### Task 4: Capability catalog — reshape providers.ts

**Files:**
- Modify: `src/renderer/src/data/providers.ts` (full rewrite below)

**Interfaces:**
- Consumes: nothing new.
- Produces (Task 5 consumes): `OptionDef { id: 'effort' | 'fast'; label: string; kind: 'enum' | 'toggle'; values?: string[]; note?: string }`, `ModelVariant { id: string; label: string }`, `ModelDef.variants?`, `ProviderDef.options: OptionDef[]`, updated `modelIdFor` resolving variant labels. Cursor is REMOVED (only other consumer is `Inspector.tsx`, which keeps compiling — it just renders 4 rows now).

- [ ] **Step 1: Rewrite `providers.ts`** — full content:

```ts
// Provider catalog for the model/provider modal. "Provider" here = an agentic harness NAC Code wraps
// (per the architecture: wrapper, never a harness). Local models appear under the OpenCode carrier.
// Availability comes from the live CliRegistry probe (registry:providers); this catalog carries the
// capability metadata (models, variants, options). `status` remains only as the Inspector's static view.

export type ConnStatus = 'authenticated' | 'expired' | 'not-authenticated' | 'not-installed'

export interface ModelVariant {
  id: string
  label: string
}

export interface ModelDef {
  id: string
  label: string
  variants?: ModelVariant[] // e.g. Sonnet 1M context — selected like a model, maps to its own id
}

// A per-provider capability the UI can set on the active chat. `effort` binds to chat.thinking
// (universal scale; 'none' = harness default); `fast` binds to chat.fast (Claude-only in v1).
export interface OptionDef {
  id: 'effort' | 'fast'
  label: string
  kind: 'enum' | 'toggle'
  values?: string[]
  note?: string
}

export interface ProviderDef {
  id: string
  name: string
  detail: string
  dot: string
  status: ConnStatus
  models: ModelDef[]
  options: OptionDef[]
}

const EFFORT: OptionDef = { id: 'effort', label: 'Effort', kind: 'enum', values: ['none', 'low', 'medium', 'high'] }

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    detail: 'claude · subscription',
    dot: '#d97757',
    status: 'authenticated',
    models: [
      { id: 'opus', label: 'Opus 4.8' },
      { id: 'sonnet', label: 'Sonnet 4.6', variants: [{ id: 'sonnet[1m]', label: 'Sonnet 4.6 · 1M' }] },
      { id: 'haiku', label: 'Haiku 4.5' }
    ],
    options: [
      { ...EFFORT, note: '--effort' },
      { id: 'fast', label: 'Fast mode', kind: 'toggle', note: 'research preview · Opus' }
    ]
  },
  {
    id: 'codex',
    name: 'Codex',
    detail: 'codex exec · subscription',
    dot: '#10a37f',
    status: 'authenticated',
    models: [{ id: 'gpt-5-codex', label: 'gpt-5-codex' }],
    options: [{ ...EFFORT, note: 'model_reasoning_effort' }]
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    detail: 'copilot · subscription',
    dot: '#8957e5',
    status: 'authenticated',
    models: [
      { id: 'auto', label: 'Auto' },
      { id: 'gpt-5.4', label: 'GPT-5.4' },
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' }
    ],
    options: [{ ...EFFORT, note: '--reasoning-effort · plan-gated models fail with the real error' }]
  },
  {
    id: 'opencode',
    name: 'OpenCode (local carrier)',
    detail: 'opencode → LM Studio',
    dot: '#46cf8b',
    status: 'authenticated',
    models: [
      { id: 'opencode/deepseek-v4-flash-free', label: 'DeepSeek V4 Flash (free)' },
      { id: 'lmstudio/qwen/qwen3-coder-30b', label: 'Qwen3 Coder 30B (local)' },
      { id: 'lmstudio-remote/qwen/qwen3.6-27b', label: 'qwen3.6-27b (remote)' }
    ],
    options: [{ ...EFFORT, note: '--variant · model-dependent' }]
  }
]

// Map a provider + a model's (or variant's) display label back to the harness model id (for --model).
export function modelIdFor(provider: string, label: string): string | undefined {
  const models = PROVIDERS.find((p) => p.id === provider)?.models ?? []
  for (const m of models) {
    if (m.label === label) return m.id
    const v = m.variants?.find((x) => x.label === label)
    if (v) return v.id
  }
  // Discovered models (OpenCode) use the raw `provider/model` id as their display label.
  if (provider === 'opencode' && label.includes('/')) return label
  return undefined
}

export const STATUS_LABEL: Record<ConnStatus, string> = {
  authenticated: 'Authenticated',
  expired: 'Expired',
  'not-authenticated': 'Not authenticated',
  'not-installed': 'Not installed'
}

export const STATUS_COLOR: Record<ConnStatus, string> = {
  authenticated: 'var(--success)',
  expired: 'var(--warning)',
  'not-authenticated': 'var(--error)',
  'not-installed': 'var(--faint)'
}
```

- [ ] **Step 2: Add a variant-mapping test** — vitest has no test for `modelIdFor` yet; create `src/renderer/src/data/providers.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { modelIdFor, PROVIDERS } from './providers'

describe('modelIdFor', () => {
  it('maps base models and 1M variants to harness ids', () => {
    expect(modelIdFor('claude', 'Sonnet 4.6')).toBe('sonnet')
    expect(modelIdFor('claude', 'Sonnet 4.6 · 1M')).toBe('sonnet[1m]')
    expect(modelIdFor('opencode', 'lmstudio/qwen/qwen3-coder-30b')).toBe('lmstudio/qwen/qwen3-coder-30b')
    expect(modelIdFor('claude', 'nope')).toBeUndefined()
  })
  it('has no cursor provider until an adapter exists', () => {
    expect(PROVIDERS.find((p) => p.id === 'cursor')).toBeUndefined()
  })
})
```

- [ ] **Step 3: Verify** — `npm run typecheck && npx vitest run` → clean. (Inspector/WorkspaceModal iterate `PROVIDERS` generically; no edits expected.)

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/data/providers.ts src/renderer/src/data/providers.test.ts
git commit -m "feat(catalog): capability metadata (options + 1M variant), cursor dropped until adapter exists"
```

---

### Task 5: Two-page ModelModal

**Files:**
- Modify: `src/renderer/src/components/ModelModal.tsx` (full rewrite below)

**Interfaces:**
- Consumes: `window.nac.registry.providers()` (Task 1), `Chat.fast`/`toggleFast` (Task 3), `OptionDef`/`variants` (Task 4), existing `setModel`/`setThinking`/`closeModal`, `window.nac.models.discover('opencode')`.

- [ ] **Step 1: Rewrite `ModelModal.tsx`** — full content:

```tsx
import { useEffect, useState, type CSSProperties } from 'react'
import { useApp, selectActiveChat, type ThinkingLevel } from '../store/store'
import { PROVIDERS, type ModelDef, type ProviderDef } from '../data/providers'
import type { ProviderProbe } from '../../../shared/runtime'

// Model & provider modal (FR-7.1), provider-first: page 1 lists DETECTED providers (live CLI probe,
// CliRegistry v0); page 2 = one provider's models + options. Applies to the ACTIVE chat only (FR-7.4).
export default function ModelModal() {
  const active = useApp(selectActiveChat)
  const setModel = useApp((s) => s.setModel)
  const setThinking = useApp((s) => s.setThinking)
  const toggleFast = useApp((s) => s.toggleFast)
  const close = useApp((s) => s.closeModal)
  const [page, setPage] = useState<string | null>(null) // null = provider list, else a provider id
  const [probes, setProbes] = useState<ProviderProbe[] | null>(null) // null = probing
  const [discovered, setDiscovered] = useState<Record<string, ModelDef[]>>({})

  // Escape backs out of a provider page first, then closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (page) setPage(null)
      else close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close, page])

  // Live availability: adapter-backed CLIs probed fresh each time the modal opens.
  useEffect(() => {
    let live = true
    window.nac?.registry
      ?.providers()
      .then((r) => {
        if (live) setProbes(r)
      })
      .catch(() => {
        if (live) setProbes([])
      })
    return () => {
      live = false
    }
  }, [])

  // Live model discovery (OpenCode reflects the account's real configured models); falls back to static.
  useEffect(() => {
    let live = true
    window.nac?.models
      ?.discover('opencode')
      .then((ids) => {
        if (live && ids.length) setDiscovered({ opencode: ids.map((id) => ({ id, label: id })) })
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  const probeFor = (id: string): ProviderProbe | undefined => probes?.find((p) => p.id === id)
  const detected = PROVIDERS.filter((p) => probeFor(p.id)?.installed)
  const provider = detected.find((p) => p.id === page) ?? null

  function pick(providerId: string, modelLabel: string): void {
    setModel(providerId, modelLabel)
    close()
  }

  return (
    <div onClick={close} style={backdrop}>
      <div onClick={(e) => e.stopPropagation()} style={card}>
        <div style={modalHeader}>
          {provider && (
            <button onClick={() => setPage(null)} style={backBtn} aria-label="Back">
              ←
            </button>
          )}
          <span style={{ fontWeight: 600 }}>{provider ? provider.name : 'Model & provider'}</span>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted)' }}>applies to this chat only</span>
          <button onClick={close} style={closeBtn} aria-label="Close">
            ✕
          </button>
        </div>

        <div style={{ overflow: 'auto' }}>
          {provider ? (
            <ProviderPage
              provider={provider}
              version={probeFor(provider.id)?.version}
              models={discovered[provider.id] ?? provider.models}
              isActiveProvider={active.provider === provider.id}
              activeModel={active.model}
              thinking={active.thinking}
              fast={active.fast}
              onPick={pick}
              onThinking={setThinking}
              onFast={toggleFast}
            />
          ) : probes === null ? (
            <div style={emptyState}>Detecting installed CLIs…</div>
          ) : detected.length === 0 ? (
            <div style={emptyState}>No providers detected. Install one of: claude, codex, copilot, opencode.</div>
          ) : (
            detected.map((p) => (
              <button key={p.id} onClick={() => setPage(p.id)} style={providerRow}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.dot, flexShrink: 0 }} />
                <span style={{ fontSize: 13, fontWeight: 600 }}>{p.name}</span>
                {active.provider === p.id && <span className="mono" style={currentTag}>{active.model}</span>}
                <span className="mono" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--faint)' }}>
                  {probeFor(p.id)?.version ? `v${probeFor(p.id)!.version} · ` : ''}
                  {(discovered[p.id] ?? p.models).length} models ›
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function ProviderPage(props: {
  provider: ProviderDef
  version?: string
  models: ModelDef[]
  isActiveProvider: boolean
  activeModel: string
  thinking: ThinkingLevel
  fast: boolean
  onPick: (provider: string, model: string) => void
  onThinking: (t: ThinkingLevel) => void
  onFast: () => void
}) {
  const p = props.provider
  return (
    <div style={{ padding: '10px 16px 16px', borderTop: '1px solid var(--line)' }}>
      <div className="mono" style={{ fontSize: 11, color: 'var(--faint)', marginBottom: 10 }}>
        {p.detail}
        {props.version ? ` · v${props.version}` : ''}
      </div>

      <div style={sectionLabel}>Models</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
        {props.models.flatMap((m) => [
          <Chip key={m.id} label={m.label} active={props.isActiveProvider && props.activeModel === m.label} onClick={() => props.onPick(p.id, m.label)} />,
          ...(m.variants ?? []).map((v) => (
            <Chip key={v.id} label={v.label} active={props.isActiveProvider && props.activeModel === v.label} onClick={() => props.onPick(p.id, v.label)} />
          ))
        ])}
      </div>

      {p.options.length > 0 && <div style={sectionLabel}>Options · this chat</div>}
      {p.options.map((opt) => (
        <div key={opt.id} style={{ marginBottom: 10 }}>
          <div style={optionLabel}>
            {opt.label}
            {opt.note ? <span style={{ color: 'var(--faint)', fontWeight: 400 }}> — {opt.note}</span> : null}
          </div>
          {opt.kind === 'enum' ? (
            <div style={{ display: 'flex', gap: 6 }}>
              {(opt.values ?? []).map((v) => (
                <Chip key={v} label={v} active={props.thinking === v} onClick={() => props.onThinking(v as ThinkingLevel)} />
              ))}
            </div>
          ) : (
            <Chip label={props.fast ? 'On' : 'Off'} active={props.fast} onClick={props.onFast} />
          )}
        </div>
      ))}
    </div>
  )
}

function Chip(props: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={props.onClick}
      className="mono"
      style={{
        ...modelChip,
        background: props.active ? 'var(--accent-tint-3)' : 'var(--card)',
        color: props.active ? 'var(--text)' : 'var(--text-2)',
        borderColor: props.active ? 'var(--accent)' : 'var(--line)'
      }}
    >
      {props.label}
    </button>
  )
}

const backdrop: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 100
}
const card: CSSProperties = {
  width: 480,
  maxWidth: '90vw',
  maxHeight: '74vh',
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--panel)',
  border: '1px solid var(--line-2)',
  borderRadius: 16,
  boxShadow: '0 30px 90px rgba(0,0,0,.6)',
  overflow: 'hidden'
}
const modalHeader: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px' }
const closeBtn: CSSProperties = { background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14 }
const backBtn: CSSProperties = { background: 'var(--card)', color: 'var(--text-2)', border: '1px solid var(--line)', borderRadius: 6, padding: '2px 9px', fontSize: 13, cursor: 'pointer' }
const modelChip: CSSProperties = { border: '1px solid var(--line)', borderRadius: 6, padding: '5px 10px', fontSize: 12, cursor: 'pointer' }
const providerRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '12px 16px', background: 'transparent', border: 'none', borderTop: '1px solid var(--line)', cursor: 'pointer', textAlign: 'left' }
const currentTag: CSSProperties = { fontSize: 11, color: 'var(--accent-light)', background: 'var(--accent-tint-3)', borderRadius: 5, padding: '1px 7px' }
const emptyState: CSSProperties = { padding: '28px 16px', textAlign: 'center', fontSize: 12.5, color: 'var(--muted)', borderTop: '1px solid var(--line)' }
const sectionLabel: CSSProperties = { fontSize: 10.5, letterSpacing: 1.2, textTransform: 'uppercase', color: 'var(--muted-2)', fontWeight: 600, marginBottom: 8 }
const optionLabel: CSSProperties = { fontSize: 12, color: 'var(--muted)', marginBottom: 6, fontWeight: 600 }
```

(The fake "+ Connect a provider…" button is intentionally gone — detection replaces it.)

- [ ] **Step 2: Verify** — `npm run typecheck && npx vitest run` → clean.

- [ ] **Step 3: Manual GUI check** — `npm run dev`: open the model modal → all 4 providers listed with probed versions; click Claude → models incl. `Sonnet 4.6 · 1M`, Effort chips, Fast toggle; Escape goes back, then closes; pick a model → chat header updates.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/ModelModal.tsx
git commit -m "feat(ui): provider-first two-page model picker with live detection + options"
```

---

### Task 6: Live verification vs real binaries + docs

**Files:**
- Modify: `docs/DECISIONS.md` (new dated entry), `docs/README.md` (add `docs/superpowers/` if its directory list lacks it)

- [ ] **Step 1: Verify effort end-to-end per provider** (direct CLI, mirrors builder output; each should complete without flag errors):

```bash
claude -p "Reply with one word: ok" --output-format stream-json --verbose --effort low | tail -1
codex exec --json --skip-git-repo-check -s read-only -c model_reasoning_effort=low "Reply with one word: ok" | tail -1
copilot -p "Reply with one word: ok" --output-format json --allow-all-tools --no-ask-user --no-color --log-level none --reasoning-effort low | tail -1
opencode run "Reply with one word: ok" --format json --variant low | tail -1
```
Expected: each ends with its normal completion event (claude `result`, codex `turn.completed`, copilot `result`, opencode exit 0). If any CLI rejects the flag value, record the exact error and adjust that provider's `OptionDef.values`/`note` in `providers.ts`.

- [ ] **Step 2: Verify the 1M variant + fast mode in the GUI** — `npm run dev`; in a Claude chat pick `Sonnet 4.6 · 1M`, send a message → normal reply (the `--model 'sonnet[1m]'` path). Toggle Fast mode on, send again → normal reply. Any account-gating error must appear legibly in the transcript (fail-honest check).

- [ ] **Step 3: DECISIONS.md entry** — add at the top of the "Current phase" progress items (replace `<commit>` with the real short hash of Task 5's commit):

```markdown
**✅ Provider-first model picker + real options** (`<commit>`): the model modal is two-page (detected providers → provider page); availability = live CLI probe (CliRegistry v0 — starts M4; Cursor dropped until it has an adapter). Thinking/effort is REAL on all four harnesses (claude `--effort`, codex `model_reasoning_effort`, copilot `--reasoning-effort`, opencode `--variant`; universal none/low/medium/high, 'none' = harness default) — closes the "thinking-level wiring" next-option. Claude extras: fast mode via per-run `--settings '{"fastMode":true}'` (no --fast flag exists) and a Sonnet 1M-context variant (`sonnet[1m]`), both verified vs the real binary. Gated options fail honestly (harness stderr → transcript). Spec: `docs/superpowers/specs/2026-07-08-provider-first-model-picker-design.md`.
```

- [ ] **Step 4: Final gate** — `npm run typecheck && npx vitest run && npm run build` → all green.

- [ ] **Step 5: Commit**

```bash
git add docs/DECISIONS.md docs/README.md docs/superpowers/plans/2026-07-08-provider-first-model-picker.md
git commit -m "docs: provider-first model picker done — detection, real effort/fast/1M wiring verified"
```
