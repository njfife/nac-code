# Per-Account Model & Capability Discovery (M4 Pillar One) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded model catalog with live per-account discovery (codex app-server `model/list`, copilot ACP `session/new`, opencode `models`, claude static+learning) and make effort provider-real.

**Architecture:** A `capabilities/` service in the Electron main process runs one strategy per provider behind `discoverCapabilities(provider)`, returning a neutral `ProviderCapabilities` shape over a new IPC channel with an in-memory session cache and a `protocol → static+learned → static` degradation ladder. A persisted gating ledger learns per-account model rejections from run outcomes. The renderer keeps a capabilities slice (seeded from static data, updated from IPC) that drives the picker, the composer effort pill, and model-id resolution at send time.

**Tech Stack:** Electron + React + TypeScript (electron-vite), Zustand, vitest. No new dependencies — the JSON-RPC client is ~80 lines over `child_process`.

**Spec:** `docs/superpowers/specs/2026-07-08-per-account-capability-discovery-design.md` (transports verified live 2026-07-08; fixtures below are real responses).

## Global Constraints

- Wrapper, never a harness: no raw model endpoints (Claude `/v1/models` is explicitly forbidden); everything goes through harness CLIs/protocols.
- All framing/mapping/merging logic is pure, exported, and unit-tested; subprocess I/O is thin around it.
- `npm run typecheck` clean and `npx vitest run` green before every commit (baseline: 13 files / 75 tests).
- Codex app-server responses OMIT the `jsonrpc` field — the parser must not require it.
- Degradation ladder: `protocol → static+learned → static`; every strategy failure is caught; the app's floor is today's shipped behavior.
- Effort is not portable: provider switch resets effort to `null` (harness default). `'none'` sentinel is replaced by `null` everywhere.
- Renderer touches all of this only through the typed preload bridge.
- Known rejection strings (verified): codex `"The '<id>' model is not supported when using Codex with a ChatGPT account."` (inside a JSON error blob); copilot `Model "<id>" from --model flag is not available.`; claude result text `There's an issue with the selected model (<id>). It may not exist or you may not have access to it.`

---

### Task 1: Shared capability types + newline-JSON-RPC stdio client

**Files:**
- Modify: `src/shared/runtime.ts` (types + channel)
- Create: `src/shared/capabilities.ts` (static data + pure helpers shared by main & renderer)
- Create: `src/main/runtime/capabilities/jsonRpc.ts`
- Test: `src/main/runtime/capabilities/jsonRpc.test.ts`, `src/shared/capabilities.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `DiscoveredModel`, `ProviderCapabilities`, `CAPABILITIES_CHANNELS.get = 'capabilities:get'` (shared/runtime.ts); `STATIC_CAPABILITIES: Record<string, ProviderCapabilities>`, `modelIdFor(provider: string, label: string, caps?: ProviderCapabilities): string | undefined`, `effortScaleFor(caps: ProviderCapabilities | undefined, modelLabel: string): string[]` (shared/capabilities.ts); `class JsonRpcClient { constructor(command: string, args: string[]); request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>; close(): void }` and pure `parseRpcLine(line: string): { id?: number; result?: unknown; error?: { code?: number; message?: string }; method?: string } | null` (jsonRpc.ts).

- [ ] **Step 1: Write the failing tests**

`src/main/runtime/capabilities/jsonRpc.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { parseRpcLine } from './jsonRpc'

describe('parseRpcLine', () => {
  it('parses codex-style responses that omit the jsonrpc field', () => {
    expect(parseRpcLine('{"id":1,"result":{"userAgent":"nac-code/0.142.3"}}')).toEqual({ id: 1, result: { userAgent: 'nac-code/0.142.3' } })
  })
  it('parses standard ACP responses and error responses', () => {
    expect(parseRpcLine('{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"\\"Method not found\\": models.list"}}')?.error?.code).toBe(-32601)
  })
  it('passes through server notifications (method, no id) and rejects noise', () => {
    expect(parseRpcLine('{"method":"remoteControl/status/changed","params":{"status":"disabled"}}')?.method).toBe('remoteControl/status/changed')
    expect(parseRpcLine('not json')).toBeNull()
    expect(parseRpcLine('')).toBeNull()
  })
})
```

`src/shared/capabilities.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { STATIC_CAPABILITIES, modelIdFor, effortScaleFor } from './capabilities'

describe('STATIC_CAPABILITIES', () => {
  it('covers the four adapter-backed providers with source static', () => {
    for (const p of ['claude', 'codex', 'copilot', 'opencode']) {
      expect(STATIC_CAPABILITIES[p]?.source).toBe('static')
    }
    expect(STATIC_CAPABILITIES.claude.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    expect(STATIC_CAPABILITIES.copilot.efforts).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  })
})

describe('modelIdFor', () => {
  it('resolves labels and variants from provided caps, falling back to static', () => {
    expect(modelIdFor('claude', 'Sonnet 4.6 · 1M')).toBe('sonnet[1m]')
    const caps = { provider: 'copilot', source: 'protocol' as const, models: [{ id: 'gpt-5.4', label: 'GPT-5.4' }], efforts: [], fetchedAt: 1 }
    expect(modelIdFor('copilot', 'GPT-5.4', caps)).toBe('gpt-5.4')
    expect(modelIdFor('opencode', 'lmstudio/qwen/qwen3-coder-30b')).toBe('lmstudio/qwen/qwen3-coder-30b')
    expect(modelIdFor('codex', 'Account default')).toBeUndefined()
  })
})

describe('effortScaleFor', () => {
  it('prefers the selected model’s own scale, then provider-wide', () => {
    const caps = { provider: 'codex', source: 'protocol' as const, efforts: ['low', 'medium', 'high'], fetchedAt: 1,
      models: [{ id: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] }] }
    expect(effortScaleFor(caps, 'GPT-5.5')).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(effortScaleFor(caps, 'Account default')).toEqual(['low', 'medium', 'high'])
    expect(effortScaleFor(undefined, 'x')).toEqual(['low', 'medium', 'high'])
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/main/runtime/capabilities src/shared` → FAIL (modules not found).

- [ ] **Step 3: Shared types** — in `src/shared/runtime.ts`, after `ProviderProbe`:

```ts
export const CAPABILITIES_CHANNELS = {
  get: 'capabilities:get'
} as const

// Per-account model & capability discovery (M4 pillar one). One neutral shape for every provider.
export interface DiscoveredModel {
  id: string // harness model id (what --model / -m receives)
  label: string // display name
  isDefault?: boolean
  efforts?: string[] // per-model scale (codex); absent = provider-wide scale applies
  defaultEffort?: string
  variants?: { id: string; label: string }[] // e.g. claude sonnet[1m]
  gated?: boolean // learned: this account's harness rejected the id
  note?: string // honest caveat (e.g. '9x usage', 'session-only')
}

export interface ProviderCapabilities {
  provider: string
  source: 'protocol' | 'static' | 'static+learned'
  models: DiscoveredModel[]
  efforts: string[] // provider-wide effort scale (fallback when models carry none)
  effortNote?: string // honest caveat shown under the effort chips (e.g. claude session-only levels)
  fetchedAt: number
}
```

- [ ] **Step 4: Shared static data + helpers** — create `src/shared/capabilities.ts`:

```ts
import type { DiscoveredModel, ProviderCapabilities } from './runtime'

// Static capability floor (the degradation ladder's bottom). Live discovery replaces these when it
// succeeds; claude's entry is also the protocol-less base merged with the gating ledger.
export const STATIC_CAPABILITIES: Record<string, ProviderCapabilities> = {
  claude: {
    provider: 'claude',
    source: 'static',
    models: [
      { id: 'opus', label: 'Opus 4.8' },
      { id: 'sonnet', label: 'Sonnet 4.6', variants: [{ id: 'sonnet[1m]', label: 'Sonnet 4.6 · 1M' }] },
      { id: 'haiku', label: 'Haiku 4.5' }
    ],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
    effortNote: 'max & ultracode are session-only; per-model support varies',
    fetchedAt: 0
  },
  codex: {
    provider: 'codex',
    source: 'static',
    models: [], // no reliable static ids (plan-gated); Account default is always offered by the UI
    efforts: ['low', 'medium', 'high', 'xhigh'],
    fetchedAt: 0
  },
  copilot: {
    provider: 'copilot',
    source: 'static',
    models: [],
    efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    fetchedAt: 0
  },
  opencode: {
    provider: 'opencode',
    source: 'static',
    models: [
      { id: 'opencode/deepseek-v4-flash-free', label: 'DeepSeek V4 Flash (free)' },
      { id: 'lmstudio/qwen/qwen3-coder-30b', label: 'Qwen3 Coder 30B (local)' },
      { id: 'lmstudio-remote/qwen/qwen3.6-27b', label: 'qwen3.6-27b (remote)' }
    ],
    efforts: ['low', 'medium', 'high'],
    effortNote: 'maps to --variant; model-dependent',
    fetchedAt: 0
  }
}

/** Resolve a display label to the harness model id: live caps first, then the static floor. */
export function modelIdFor(provider: string, label: string, caps?: ProviderCapabilities): string | undefined {
  for (const source of [caps, STATIC_CAPABILITIES[provider]]) {
    for (const m of source?.models ?? []) {
      if (m.label === label) return m.id
      const v = m.variants?.find((x) => x.label === label)
      if (v) return v.id
    }
  }
  // Discovered opencode models historically use the raw `provider/model` id as their label.
  if (provider === 'opencode' && label.includes('/')) return label
  return undefined
}

/** The effort scale that applies to the chat's current model: per-model when it carries one. */
export function effortScaleFor(caps: ProviderCapabilities | undefined, modelLabel: string): string[] {
  const m = caps?.models.find((x) => x.label === modelLabel || x.variants?.some((v) => v.label === modelLabel))
  if (m?.efforts?.length) return m.efforts
  if (caps?.efforts.length) return caps.efforts
  return ['low', 'medium', 'high']
}

export function findModel(caps: ProviderCapabilities | undefined, label: string): DiscoveredModel | undefined {
  return caps?.models.find((x) => x.label === label || x.variants?.some((v) => v.label === label))
}
```

- [ ] **Step 5: JSON-RPC client** — create `src/main/runtime/capabilities/jsonRpc.ts`:

```ts
import { spawn, type ChildProcess } from 'child_process'

// Minimal newline-delimited JSON-RPC 2.0 client over a child process's stdio. Used for
// `codex app-server` (which omits the jsonrpc field in responses) and `copilot --acp`.

export interface RpcMessage {
  id?: number
  result?: unknown
  error?: { code?: number; message?: string }
  method?: string
}

/** Pure + exported for testing: one stdout line → an RPC message (responses and notifications). */
export function parseRpcLine(line: string): RpcMessage | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let m: RpcMessage
  try {
    m = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof m !== 'object' || m === null) return null
  return m
}

export class JsonRpcClient {
  private child: ChildProcess
  private buffer = ''
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  constructor(command: string, args: string[]) {
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] })
    this.child.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8')
      let nl: number
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const msg = parseRpcLine(this.buffer.slice(0, nl))
        this.buffer = this.buffer.slice(nl + 1)
        if (msg?.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!
          this.pending.delete(msg.id)
          if (msg.error) p.reject(new Error(msg.error.message ?? `rpc error ${msg.error.code}`))
          else p.resolve(msg.result)
        }
        // notifications (method, no id) are ignored — discovery only awaits responses
      }
    })
    this.child.on('error', (err) => this.failAll(err))
    this.child.on('close', () => this.failAll(new Error('rpc server closed')))
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }

  request(method: string, params?: unknown, timeoutMs = 5000): Promise<unknown> {
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`rpc timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
      this.child.stdin?.write(payload + '\n')
    })
  }

  close(): void {
    this.child.kill()
  }
}
```

- [ ] **Step 6: Run to verify pass** — `npx vitest run src/main/runtime/capabilities src/shared` → PASS.

- [ ] **Step 7: Full gate + commit**

```bash
npm run typecheck && npx vitest run
git add src/shared/runtime.ts src/shared/capabilities.ts src/main/runtime/capabilities/
git commit -m "feat(capabilities): shared capability model + newline JSON-RPC stdio client"
```

---

### Task 2: Codex strategy (app-server `model/list`)

**Files:**
- Create: `src/main/runtime/capabilities/codex.ts`
- Test: `src/main/runtime/capabilities/codex.test.ts`

**Interfaces:**
- Consumes: `JsonRpcClient` (Task 1), `ProviderCapabilities`/`DiscoveredModel` (Task 1).
- Produces: `discoverCodex(): Promise<ProviderCapabilities | null>` (null = fall back), pure `mapCodexModels(data: unknown[]): DiscoveredModel[]`.

- [ ] **Step 1: Write the failing test** — `codex.test.ts` with the REAL fixture shape captured live 2026-07-08:

```ts
import { describe, it, expect } from 'vitest'
import { mapCodexModels } from './codex'

const GPT55 = {
  id: 'gpt-5.5', model: 'gpt-5.5', displayName: 'GPT-5.5',
  description: 'Frontier model for complex coding, research, and real-world work.',
  hidden: false,
  supportedReasoningEfforts: [
    { reasoningEffort: 'low', description: 'Fast responses with lighter reasoning' },
    { reasoningEffort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
    { reasoningEffort: 'high', description: 'Greater reasoning depth for complex problems' },
    { reasoningEffort: 'xhigh', description: 'Extra high reasoning depth for complex problems' }
  ],
  defaultReasoningEffort: 'medium', inputModalities: ['text', 'image'], supportsPersonality: true,
  additionalSpeedTiers: ['fast'], serviceTiers: [{ id: 'priority', name: 'Fast' }], defaultServiceTier: null, isDefault: true
}

describe('mapCodexModels', () => {
  it('maps the real model/list shape to DiscoveredModel', () => {
    const [m] = mapCodexModels([GPT55])
    expect(m).toEqual({
      id: 'gpt-5.5', label: 'GPT-5.5', isDefault: true,
      efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium'
    })
  })
  it('drops hidden models and tolerates junk entries', () => {
    expect(mapCodexModels([{ ...GPT55, hidden: true }])).toEqual([])
    expect(mapCodexModels([null, 42, {}])).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/main/runtime/capabilities/codex.test.ts` → FAIL.

- [ ] **Step 3: Implement** — `codex.ts`:

```ts
import { JsonRpcClient } from './jsonRpc'
import type { DiscoveredModel, ProviderCapabilities } from '../../../shared/runtime'

// Codex app-server v2 `model/list` (EXPERIMENTAL surface; verified live 2026-07-08).
// Handshake: initialize(clientInfo) → model/list → data[] (+ nextCursor pagination).

interface CodexEffort {
  reasoningEffort?: string
}
interface CodexModel {
  id?: string
  displayName?: string
  hidden?: boolean
  isDefault?: boolean
  supportedReasoningEfforts?: CodexEffort[]
  defaultReasoningEffort?: string
}

/** Pure + exported for testing: model/list `data` entries → DiscoveredModel[] (hidden dropped). */
export function mapCodexModels(data: unknown[]): DiscoveredModel[] {
  const out: DiscoveredModel[] = []
  for (const raw of data) {
    const m = raw as CodexModel | null
    if (!m || typeof m !== 'object' || !m.id || m.hidden) continue
    out.push({
      id: m.id,
      label: m.displayName ?? m.id,
      isDefault: m.isDefault === true,
      efforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort).filter((x): x is string => Boolean(x)),
      defaultEffort: m.defaultReasoningEffort
    })
  }
  return out
}

export async function discoverCodex(): Promise<ProviderCapabilities | null> {
  const client = new JsonRpcClient('codex', ['app-server'])
  try {
    await client.request('initialize', { clientInfo: { name: 'nac-code', title: 'NAC Code', version: '0.1.0' } })
    const models: DiscoveredModel[] = []
    let cursor: string | null = null
    do {
      const res = (await client.request('model/list', cursor ? { cursor } : {})) as { data?: unknown[]; nextCursor?: string | null }
      models.push(...mapCodexModels(res?.data ?? []))
      cursor = res?.nextCursor ?? null
    } while (cursor)
    if (models.length === 0) return null
    return { provider: 'codex', source: 'protocol', models, efforts: ['low', 'medium', 'high', 'xhigh'], fetchedAt: Date.now() }
  } catch {
    return null // caller falls back down the ladder
  } finally {
    client.close()
  }
}
```

- [ ] **Step 4: Run to verify pass**, then full gate: `npm run typecheck && npx vitest run`.

- [ ] **Step 5: Commit**

```bash
git add src/main/runtime/capabilities/codex.ts src/main/runtime/capabilities/codex.test.ts
git commit -m "feat(capabilities): codex app-server model/list strategy"
```

---

### Task 3: Copilot strategy (ACP `session/new`)

**Files:**
- Create: `src/main/runtime/capabilities/copilot.ts`
- Test: `src/main/runtime/capabilities/copilot.test.ts`

**Interfaces:**
- Consumes: `JsonRpcClient`, shared types.
- Produces: `discoverCopilot(): Promise<ProviderCapabilities | null>`, pure `mapCopilotModels(available: unknown[], currentModelId?: string): DiscoveredModel[]`.

- [ ] **Step 1: Write the failing test** — real fixture shape (live 2026-07-08):

```ts
import { describe, it, expect } from 'vitest'
import { mapCopilotModels } from './copilot'

const AVAILABLE = [
  { modelId: 'auto', name: 'Auto', description: 'Let Copilot pick the best model' },
  { modelId: 'gpt-5.4', name: 'GPT-5.4', description: 'GPT-5.4', _meta: { copilotUsage: '6x', copilotEnablement: 'enabled' } },
  { modelId: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6', description: 'Claude Sonnet 4.6', _meta: { copilotUsage: '9x', copilotEnablement: 'enabled' } }
]

describe('mapCopilotModels', () => {
  it('maps the real ACP availableModels shape, marks the current default, carries usage', () => {
    const models = mapCopilotModels(AVAILABLE, 'gpt-5.4')
    expect(models).toEqual([
      { id: 'auto', label: 'Auto', isDefault: false },
      { id: 'gpt-5.4', label: 'GPT-5.4', isDefault: true, note: '6x usage' },
      { id: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6', isDefault: false, note: '9x usage' }
    ])
  })
  it('tolerates junk entries', () => {
    expect(mapCopilotModels([null, {}, { name: 'no-id' }])).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** — `copilot.ts`:

```ts
import { homedir } from 'os'
import { JsonRpcClient } from './jsonRpc'
import type { DiscoveredModel, ProviderCapabilities } from '../../../shared/runtime'

// Copilot ACP (`copilot --acp`; verified live 2026-07-08): initialize(protocolVersion 1) →
// session/new → result.models.availableModels + currentModelId. The docs-reported `models.list`
// method does not exist on this surface (-32601).

interface AcpModel {
  modelId?: string
  name?: string
  _meta?: { copilotUsage?: string; copilotEnablement?: string }
}

/** Pure + exported for testing: availableModels → DiscoveredModel[] with default + usage note. */
export function mapCopilotModels(available: unknown[], currentModelId?: string): DiscoveredModel[] {
  const out: DiscoveredModel[] = []
  for (const raw of available) {
    const m = raw as AcpModel | null
    if (!m || typeof m !== 'object' || !m.modelId) continue
    const model: DiscoveredModel = { id: m.modelId, label: m.name ?? m.modelId, isDefault: m.modelId === currentModelId }
    if (m._meta?.copilotUsage) model.note = `${m._meta.copilotUsage} usage`
    out.push(model)
  }
  return out
}

export async function discoverCopilot(): Promise<ProviderCapabilities | null> {
  const client = new JsonRpcClient('copilot', ['--acp'])
  try {
    await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
    })
    const res = (await client.request('session/new', { cwd: homedir(), mcpServers: [] })) as {
      models?: { availableModels?: unknown[]; currentModelId?: string }
    }
    const models = mapCopilotModels(res?.models?.availableModels ?? [], res?.models?.currentModelId)
    if (models.length === 0) return null
    return {
      provider: 'copilot',
      source: 'protocol',
      models,
      efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      fetchedAt: Date.now()
    }
  } catch {
    return null
  } finally {
    client.close()
  }
}
```

- [ ] **Step 4: Run to verify pass**, then full gate.

- [ ] **Step 5: Commit**

```bash
git add src/main/runtime/capabilities/copilot.ts src/main/runtime/capabilities/copilot.test.ts
git commit -m "feat(capabilities): copilot ACP session/new strategy"
```

---

### Task 4: Gating ledger + claude strategy + claude rejection surfacing

**Files:**
- Create: `src/main/runtime/capabilities/ledger.ts` (PURE — no electron import, so vitest can load it)
- Create: `src/main/runtime/capabilities/ledgerStore.ts` (electron file I/O — imports `electron.app`; never imported by any test or by any module a test imports at module scope)
- Create: `src/main/runtime/capabilities/claude.ts`
- Modify: `src/main/runtime/claudeAdapter.ts:56-65` (result case surfaces model rejections as `run.errored`)
- Test: `src/main/runtime/capabilities/ledger.test.ts`, additions to `src/main/runtime/claudeAdapter.test.ts`

**Interfaces:**
- Consumes: shared types, `STATIC_CAPABILITIES` (Task 1).
- Produces: PURE in `ledger.ts`: `type Ledger = Record<string, Record<string, { verdict: 'gated' | 'works'; at: number; message?: string }>>`, `classifyModelRejection(message: string): boolean`, `mergeLedger(caps: ProviderCapabilities, ledger: Ledger): ProviderCapabilities`. Electron I/O in `ledgerStore.ts`: `readLedger(): Ledger`, `recordOutcome(provider: string, modelId: string, verdict: 'gated' | 'works', message?: string): void`. `discoverClaude(ledger: Ledger): ProviderCapabilities` (pure; caller supplies the ledger).

- [ ] **Step 1: Write the failing tests**

`ledger.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { classifyModelRejection, mergeLedger, type Ledger } from './ledger'
import { STATIC_CAPABILITIES } from '../../../shared/capabilities'

describe('classifyModelRejection', () => {
  it('recognizes the three verified rejection shapes', () => {
    expect(classifyModelRejection(`{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account."}}`)).toBe(true)
    expect(classifyModelRejection('Error: Model "totally-bogus" from --model flag is not available.')).toBe(true)
    expect(classifyModelRejection("There's an issue with the selected model (totally-bogus-model). It may not exist or you may not have access to it.")).toBe(true)
    expect(classifyModelRejection('harness exited with code 1')).toBe(false)
  })
})

describe('mergeLedger', () => {
  it('marks gated models and upgrades source to static+learned', () => {
    const ledger: Ledger = { claude: { opus: { verdict: 'gated', at: 1 } } }
    const merged = mergeLedger(STATIC_CAPABILITIES.claude, ledger)
    expect(merged.models.find((m) => m.id === 'opus')?.gated).toBe(true)
    expect(merged.source).toBe('static+learned')
    expect(merged.models.find((m) => m.id === 'sonnet')?.gated).toBeUndefined()
  })
  it('is a no-op without relevant entries', () => {
    expect(mergeLedger(STATIC_CAPABILITIES.claude, {})).toEqual(STATIC_CAPABILITIES.claude)
  })
})
```

`claudeAdapter.test.ts` addition:
```ts
  it('surfaces a model-rejection result as run.errored with the message', () => {
    const line = JSON.stringify({ type: 'result', is_error: true, result: "There's an issue with the selected model (bogus). It may not exist or you may not have access to it." })
    expect(parseClaudeLine('r', line)).toEqual([{ type: 'run.errored', runId: 'r', message: "There's an issue with the selected model (bogus). It may not exist or you may not have access to it." }])
    // plain errors keep the existing completed/error mapping
    expect(parseClaudeLine('r', '{"type":"result","is_error":true}')).toEqual([{ type: 'run.completed', runId: 'r', stopReason: 'error' }])
  })
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement `ledger.ts`** (pure — NO electron import; tests load this directly):

```ts
import type { ProviderCapabilities } from '../../../shared/runtime'

// Outcome-learned account gating (pure logic). File I/O lives in ledgerStore.ts (electron-only).

export type Ledger = Record<string, Record<string, { verdict: 'gated' | 'works'; at: number; message?: string }>>

// One rejection matcher per verified harness error shape (see spec's probed ground truth).
const REJECTION_PATTERNS = [
  /model is not supported when using Codex/i, // codex 400
  /Model "[^"]+" from --model flag is not available/i, // copilot
  /issue with the selected model/i // claude structured 404 result text
]

/** Pure + exported for testing. */
export function classifyModelRejection(message: string): boolean {
  return REJECTION_PATTERNS.some((p) => p.test(message))
}

/** Pure + exported for testing: stamp `gated` onto caps models from ledger entries. */
export function mergeLedger(caps: ProviderCapabilities, ledger: Ledger): ProviderCapabilities {
  const entries = ledger[caps.provider]
  if (!entries || Object.keys(entries).length === 0) return caps
  let touched = false
  const models = caps.models.map((m) => {
    if (entries[m.id]?.verdict === 'gated') {
      touched = true
      return { ...m, gated: true }
    }
    return m
  })
  if (!touched) return caps
  return { ...caps, models, source: caps.source === 'static' ? 'static+learned' : caps.source }
}
```

- [ ] **Step 4: Implement `ledgerStore.ts`** (electron file I/O — kept out of every test's import graph):

```ts
import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs'
import { join } from 'path'
import type { Ledger } from './ledger'

// Persisted at userData/nac-capability-ledger.json; same atomic temp+rename pattern as nac-state.

function ledgerPath(): string {
  return join(app.getPath('userData'), 'nac-capability-ledger.json')
}

export function readLedger(): Ledger {
  try {
    if (!existsSync(ledgerPath())) return {}
    const parsed = JSON.parse(readFileSync(ledgerPath(), 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Ledger) : {}
  } catch {
    return {}
  }
}

export function recordOutcome(provider: string, modelId: string, verdict: 'gated' | 'works', message?: string): void {
  try {
    const ledger = readLedger()
    ledger[provider] = ledger[provider] ?? {}
    ledger[provider][modelId] = { verdict, at: Date.now(), ...(message ? { message } : {}) }
    const tmp = ledgerPath() + '.tmp'
    writeFileSync(tmp, JSON.stringify(ledger, null, 2), 'utf8')
    renameSync(tmp, ledgerPath())
  } catch {
    // learning is best-effort; never break a run over it
  }
}
```

Then `claude.ts` (pure — caller supplies the ledger):

```ts
import { STATIC_CAPABILITIES } from '../../../shared/capabilities'
import type { ProviderCapabilities } from '../../../shared/runtime'
import { mergeLedger, type Ledger } from './ledger'

// Claude Code has no headless model list (alias set is fixed per CLI version; account-gated at
// request time — verified 2026-07-08). Static base + gating ledger = 'static+learned'.
export function discoverClaude(ledger: Ledger): ProviderCapabilities {
  return mergeLedger({ ...STATIC_CAPABILITIES.claude, fetchedAt: Date.now() }, ledger)
}
```

- [ ] **Step 5: Claude adapter rejection surfacing** — in `claudeAdapter.ts`, `parseClaudeLine`'s `'result'` case, before the existing return:

```ts
    case 'result': {
      // A model rejection deserves a real error (message included) so the gating ledger can learn it.
      if (m.is_error && typeof (m as { result?: unknown }).result === 'string' && /issue with the selected model/i.test((m as { result: string }).result)) {
        return [{ type: 'run.errored', runId, message: (m as { result: string }).result }]
      }
      const u = m.usage
      // … existing mapping unchanged …
```
(Add `result?: string` to the `ClaudeEvent` interface instead of inline casts if cleaner — implementer's choice, keep it typed.)

- [ ] **Step 6: Run to verify pass**, then full gate.

- [ ] **Step 7: Commit**

```bash
git add src/main/runtime/capabilities/ledger.ts src/main/runtime/capabilities/ledgerStore.ts src/main/runtime/capabilities/claude.ts src/main/runtime/capabilities/ledger.test.ts src/main/runtime/claudeAdapter.ts src/main/runtime/claudeAdapter.test.ts
git commit -m "feat(capabilities): gating ledger + claude static+learned strategy"
```

---

### Task 5: Dispatcher, cache, IPC, preload, ledger hooks, opencode relocation

**Files:**
- Create: `src/main/runtime/capabilities/index.ts`, `src/main/runtime/capabilities/opencode.ts`
- Modify: `src/main/runtime/ipc.ts` (capabilities handler + ledger hooks + codex/copilot model passthrough is Task 6 — here only handler + hooks), `src/preload/index.ts`
- Test: `src/main/runtime/capabilities/index.test.ts`
- Delete: nothing yet (`discovery.ts` + its channel are removed in Task 8 when the UI stops using them)

**Interfaces:**
- Consumes: Tasks 1-4 strategies, `discoverModels`-style opencode parsing (relocated), `RUN_CHANNELS` handler in ipc.ts.
- Produces: `getCapabilities(provider: string, refresh?: boolean): Promise<ProviderCapabilities>` (never rejects; always returns something on the ladder), `window.nac.capabilities.get(provider, refresh?)`; run outcomes recorded: `run.errored` message matching `classifyModelRejection` AND the run had an explicit model → `recordOutcome(provider, modelId, 'gated', message)`; `run.completed` with `stopReason 'end_turn'` and explicit model → `recordOutcome(provider, modelId, 'works')`.

- [ ] **Step 1: Write the failing test** — `index.test.ts` (cache + ladder logic, strategies injected):

```ts
import { describe, it, expect } from 'vitest'
import { resolveCapabilities } from './index'
import { STATIC_CAPABILITIES } from '../../../shared/capabilities'

describe('resolveCapabilities (pure ladder)', () => {
  it('uses the protocol result when the strategy succeeds', async () => {
    const live = { ...STATIC_CAPABILITIES.codex, source: 'protocol' as const, models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }], fetchedAt: 9 }
    expect(await resolveCapabilities('codex', async () => live)).toEqual(live)
  })
  it('falls back to the static floor when the strategy returns null or throws', async () => {
    expect((await resolveCapabilities('codex', async () => null)).source).toBe('static')
    expect((await resolveCapabilities('codex', async () => { throw new Error('boom') })).source).toBe('static')
  })
  it('unknown provider gets an empty static shape, never a rejection', async () => {
    const caps = await resolveCapabilities('nope', async () => null)
    expect(caps.models).toEqual([])
    expect(caps.provider).toBe('nope')
  })
})
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** `opencode.ts` (relocation — copy the parse + spawn from `discovery.ts`, returning caps):

```ts
import { spawn } from 'child_process'
import { STATIC_CAPABILITIES } from '../../../shared/capabilities'
import type { ProviderCapabilities } from '../../../shared/runtime'

/** Pure + exported for testing (relocated from discovery.ts): `opencode models` stdout → ids. */
export function parseOpenCodeModels(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[\w.@:-]+\/[\w./@:-]+$/.test(l))
}

export function discoverOpenCode(): Promise<ProviderCapabilities | null> {
  return new Promise((resolve) => {
    let out = ''
    let child
    try {
      child = spawn('opencode', ['models'], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve(null)
      return
    }
    child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')))
    child.on('error', () => resolve(null))
    child.on('close', () => {
      const ids = parseOpenCodeModels(out)
      if (ids.length === 0) {
        resolve(null)
        return
      }
      resolve({
        ...STATIC_CAPABILITIES.opencode,
        source: 'protocol',
        models: ids.map((id) => ({ id, label: id })),
        fetchedAt: Date.now()
      })
    })
  })
}
```

`index.ts` — NOTE: no module-scope import of `ledgerStore` (electron) so `index.test.ts` can import this file; the store is lazy-loaded only inside `getCapabilities`:
```ts
import { STATIC_CAPABILITIES } from '../../../shared/capabilities'
import type { ProviderCapabilities } from '../../../shared/runtime'
import { discoverCodex } from './codex'
import { discoverCopilot } from './copilot'
import { discoverClaude } from './claude'
import { discoverOpenCode } from './opencode'
import { mergeLedger, type Ledger } from './ledger'

// Degradation ladder: protocol → static+learned → static. Never rejects.
type Strategy = () => Promise<ProviderCapabilities | null>

/** Pure + exported for testing: strategy and ledger are injected. */
export async function resolveCapabilities(provider: string, strategy: Strategy, ledger: Ledger = {}): Promise<ProviderCapabilities> {
  try {
    const live = await strategy()
    if (live) return mergeLedger(live, ledger) // learned gating applies to live results too
  } catch {
    // fall through to the floor
  }
  const floor = STATIC_CAPABILITIES[provider] ?? { provider, source: 'static' as const, models: [], efforts: [], fetchedAt: 0 }
  return mergeLedger({ ...floor, fetchedAt: Date.now() }, ledger)
}

const cache = new Map<string, ProviderCapabilities>()

export async function getCapabilities(provider: string, refresh = false): Promise<ProviderCapabilities> {
  if (!refresh && cache.has(provider)) return cache.get(provider)!
  // Lazy-load the electron-backed ledger store so importing this module never requires electron.
  const { readLedger } = await import('./ledgerStore')
  const ledger = readLedger()
  const strategies: Record<string, Strategy> = {
    codex: discoverCodex,
    copilot: discoverCopilot,
    claude: async () => discoverClaude(ledger), // static+learned; never null
    opencode: discoverOpenCode
  }
  const caps = await resolveCapabilities(provider, strategies[provider] ?? (async () => null), ledger)
  cache.set(provider, caps)
  return caps
}
```

`ipc.ts` — add to imports and inside `registerRuntimeIpc`:
```ts
import { CAPABILITIES_CHANNELS } from '../../shared/runtime'
import { getCapabilities } from './capabilities'
import { classifyModelRejection } from './capabilities/ledger'
import { recordOutcome } from './capabilities/ledgerStore'
```
```ts
  // Per-account capability discovery (M4): live model/effort data with a static floor.
  ipcMain.handle(CAPABILITIES_CHANNELS.get, (_e, provider: string, refresh?: boolean) => getCapabilities(provider, refresh === true))
```
And extend the run `handler` closure (it already sees every event; `req` is in scope):
```ts
    const handler = (event: AgentEvent): void => {
      send(event)
      // Gating ledger: learn per-account model verdicts from real outcomes (explicit model only).
      if (req.model && req.provider) {
        if (event.type === 'run.errored' && classifyModelRejection(event.message)) recordOutcome(req.provider, req.model, 'gated', event.message)
        else if (event.type === 'run.completed' && event.stopReason === 'end_turn') recordOutcome(req.provider, req.model, 'works')
      }
      if (event.type === 'run.completed' || event.type === 'run.errored') runs.delete(runId)
    }
```

`preload/index.ts` — add `CAPABILITIES_CHANNELS, type ProviderCapabilities` to imports and:
```ts
  capabilities: {
    get: (provider: string, refresh?: boolean): Promise<ProviderCapabilities> => ipcRenderer.invoke(CAPABILITIES_CHANNELS.get, provider, refresh)
  },
```

- [ ] **Step 4: Run to verify pass**, then full gate.

- [ ] **Step 5: Commit**

```bash
git add src/main/runtime/capabilities/ src/main/runtime/ipc.ts src/preload/index.ts
git commit -m "feat(capabilities): dispatcher + cache + IPC + ledger hooks + opencode relocation"
```

---

### Task 6: Effort becomes provider-real (store, persistence, send path, composer)

**Files:**
- Modify: `src/shared/runtime.ts` (`RunRequest.thinking` → `effort`), `src/main/runtime/ipc.ts` (pass-through rename), `src/renderer/src/store/store.ts` (`Chat.effort`, `setEffort`, caps slice, provider-switch reset), `src/renderer/src/store/persist.ts` (migration), `src/renderer/src/store/runtime.ts` (`sendMessage`), `src/renderer/src/components/ChatView.tsx` (pill), `src/renderer/src/components/Inspector.tsx:81-83` (session row shows real effort)
- Test: `src/renderer/src/store/store.test.ts`, `src/renderer/src/store/persist.test.ts` (adaptations + new cases)

**Interfaces:**
- Consumes: `effortScaleFor`, `modelIdFor` from `src/shared/capabilities.ts`; `window.nac.capabilities.get` (Task 5).
- Produces: `Chat.effort: string | null` (replaces `thinking`; `ThinkingLevel` type DELETED), `setEffort: (e: string | null) => void`, store slice `caps: Record<string, ProviderCapabilities>` seeded from `STATIC_CAPABILITIES` + `loadCaps: (provider: string, refresh?: boolean) => Promise<void>`, `RunRequest.effort?: string`. `setModel(provider, model)`: if `provider !== chat.provider` → `effort: null`; else if the new model's scale (via `effortScaleFor`) excludes the current effort → `effort: null`.

- [ ] **Step 1: Write the failing tests**

`store.test.ts` — replace the `toggleFast`-era thinking assumptions and add:
```ts
it('setEffort sets the active chat effort; provider switch resets it to null', () => {
  const s = useApp.getState()
  s.setEffort('xhigh')
  expect(useApp.getState().chats[useApp.getState().activeChatId].effort).toBe('xhigh')
  const chat = useApp.getState().chats[useApp.getState().activeChatId]
  const otherProvider = chat.provider === 'claude' ? 'codex' : 'claude'
  s.setModel(otherProvider, 'Account default')
  expect(useApp.getState().chats[useApp.getState().activeChatId].effort).toBeNull()
})
```

`persist.test.ts` — replace the thinking-migration cases:
```ts
it("migrates legacy thinking: 'none' to effort null and drops pre-feature values", () => {
  expect(normalizeChat({ thinking: 'none', fast: true } as never, 'c1').effort).toBeNull()
  expect(normalizeChat({ thinking: 'medium' } as never, 'c2').effort).toBeNull() // pre-fast era: cosmetic
  expect(normalizeChat({ thinking: 'high', fast: false } as never, 'c3').effort).toBe('high')
  expect(normalizeChat({ effort: 'xhigh', fast: false } as never, 'c4').effort).toBe('xhigh')
})
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement store changes** (`store.ts`):
- `Chat`: replace `thinking: ThinkingLevel` with `effort: string | null // reasoning depth; null = harness default. Values come from discovered capabilities`; delete the `ThinkingLevel` type and its export.
- `base`: `thinking: 'medium' as ThinkingLevel` → `effort: null as string | null`.
- `AppState`: `setThinking: (t: ThinkingLevel) => void` → `setEffort: (e: string | null) => void`; add:
```ts
  caps: Record<string, ProviderCapabilities>
  loadCaps: (provider: string, refresh?: boolean) => Promise<void>
```
- Implementation replacing `setThinking`:
```ts
  setEffort: (e) => set((s) => ({ chats: { ...s.chats, [s.activeChatId]: { ...s.chats[s.activeChatId], effort: e } } })),
```
- `setModel` becomes effort-aware:
```ts
  setModel: (provider, model) =>
    set((s) => {
      const chat = s.chats[s.activeChatId]
      const scale = effortScaleFor(s.caps[provider], model)
      // Effort scales aren't portable: reset on provider switch, and clamp to the new model's scale.
      const effort = provider !== chat.provider ? null : chat.effort && !scale.includes(chat.effort) ? null : chat.effort
      return { chats: { ...s.chats, [s.activeChatId]: { ...chat, provider, model, effort } } }
    }),
```
- Initial state: `caps: { ...STATIC_CAPABILITIES },` and:
```ts
  loadCaps: async (provider, refresh) => {
    if (!window.nac?.capabilities) return
    try {
      const caps = await window.nac.capabilities.get(provider, refresh)
      set((s) => ({ caps: { ...s.caps, [provider]: caps } }))
    } catch {
      // keep the current (static) entry
    }
  },
```
- `newChat`: `thinking: 'medium'` → `effort: null`. Imports: `import { STATIC_CAPABILITIES, effortScaleFor } from '../../../shared/capabilities'` and `type ProviderCapabilities` from shared/runtime.

- [ ] **Step 4: Persistence migration** (`persist.ts` `normalizeChat`) — replace the thinking line:
```ts
    // effort (né thinking): null = harness default. Legacy: 'none' → null; pre-fast-era values were
    // cosmetic → null; post-feature 'thinking' strings carry over; new 'effort' field wins when present.
    effort:
      typeof c.fast === 'boolean'
        ? ((c as { effort?: string | null }).effort ?? ((c as { thinking?: string }).thinking === 'none' ? null : (c as { thinking?: string }).thinking ?? null))
        : null,
```
(Remove the `ThinkingLevel` import.)

- [ ] **Step 5: Wire the send path.** `src/shared/runtime.ts` `RunRequest`: rename `thinking?: string` to `effort?: string` (comment: `// reasoning depth; omitted = harness default. Adapter maps to its flag`). `ipc.ts` start handler: `effort: req.thinking` → `effort: req.effort` (claude/codex/copilot), `variant: req.thinking` → `variant: req.effort` (opencode). `runtime.ts` `sendMessage`:
```ts
      effort: chat.effort ?? undefined,
      model: modelIdFor(chat.provider, chat.model, s.caps[chat.provider]),
```
with `import { modelIdFor } from '../../../shared/capabilities'` (delete the old import from `../data/providers`). Also update `compactChat` in store.ts: `modelIdFor(chat.provider, chat.model)` → `modelIdFor(chat.provider, chat.model, get().caps[chat.provider])`.

- [ ] **Step 6: Composer pill** (`ChatView.tsx`) — replace the thinking pill block:
```tsx
              <span
                style={toolbarItem}
                onClick={() => {
                  const scale = [null, ...effortScaleFor(caps[active.provider], active.model)]
                  const idx = scale.indexOf(active.effort)
                  setEffort(scale[(idx + 1) % scale.length])
                }}
              >
                Effort: {active.effort ?? 'default'}
              </span>
```
with `const setEffort = useApp((s) => s.setEffort)`, `const caps = useApp((s) => s.caps)`, and `import { effortScaleFor } from '../../../shared/capabilities'`. Inspector.tsx session row: replace the hardcoded `<span ...>Medium</span>` with `{active.effort ?? 'default'}` and change the label "Thinking" → "Effort".

- [ ] **Step 7: Run to verify pass** — expect fallout in any test still referencing `thinking`/`setThinking`/`ThinkingLevel`; update those assertions to the effort equivalents (the behavior contracts above). Full gate: `npm run typecheck && npx vitest run`.

- [ ] **Step 8: Commit**

```bash
git add src/shared src/main/runtime/ipc.ts src/renderer/src
git commit -m "feat(effort): provider-real effort replaces universal thinking scale"
```

---

### Task 7: Model wiring for codex/copilot

**Files:**
- Modify: `src/main/runtime/codexAdapter.ts` (`codexArgs` + req type), `src/main/runtime/copilotAdapter.ts` (`copilotArgs` + req type), `src/main/runtime/ipc.ts` (pass `model` to both)
- Test: `src/main/runtime/codexAdapter.test.ts`, `src/main/runtime/copilotAdapter.test.ts`

**Interfaces:**
- Consumes: `RunRequest.model` (existing), Task 6's send path (already sends `model` for every provider via caps-aware `modelIdFor`).
- Produces: `codexArgs(prompt, yolo?, sessionId?, effort?, model?)` emitting `-m <id>` before the `resume` subcommand; `copilotArgs(prompt, yolo?, sessionId?, effort?, model?)` emitting `--model <id>`.

- [ ] **Step 1: Write the failing tests**

`codexAdapter.test.ts`:
```ts
  it('passes -m before the resume subcommand and omits it without a model', () => {
    const args = codexArgs('hi', false, 's1', undefined, 'gpt-5.5')
    expect(args).toEqual(expect.arrayContaining(['-m', 'gpt-5.5']))
    expect(args.indexOf('-m')).toBeLessThan(args.indexOf('resume'))
    expect(codexArgs('hi')).not.toContain('-m')
  })
```

`copilotAdapter.test.ts`:
```ts
  it('passes --model when set', () => {
    expect(copilotArgs('hi', false, undefined, undefined, 'claude-sonnet-4.6')).toEqual(expect.arrayContaining(['--model', 'claude-sonnet-4.6']))
    expect(copilotArgs('hi')).not.toContain('--model')
  })
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** `codexArgs`:
```ts
export function codexArgs(prompt: string, yolo?: boolean, sessionId?: string, effort?: string, model?: string): string[] {
  // exec flags must precede the `resume` subcommand: `codex exec <flags> resume <id> <prompt>`.
  const base = ['exec', '--json', '--skip-git-repo-check', '-s', yolo ? 'workspace-write' : 'read-only']
  if (model) base.push('-m', model)
  if (effort) base.push('-c', `model_reasoning_effort=${effort}`)
  return sessionId ? [...base, 'resume', sessionId, prompt] : [...base, prompt]
}
```
`copilotArgs`: add trailing `model?: string` param and `if (model) args.push('--model', model)` after the effort push. `startCodexRun`/`startCopilotRun` req types gain `model?: string`, forwarded to the builders. `ipc.ts`: add `model: req.model` to the codex and copilot branches.

- [ ] **Step 4: Run to verify pass**, then full gate.

- [ ] **Step 5: Commit**

```bash
git add src/main/runtime/codexAdapter.ts src/main/runtime/copilotAdapter.ts src/main/runtime/*.test.ts src/main/runtime/ipc.ts
git commit -m "feat(adapters): -m/--model wiring for codex and copilot from discovered ids"
```

---

### Task 8: Capability-driven picker UI

**Files:**
- Modify: `src/renderer/src/components/ModelModal.tsx` (provider page renders from caps), `src/renderer/src/data/providers.ts` (drop `models`/`variants`/`modelsWired`/old `modelIdFor`; keep presentation + `options`), `src/renderer/src/components/WorkspaceModal.tsx` (model chips read `STATIC_CAPABILITIES`), `src/renderer/src/data/configs.ts` only if typecheck demands (it shouldn't)
- Delete: `src/main/runtime/discovery.ts`, `src/main/runtime/discovery.test.ts`, the `DISCOVERY_CHANNELS` handler in `ipc.ts`, the `models.discover` preload entry, `DISCOVERY_CHANNELS` in shared/runtime.ts
- Test: `src/renderer/src/data/providers.test.ts` (rewrite: presentation-only assertions move; modelIdFor tests now live in `src/shared/capabilities.test.ts` from Task 1)

**Interfaces:**
- Consumes: store `caps` + `loadCaps` (Task 6), `effortScaleFor`/`findModel`/`STATIC_CAPABILITIES` (Task 1), existing registry probe flow (unchanged).
- Produces: the provider page driven entirely by `ProviderCapabilities`; selectability rule: model chips are clickable when `caps.source === 'protocol'` OR the provider is claude/opencode (static-but-runnable ids); codex/copilot on the static floor show display-only chips + the "Account default" chip (unchanged behavior when discovery fails).

- [ ] **Step 1: providers.ts slims to presentation.** Remove `ModelDef`, `ModelVariant`, `modelIdFor`, `modelsWired`, and every `models:` array from `PROVIDERS`; keep `id/name/detail/dot/status/options` (OptionDef unchanged — effort values now come from caps, so drop `values` from the EFFORT option and delete the `EFFORT` const's `values` field usage in the modal). Update `providers.test.ts` to assert the four providers exist with `options` and no cursor.

- [ ] **Step 2: ModelModal renders from caps.** In the component: on mount AND on page-change to a provider, call `loadCaps(providerId)` (cache makes repeats free; the ↻ button calls `loadCaps(providerId, true)`). Provider page consumes `caps[p.id] ?? STATIC_CAPABILITIES[p.id]`:
- models row: "Account default" chip first (always, `onPick(p.id, 'Account default')`), then one chip per `caps.models` (+ variant chips), `disabled` when the selectability rule says display-only; `isDefault` renders a `· default` suffix; `gated` renders warning tint (`color: 'var(--warning)', borderColor: 'var(--warning)'`) + title "rejected for this account previously";
- effort chips: `[null, ...effortScaleFor(caps, active.model)]` bound to `setEffort`, labels `default|low|…`; render `caps.effortNote` under them when present;
- header: `caps.fetchedAt > 0` shows `updated <time>` + ↻ button; a `caps.source !== 'protocol'` provider whose strategy exists (codex/copilot/opencode) shows the status line `live discovery unavailable — showing known set`;
- page 1 model counts use `caps` (`modelCount((caps[p.id] ?? STATIC_CAPABILITIES[p.id]).models.map(m => ({ ...m, variants: m.variants })))` — adapt `modelCount` to `DiscoveredModel[]`);
- the OpenCode-specific `models.discover` effect is deleted (opencode now flows through caps like everyone).

- [ ] **Step 3: Delete the old discovery surface.** Remove `discovery.ts`, its test, `DISCOVERY_CHANNELS` (shared, ipc, preload), and fix imports. WorkspaceModal: replace `PROVIDERS.find(...).models` usage with `STATIC_CAPABILITIES[providerId].models` labels (workspace defaults are pre-account presets; static is fine and honest there).

- [ ] **Step 4: Verify** — `npm run typecheck && npx vitest run` → green; then `npm run dev` GUI smoke: Claude page shows 6 effort chips + note; Codex page (after ~1-2s) shows the account's real models with per-model efforts; Copilot page shows the 11-model list with usage notes and `· default` on the current one; opencode still lists the account's models; kill-switch check: `codex` off PATH → codex page shows static floor + status line.

- [ ] **Step 5: Commit**

```bash
git add -A src
git commit -m "feat(ui): capability-driven model picker (live per-account models + real effort scales)"
```

---

### Task 9: Live verification vs real binaries + docs

**Files:**
- Modify: `docs/DECISIONS.md` (dated entry superseding the M4 lock), `docs/README.md` (only if the spec/plan listing needs the new files)

- [ ] **Step 1: Codex end-to-end** — in the GUI (or direct CLI equivalents): codex provider page lists the account's models from `model/list`; pick one (e.g. GPT-5.5) → send → run completes with `-m gpt-5.5`; pick an effort from that model's own scale (e.g. xhigh) → send → completes with `-c model_reasoning_effort=xhigh`.

- [ ] **Step 2: Copilot end-to-end** — copilot page lists the ACP models; pick a non-default (e.g. Claude Sonnet 4.6) → send → completes with `--model claude-sonnet-4.6`; verify usage note renders.

- [ ] **Step 3: Ledger loop** — force a gated run (codex + `-m gpt-5-codex` via a temporary chat pick if it appears in the list, else run the CLI directly and hand-check `recordOutcome` fires by inspecting `userData/nac-capability-ledger.json`); confirm the entry exists and the model renders gated-tinted after a caps refresh. A subsequent successful run with an allowed model records `works`.

- [ ] **Step 4: Claude + opencode regression** — claude chat still runs with effort + fast + 1M variant (no behavior change beyond the effort scale gaining xhigh/max/ultracode); opencode picker lists the account models via the new path.

- [ ] **Step 5: DECISIONS.md** — add at the top of the "Current phase" progress items (replace `<commit>` with the real short hash):

```markdown
**✅ Per-account capability discovery — M4 pillar one** (`<commit>`): the model picker now shows what each harness ACTUALLY provides for the owner's account. Codex: app-server v2 `model/list` (per-model reasoning efforts, defaults); Copilot: ACP `session/new` `availableModels` (usage multipliers, current default) — both verified live; codex/copilot model selection is now WIRED (`-m`/`--model`), superseding the 2026-06-29 "needs M4" lock. Claude stays static-base (no headless list exists; API /v1/models rejected — wrapper invariant) + a persisted gating ledger that learns per-account rejections from real run outcomes (verified rejection shapes for all three clouds). Effort is provider-real: per-model scales (codex), each CLI's documented range (claude 5+ultracode, copilot 7, opencode variants), `null` = harness default, reset on provider switch; legacy `thinking` migrated. Degradation ladder protocol → static+learned → static keeps the app at today's floor when discovery fails. Spec: `docs/superpowers/specs/2026-07-08-per-account-capability-discovery-design.md`.
```

- [ ] **Step 6: Final gate** — `npm run typecheck && npx vitest run && npm run build` → all green.

- [ ] **Step 7: Commit**

```bash
git add docs/
git commit -m "docs: per-account capability discovery done — M4 pillar one verified vs real binaries"
```
