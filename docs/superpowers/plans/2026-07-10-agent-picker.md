# Agent Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harness-native agent discovery + selection (claude `--agent`, opencode ACP `mode`) plus NAC-authored agents synced into each harness's native on-disk format, behind a provider-honest picker.

**Architecture:** A new `src/main/runtime/agents/` discovery pillar mirrors M4's `capabilities/` (per-provider strategies + promise-cached dispatcher + one IPC channel), a sync engine writes marker-bearing native files (only files carrying `managed-by: nac-code` are ever touched), and the run threading mirrors model/effort exactly (`Chat.agent` → `RunRequest.agent` → claude respawn-with-resume / opencode `session/set_config_option` on configId `mode`).

**Tech Stack:** Electron main-process Node (fs/os/child_process), TypeScript, vitest (env node for main, jsdom not needed), React + zustand renderer.

## Global Constraints (verbatim from the spec)

- Marker frontmatter key/value: `managed-by: nac-code` (+ `nac-rev: <rev>`). **Only marker-bearing files are ever created, updated, or deleted.** A path collision with a file lacking the marker → `conflict` (file untouched, reported).
- Support map: claude `full`; opencode `full`; copilot `sync-only`, note `Copilot CLI doesn't expose agent selection to integrations — synced agents work in copilot's own CLI`; codex `none`, note `Codex has no agent concept (profiles are config presets)`.
- opencode internal primaries to filter: `compaction`, `summary`, `title`; all `subagent`-mode agents filtered too.
- Sync targets: `~/.claude/agents/<slug>.md`, `~/.copilot/agents/<slug>.agent.md`, `~/.config/opencode/agent/<slug>.md` (opencode file adds `mode: primary`).
- IPC channels: `agents:get`, `agents:sync` (const `AGENTS_CHANNELS` in `src/shared/agents.ts`).
- Discovery never throws — every failure degrades to a floor with `support` intact.
- opencode fail-open on mode rejection reuses the existing `modelMismatch` completion flag (single "requested config wasn't honored" marker; the ledger's works-evidence skip is acceptable conservatism).
- All copilot agents `selectable: false`. codex/copilot never receive `RunRequest.agent`.
- v1 omits workspace default agent + new-chat inheritance + adopt-into-NAC.
- Gate for every task: `npx vitest run` green (currently 269), `npm run typecheck` clean.

## File Structure

- `src/shared/agents.ts` — NEW: `DiscoveredAgent`, `ProviderAgents`, `NacAgent`, `SyncReportEntry`, `AGENTS_CHANNELS`, `slugify`.
- `src/main/runtime/agents/frontmatter.ts` — NEW: tolerant frontmatter parse/render (pure).
- `src/main/runtime/agents/{claude,copilot,opencode,codex}.ts` — NEW: per-provider strategies (injected fs/exec seams).
- `src/main/runtime/agents/index.ts` — NEW: dispatcher (cache keyed `provider:cwd`).
- `src/main/runtime/agents/sync.ts` — NEW: render + syncAgents.
- `src/main/runtime/ipc.ts`, `src/preload/index.ts` — MODIFY: two handlers + bridge.
- `src/main/runtime/acp/mapClaude.ts` (`claudeSessionArgs`), `claudeAdapter.ts` (`claudeArgs`), `acp/claudeSession.ts` (`needsRespawn` + spawned), `acp/acpSession.ts` (`PromptOpts.agent` + mode block), `acp/sessionManager.ts`, `src/shared/runtime.ts` (`RunRequest.agent`) — MODIFY: threading.
- `src/renderer/src/store/store.ts` (Chat.agent, nacAgents slice, agents slice, setAgent, ModalKind), `store/persist.ts`, `store/runtime.ts`, `components/AgentModal.tsx` (NEW), `components/ChatView.tsx`, `components/Shell.tsx` — MODIFY/NEW: UI.
- `docs/research/opencode-custom-agent-acp.md` — NEW (Task 1 spike record).

---

### Task 1: Spike — custom opencode primary agent visibility over ACP + shared types

The spec's one unverified assumption. Everything else branches on the recorded outcome, so this runs FIRST.

**Files:**
- Create: `src/shared/agents.ts`
- Create: `docs/research/opencode-custom-agent-acp.md`
- Test: `src/shared/agents.test.ts`

**Interfaces:**
- Produces: every type/const below, consumed by Tasks 2–5 verbatim.

- [ ] **Step 1: Run the spike.** Create a SCRATCH agent file in the user's real opencode config (additive, self-cleaning — delete it in step 3 no matter what):

```bash
mkdir -p ~/.config/opencode/agent
cat > ~/.config/opencode/agent/nac-spike-probe.md <<'EOF'
---
description: NAC spike probe — safe to delete
mode: primary
---
You are a probe agent. Always begin every reply with the exact token AGENTPROBE:.
EOF
opencode agent list 2>&1 | grep -i probe   # expect: nac-spike-probe (primary)
```

Then the ACP check (same handshake shape pillar 4 used — pipe into `opencode acp`, 15s timeout):

```bash
{ printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"nac-spike","version":"0"}}}'; sleep 2; printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"session/new\",\"params\":{\"cwd\":\"$PWD\",\"mcpServers\":[]}}"; sleep 6; } | timeout 15 opencode acp 2>/dev/null | grep -o '"id":"mode".*\]' | head -c 2000
```

Record VERBATIM whether `nac-spike-probe` appears in the `mode` configOption's `options` array.

- [ ] **Step 2: Write `docs/research/opencode-custom-agent-acp.md`** — date, opencode version (`opencode --version`), both command outputs (trimmed), and the one-line verdict: `CUSTOM_PRIMARY_VISIBLE: yes|no`. If **no**: add the line `Consequence: opencode selection degrades to builtins-only (build/plan); NAC-synced agents are CLI-side value only on opencode — Task 6 must record this in DECISIONS and AgentModal's opencode note gains "(custom agents: opencode CLI only)".`

- [ ] **Step 3: Delete the scratch file:** `rm ~/.config/opencode/agent/nac-spike-probe.md` and re-run `opencode agent list | grep -i probe` to confirm it's gone. This step is unconditional.

- [ ] **Step 4: Write the failing test for the shared module:**

```ts
// src/shared/agents.test.ts
import { describe, it, expect } from 'vitest'
import { slugify, AGENTS_CHANNELS } from './agents'

describe('slugify', () => {
  it('lowercases and hyphenates non-alphanumerics, collapsing runs', () => {
    expect(slugify('My Reviewer!')).toBe('my-reviewer')
    expect(slugify('  Infra / Ops agent ')).toBe('infra-ops-agent')
    expect(slugify('already-good')).toBe('already-good')
  })
  it('never returns an empty slug', () => {
    expect(slugify('!!!')).toBe('agent')
  })
})

describe('channels', () => {
  it('exposes the two agent channels', () => {
    expect(AGENTS_CHANNELS).toEqual({ get: 'agents:get', sync: 'agents:sync' })
  })
})
```

- [ ] **Step 5: Run it to fail:** `npx vitest run src/shared/agents.test.ts` — FAIL (module not found).

- [ ] **Step 6: Implement `src/shared/agents.ts`:**

```ts
// Harness-native agent discovery + NAC-authored sync (spec: docs/superpowers/specs/2026-07-10-agent-picker-design.md).
// One neutral shape for every provider, mirroring ProviderCapabilities.

export interface DiscoveredAgent {
  id: string // provider-unique: the name the harness knows (what --agent / mode value receives)
  name: string
  description?: string
  source: 'user' | 'project' | 'plugin' | 'builtin' | 'nac' // 'nac' = file carries the managed-by marker
  selectable: boolean // false for all copilot agents (its ACP surface doesn't expose --agent)
}

export interface ProviderAgents {
  provider: string
  support: 'full' | 'sync-only' | 'none'
  agents: DiscoveredAgent[]
  note?: string // the honest badge text rendered under the list
  fetchedAt: number
}

// NAC-authored agent (persisted in nac-state via the renderer store). rev bumps on edit —
// the sync engine writes it into each harness's native format (context-library rev pattern).
export interface NacAgent {
  id: string // u_ag_<ts>_<n>
  name: string // display name; slugify(name) is the on-disk filename + harness-facing id
  description: string
  prompt: string // the system-prompt body
  rev: number
}

export type SyncAction = 'written' | 'skipped' | 'conflict' | 'error' | 'pruned'
export interface SyncReportEntry {
  provider: 'claude' | 'copilot' | 'opencode'
  agentId: string // NacAgent.id, or the slug for prunes of orphaned marker files
  action: SyncAction
  detail?: string
}

export const AGENTS_CHANNELS = {
  get: 'agents:get',
  sync: 'agents:sync'
} as const

/** Filesystem/harness-safe slug: lowercase, non-alphanumerics → '-', runs collapsed, trimmed. */
export function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return s || 'agent'
}
```

- [ ] **Step 7: Run to pass:** `npx vitest run src/shared/agents.test.ts` — PASS. Then `npm run typecheck`.

- [ ] **Step 8: Commit:**

```bash
git add src/shared/agents.ts src/shared/agents.test.ts docs/research/opencode-custom-agent-acp.md
git commit -m "feat(agents): shared agent types + spike record (opencode custom-primary ACP visibility)"
```

---

### Task 2: Discovery pillar — frontmatter parser + four strategies + dispatcher + IPC

**Files:**
- Create: `src/main/runtime/agents/frontmatter.ts`, `src/main/runtime/agents/claude.ts`, `src/main/runtime/agents/copilot.ts`, `src/main/runtime/agents/opencode.ts`, `src/main/runtime/agents/codex.ts`, `src/main/runtime/agents/index.ts`
- Modify: `src/main/runtime/ipc.ts` (add handler after the `CAPABILITIES_CHANNELS.get` one at :147), `src/preload/index.ts` (add `agents` to the api object)
- Test: `src/main/runtime/agents/frontmatter.test.ts`, `src/main/runtime/agents/discovery.test.ts`

**Interfaces:**
- Consumes: `DiscoveredAgent`, `ProviderAgents`, `AGENTS_CHANNELS` from Task 1.
- Produces: `parseFrontmatter(raw): { attrs: Record<string,string>; body: string } | null`; `renderFrontmatter(attrs, body): string`; `hasNacMarker(attrs): boolean`; `discoverClaudeAgents(cwd, deps?)`, `discoverCopilotAgents(cwd, deps?)`, `discoverOpenCodeAgents(cwd, deps?)`, `codexAgents()`; `getAgents(provider, cwd, refresh)`, `invalidateAgents(provider?)`; preload `nac.agents.get(provider, cwd, refresh?)`.
- `FsDeps` seam: `{ readdir(dir): Promise<string[]>; readFile(p): Promise<string>; exists(p): Promise<boolean> }`; `ExecDeps`: `{ exec(cmd, args, timeoutMs): Promise<{ code: number; stdout: string }> }`.

- [ ] **Step 1: Failing tests for the parser:**

```ts
// src/main/runtime/agents/frontmatter.test.ts
import { describe, it, expect } from 'vitest'
import { parseFrontmatter, renderFrontmatter, hasNacMarker } from './frontmatter'

describe('parseFrontmatter', () => {
  it('parses key: value lines between --- fences and returns the body', () => {
    const r = parseFrontmatter('---\nname: reviewer\ndescription: Reviews code\n---\nYou review code.\n')
    expect(r).toEqual({ attrs: { name: 'reviewer', description: 'Reviews code' }, body: 'You review code.' })
  })
  it('tolerates missing keys, colons in values, and CRLF', () => {
    const r = parseFrontmatter('---\r\nname: a\r\ndescription: b: with colon\r\n---\r\nbody')
    expect(r!.attrs.description).toBe('b: with colon')
  })
  it('returns null when fences are absent or unclosed', () => {
    expect(parseFrontmatter('no fences here')).toBeNull()
    expect(parseFrontmatter('---\nname: x\nnobody closed me')).toBeNull()
  })
})

describe('renderFrontmatter + marker', () => {
  it('round-trips through parseFrontmatter', () => {
    const raw = renderFrontmatter({ name: 'x', 'managed-by': 'nac-code', 'nac-rev': '3' }, 'PROMPT')
    const back = parseFrontmatter(raw)!
    expect(back.attrs['managed-by']).toBe('nac-code')
    expect(back.body).toBe('PROMPT')
    expect(hasNacMarker(back.attrs)).toBe(true)
    expect(hasNacMarker({ name: 'x' })).toBe(false)
  })
})
```

- [ ] **Step 2: Run to fail**, then implement:

```ts
// src/main/runtime/agents/frontmatter.ts
// Tolerant frontmatter: `key: value` lines between --- fences. Deliberately not YAML — every agent
// file format in play (claude, copilot .agent.md, opencode) uses flat scalar keys, and a YAML dep
// would be the only one in main. Unknown/list-valued lines are kept as raw strings.

export function parseFrontmatter(raw: string): { attrs: Record<string, string>; body: string } | null {
  const text = raw.replace(/\r\n/g, '\n')
  if (!text.startsWith('---\n')) return null
  const end = text.indexOf('\n---', 4)
  if (end < 0) return null
  const attrs: Record<string, string> = {}
  for (const line of text.slice(4, end).split('\n')) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    attrs[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  const body = text.slice(end + 4).replace(/^\n/, '').trimEnd()
  return { attrs, body }
}

export function renderFrontmatter(attrs: Record<string, string>, body: string): string {
  const lines = Object.entries(attrs).map(([k, v]) => `${k}: ${v}`)
  return `---\n${lines.join('\n')}\n---\n${body}\n`
}

export const NAC_MARKER_KEY = 'managed-by'
export const NAC_MARKER_VALUE = 'nac-code'

export function hasNacMarker(attrs: Record<string, string>): boolean {
  return attrs[NAC_MARKER_KEY] === NAC_MARKER_VALUE
}
```

- [ ] **Step 3: Failing tests for the strategies** (injected seams — no real fs):

```ts
// src/main/runtime/agents/discovery.test.ts
import { describe, it, expect } from 'vitest'
import { discoverClaudeAgents, type FsDeps } from './claude'
import { discoverCopilotAgents } from './copilot'
import { discoverOpenCodeAgents, parseAgentList, INTERNAL_PRIMARIES, type ExecDeps } from './opencode'
import { codexAgents } from './codex'

const fakeFs = (files: Record<string, string>): FsDeps => ({
  readdir: async (dir) => {
    const names = Object.keys(files).filter((p) => p.startsWith(dir + '/')).map((p) => p.slice(dir.length + 1))
    const direct = [...new Set(names.map((n) => n.split('/')[0]))]
    if (!direct.length) throw new Error('ENOENT')
    return direct
  },
  readFile: async (p) => {
    if (!(p in files)) throw new Error('ENOENT')
    return files[p]
  },
  exists: async (p) => p in files || Object.keys(files).some((f) => f.startsWith(p + '/'))
})

const agentMd = (name: string, marker = false): string =>
  `---\nname: ${name}\ndescription: d-${name}\n${marker ? 'managed-by: nac-code\nnac-rev: 1\n' : ''}---\nprompt`

describe('discoverClaudeAgents', () => {
  it('merges user + project agents, marks nac-managed files, and is selectable', async () => {
    const fs = fakeFs({
      '/home/.claude/agents/rev.md': agentMd('rev'),
      '/home/.claude/agents/mine.md': agentMd('mine', true),
      '/ws/.claude/agents/proj.md': agentMd('proj')
    })
    const r = await discoverClaudeAgents('/ws', { fs, home: '/home' })
    expect(r.support).toBe('full')
    const by = Object.fromEntries(r.agents.map((a) => [a.id, a]))
    expect(by.rev.source).toBe('user')
    expect(by.mine.source).toBe('nac')
    expect(by.proj.source).toBe('project')
    expect(r.agents.every((a) => a.selectable)).toBe(true)
  })
  it('missing dirs → empty list, support intact, never throws', async () => {
    const r = await discoverClaudeAgents('/nowhere', { fs: fakeFs({}), home: '/home' })
    expect(r.support).toBe('full')
    expect(r.agents).toEqual([])
  })
  it('falls back to the filename slug when frontmatter has no name', async () => {
    const fs = fakeFs({ '/home/.claude/agents/anon.md': '---\ndescription: x\n---\nbody' })
    const r = await discoverClaudeAgents(undefined, { fs, home: '/home' })
    expect(r.agents[0].id).toBe('anon')
  })
})

describe('discoverCopilotAgents', () => {
  it('scans both dirs, everything selectable:false, support sync-only with the honest note', async () => {
    const fs = fakeFs({
      '/home/.copilot/agents/a.agent.md': agentMd('a'),
      '/ws/.github/agents/b.agent.md': agentMd('b', true)
    })
    const r = await discoverCopilotAgents('/ws', { fs, home: '/home' })
    expect(r.support).toBe('sync-only')
    expect(r.note).toContain("doesn't expose agent selection")
    expect(r.agents.map((a) => a.selectable)).toEqual([false, false])
    expect(r.agents.find((a) => a.id === 'b')!.source).toBe('nac')
  })
})

describe('opencode', () => {
  it('parseAgentList keeps primaries, drops internals and subagents', () => {
    const out = 'build (primary)\n{"permission":{}}\ncompaction (primary)\nexplore (subagent)\nplan (primary)\nmy-agent (primary)\n'
    expect(parseAgentList(out).map((a) => a.id)).toEqual(['build', 'plan', 'my-agent'])
  })
  it('INTERNAL_PRIMARIES is the spec set', () => {
    expect(INTERNAL_PRIMARIES).toEqual(new Set(['compaction', 'summary', 'title']))
  })
  it('exec failure falls back to fs scan, then to the static builtins floor', async () => {
    const failExec: ExecDeps = { exec: async () => ({ code: 1, stdout: '' }) }
    const withFile = await discoverOpenCodeAgents('/ws', { exec: failExec, fs: fakeFs({ '/home/.config/opencode/agent/c.md': agentMd('c', true) }), home: '/home' })
    expect(withFile.agents.some((a) => a.id === 'c' && a.source === 'nac')).toBe(true)
    const bare = await discoverOpenCodeAgents('/ws', { exec: failExec, fs: fakeFs({}), home: '/home' })
    expect(bare.agents.map((a) => a.id)).toEqual(['build', 'plan'])
    expect(bare.agents[0].source).toBe('builtin')
  })
  it('marks nac-managed customs from the fs even when exec succeeds', async () => {
    const exec: ExecDeps = { exec: async () => ({ code: 0, stdout: 'build (primary)\nplan (primary)\nmine (primary)\n' }) }
    const r = await discoverOpenCodeAgents('/ws', { exec, fs: fakeFs({ '/home/.config/opencode/agent/mine.md': agentMd('mine', true) }), home: '/home' })
    expect(r.agents.find((a) => a.id === 'mine')!.source).toBe('nac')
    expect(r.agents.find((a) => a.id === 'build')!.source).toBe('builtin')
  })
})

describe('codexAgents', () => {
  it('is the honest static none', () => {
    const r = codexAgents()
    expect(r.support).toBe('none')
    expect(r.agents).toEqual([])
    expect(r.note).toBe('Codex has no agent concept (profiles are config presets)')
  })
})
```

- [ ] **Step 4: Run to fail**, then implement the strategies:

```ts
// src/main/runtime/agents/claude.ts
import { homedir } from 'os'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import type { DiscoveredAgent, ProviderAgents } from '../../../shared/agents'
import { parseFrontmatter, hasNacMarker } from './frontmatter'

// claude has NO enumeration command (probe 2026-07-10: `claude agents` lists running sessions, not
// types) — discovery is a filesystem scan of the three locations custom agents live in.

export interface FsDeps {
  readdir(dir: string): Promise<string[]>
  readFile(p: string): Promise<string>
  exists(p: string): Promise<boolean>
}
export const realFs: FsDeps = {
  readdir: (d) => readdir(d),
  readFile: (p) => readFile(p, 'utf8'),
  exists: async (p) => {
    try {
      await readdir(p)
      return true
    } catch {
      return false
    }
  }
}

export async function scanAgentDir(
  fs: FsDeps,
  dir: string,
  source: DiscoveredAgent['source'],
  suffix = '.md',
  selectable = true
): Promise<DiscoveredAgent[]> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return [] // missing dir — the common case, never an error
  }
  const out: DiscoveredAgent[] = []
  for (const n of names.filter((n) => n.endsWith(suffix))) {
    try {
      const parsed = parseFrontmatter(await fs.readFile(join(dir, n)))
      const fallback = n.slice(0, -suffix.length)
      out.push({
        id: parsed?.attrs.name || fallback,
        name: parsed?.attrs.name || fallback,
        description: parsed?.attrs.description || undefined,
        source: parsed && hasNacMarker(parsed.attrs) ? 'nac' : source,
        selectable
      })
    } catch {
      // unreadable file — skip it, never fail the scan
    }
  }
  return out
}

/** Bounded walk for plugin agents: any dir literally named `agents` under ~/.claude/plugins, ≤6 deep. */
async function scanPluginAgents(fs: FsDeps, root: string): Promise<DiscoveredAgent[]> {
  const found: DiscoveredAgent[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6) return
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e)
      if (e === 'agents') found.push(...(await scanAgentDir(fs, p, 'plugin')))
      else if (!e.includes('.')) await walk(p, depth + 1) // extension-less entry = likely dir; cheap heuristic, wrong guesses just ENOENT-skip
    }
  }
  await walk(root, 0)
  return found
}

export async function discoverClaudeAgents(cwd: string | undefined, deps?: { fs?: FsDeps; home?: string }): Promise<ProviderAgents> {
  const fs = deps?.fs ?? realFs
  const home = deps?.home ?? homedir()
  const agents = [
    ...(await scanAgentDir(fs, join(home, '.claude', 'agents'), 'user')),
    ...(cwd ? await scanAgentDir(fs, join(cwd, '.claude', 'agents'), 'project') : []),
    ...(await scanPluginAgents(fs, join(home, '.claude', 'plugins')))
  ]
  // Dedup by id — a project agent shadows a user/plugin one of the same name (first wins per claude's own precedence: keep the order above but prefer earlier project? claude resolves project first) —
  // precedence: project > user > plugin, so sort-stable filter keeping the highest-precedence occurrence.
  const rank = { project: 0, nac: 1, user: 1, plugin: 2, builtin: 3 } as const
  const byId = new Map<string, DiscoveredAgent>()
  for (const a of [...agents].sort((x, y) => rank[x.source] - rank[y.source])) if (!byId.has(a.id)) byId.set(a.id, a)
  return { provider: 'claude', support: 'full', agents: [...byId.values()], fetchedAt: Date.now() }
}
```

```ts
// src/main/runtime/agents/copilot.ts
import { homedir } from 'os'
import { join } from 'path'
import type { ProviderAgents } from '../../../shared/agents'
import { scanAgentDir, realFs, type FsDeps } from './claude'

export const COPILOT_NOTE = "Copilot CLI doesn't expose agent selection to integrations — synced agents work in copilot's own CLI"

export async function discoverCopilotAgents(cwd: string | undefined, deps?: { fs?: FsDeps; home?: string }): Promise<ProviderAgents> {
  const fs = deps?.fs ?? realFs
  const home = deps?.home ?? homedir()
  const agents = [
    ...(await scanAgentDir(fs, join(home, '.copilot', 'agents'), 'user', '.agent.md', false)),
    ...(cwd ? await scanAgentDir(fs, join(cwd, '.github', 'agents'), 'project', '.agent.md', false) : [])
  ]
  return { provider: 'copilot', support: 'sync-only', agents, note: COPILOT_NOTE, fetchedAt: Date.now() }
}
```

```ts
// src/main/runtime/agents/opencode.ts
import { homedir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import type { DiscoveredAgent, ProviderAgents } from '../../../shared/agents'
import { scanAgentDir, realFs, type FsDeps } from './claude'

// opencode HAS enumeration: `opencode agent list` prints `name (primary|subagent)` lines (each
// followed by a permission-ruleset JSON line we ignore). Primaries minus the internal set are the
// user-facing agents; ACP exposes exactly those as the `mode` configOption (pillar-4 mechanism).

export const INTERNAL_PRIMARIES = new Set(['compaction', 'summary', 'title'])
const LIST_TIMEOUT_MS = 3000

export interface ExecDeps {
  exec(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string }>
}
export const realExec: ExecDeps = {
  exec: (cmd, args, timeoutMs) =>
    new Promise((resolve) => {
      let out = ''
      let done = false
      const finish = (code: number): void => {
        if (!done) {
          done = true
          resolve({ code, stdout: out })
        }
      }
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] })
      } catch {
        finish(1)
        return
      }
      const timer = setTimeout(() => {
        child.kill()
        finish(1)
      }, timeoutMs)
      child.stdout?.on('data', (c) => (out += c.toString()))
      child.on('error', () => {
        clearTimeout(timer)
        finish(1)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        finish(code ?? 1)
      })
    })
}

export function parseAgentList(stdout: string): DiscoveredAgent[] {
  const out: DiscoveredAgent[] = []
  for (const line of stdout.split('\n')) {
    const m = /^(\S+)\s+\((primary|subagent)\)\s*$/.exec(line.trim())
    if (!m) continue
    const [, id, mode] = m
    if (mode !== 'primary' || INTERNAL_PRIMARIES.has(id)) continue
    out.push({ id, name: id, source: 'builtin', selectable: true })
  }
  return out
}

const BUILTIN_FLOOR: DiscoveredAgent[] = [
  { id: 'build', name: 'build', description: 'The default agent. Executes tools based on configured permissions.', source: 'builtin', selectable: true },
  { id: 'plan', name: 'plan', description: 'Plan mode. Disallows all edit tools.', source: 'builtin', selectable: true }
]

export async function discoverOpenCodeAgents(
  cwd: string | undefined,
  deps?: { exec?: ExecDeps; fs?: FsDeps; home?: string }
): Promise<ProviderAgents> {
  const exec = deps?.exec ?? realExec
  const fs = deps?.fs ?? realFs
  const home = deps?.home ?? homedir()
  // fs scan runs regardless — it carries source fidelity (nac marker / user / project) the list output lacks.
  const fsAgents = [
    ...(await scanAgentDir(fs, join(home, '.config', 'opencode', 'agent'), 'user')),
    ...(cwd ? await scanAgentDir(fs, join(cwd, '.opencode', 'agent'), 'project') : [])
  ]
  const bySlug = new Map(fsAgents.map((a) => [a.id, a]))
  const { code, stdout } = await exec.exec('opencode', ['agent', 'list'], LIST_TIMEOUT_MS)
  let agents: DiscoveredAgent[]
  if (code === 0 && stdout.trim()) {
    agents = parseAgentList(stdout).map((a) => bySlug.get(a.id) ?? a) // fs entry wins: carries real source
  } else if (fsAgents.length) {
    agents = [...BUILTIN_FLOOR, ...fsAgents]
  } else {
    agents = BUILTIN_FLOOR
  }
  return { provider: 'opencode', support: 'full', agents, fetchedAt: Date.now() }
}
```

```ts
// src/main/runtime/agents/codex.ts
import type { ProviderAgents } from '../../../shared/agents'

// Probe 2026-07-10 (codex 0.142.3): -p/--profile layers a config file; AGENTS.md is context, not a
// persona. There is no agent concept to discover — this is the honest static answer.
export function codexAgents(): ProviderAgents {
  return { provider: 'codex', support: 'none', agents: [], note: 'Codex has no agent concept (profiles are config presets)', fetchedAt: Date.now() }
}
```

```ts
// src/main/runtime/agents/index.ts
import type { ProviderAgents } from '../../../shared/agents'
import { discoverClaudeAgents } from './claude'
import { discoverCopilotAgents } from './copilot'
import { discoverOpenCodeAgents } from './opencode'
import { codexAgents } from './codex'

// Coalesced per-(provider,cwd) fetches, mirroring capabilities/index.ts. Discovery never rejects —
// every strategy already degrades internally; this floor covers an unknown provider id.
const cache = new Map<string, Promise<ProviderAgents>>()

async function fetchAgents(provider: string, cwd: string | undefined): Promise<ProviderAgents> {
  try {
    if (provider === 'claude') return await discoverClaudeAgents(cwd)
    if (provider === 'copilot') return await discoverCopilotAgents(cwd)
    if (provider === 'opencode') return await discoverOpenCodeAgents(cwd)
    if (provider === 'codex') return codexAgents()
  } catch {
    // strategies shouldn't throw; belt-and-braces floor below
  }
  return { provider, support: 'none', agents: [], fetchedAt: Date.now() }
}

export function getAgents(provider: string, cwd: string | undefined, refresh = false): Promise<ProviderAgents> {
  const key = `${provider}:${cwd ?? ''}`
  if (!refresh && cache.has(key)) return cache.get(key)!
  const fetch = fetchAgents(provider, cwd)
  cache.set(key, fetch)
  return fetch
}

/** Drop cached discovery (all cwds for the provider; no provider = everything) — sync calls this. */
export function invalidateAgents(provider?: string): void {
  for (const key of [...cache.keys()]) if (!provider || key.startsWith(`${provider}:`)) cache.delete(key)
}
```

- [ ] **Step 5: Wire IPC + preload.** In `src/main/runtime/ipc.ts`: add to the imports `import { getAgents } from './agents'` and `AGENTS_CHANNELS` from `'../../shared/agents'`; directly below the `CAPABILITIES_CHANNELS.get` handler add:

```ts
  // Harness-native agent discovery (agent picker): per-provider scan/exec with a static floor.
  ipcMain.handle(AGENTS_CHANNELS.get, (_e, provider: string, cwd?: string, refresh?: boolean) => getAgents(provider, cwd, refresh === true))
```

In `src/preload/index.ts`: extend the runtime import line's types with `import { AGENTS_CHANNELS, type ProviderAgents } from '../shared/agents'` (separate import line) and add to `api`:

```ts
  agents: {
    get: (provider: string, cwd?: string, refresh?: boolean): Promise<ProviderAgents> => ipcRenderer.invoke(AGENTS_CHANNELS.get, provider, cwd, refresh)
  }
```

- [ ] **Step 6: Run everything:** `npx vitest run` (all green) + `npm run typecheck`.

- [ ] **Step 7: Commit:**

```bash
git add src/main/runtime/agents src/main/runtime/ipc.ts src/preload/index.ts
git commit -m "feat(agents): discovery pillar — four provider strategies, dispatcher, agents:get IPC"
```

---

### Task 3: Sync engine — render + marker-guarded write/prune + agents:sync IPC

**Files:**
- Create: `src/main/runtime/agents/sync.ts`
- Modify: `src/main/runtime/ipc.ts`, `src/preload/index.ts`
- Test: `src/main/runtime/agents/sync.test.ts`

**Interfaces:**
- Consumes: `NacAgent`, `SyncReportEntry`, `slugify` (Task 1); `parseFrontmatter`, `renderFrontmatter`, `hasNacMarker` (Task 2); `invalidateAgents` (Task 2).
- Produces: `renderClaudeAgent(a)`, `renderCopilotAgent(a)`, `renderOpenCodeAgent(a)` (pure, string); `syncAgents(nacAgents, deps?): Promise<SyncReportEntry[]>`; preload `nac.agents.sync(nacAgents)`.
- `SyncFsDeps`: `{ readFile(p): Promise<string>; writeFile(p, s): Promise<void>; mkdir(dir): Promise<void>; readdir(dir): Promise<string[]>; unlink(p): Promise<void> }`.

- [ ] **Step 1: Failing tests:**

```ts
// src/main/runtime/agents/sync.test.ts
import { describe, it, expect } from 'vitest'
import { renderClaudeAgent, renderCopilotAgent, renderOpenCodeAgent, syncAgents, type SyncFsDeps } from './sync'
import { parseFrontmatter } from './frontmatter'
import type { NacAgent } from '../../../shared/agents'

const nac = (over: Partial<NacAgent> = {}): NacAgent => ({ id: 'u_ag_1_1', name: 'My Reviewer', description: 'Reviews', prompt: 'You review.', rev: 2, ...over })

describe('render functions', () => {
  it('claude file carries name/description/marker/rev + prompt body', () => {
    const p = parseFrontmatter(renderClaudeAgent(nac()))!
    expect(p.attrs).toEqual({ name: 'my-reviewer', description: 'Reviews', 'managed-by': 'nac-code', 'nac-rev': '2' })
    expect(p.body).toBe('You review.')
  })
  it('opencode file adds mode: primary; copilot matches claude shape', () => {
    expect(parseFrontmatter(renderOpenCodeAgent(nac()))!.attrs.mode).toBe('primary')
    expect(parseFrontmatter(renderCopilotAgent(nac()))!.attrs['managed-by']).toBe('nac-code')
  })
})

const memFs = (initial: Record<string, string> = {}): SyncFsDeps & { files: Record<string, string> } => {
  const files = { ...initial }
  return {
    files,
    readFile: async (p) => {
      if (!(p in files)) throw new Error('ENOENT')
      return files[p]
    },
    writeFile: async (p, s) => void (files[p] = s),
    mkdir: async () => {},
    readdir: async (dir) => Object.keys(files).filter((p) => p.startsWith(dir + '/')).map((p) => p.slice(dir.length + 1)).filter((n) => !n.includes('/')),
    unlink: async (p) => void delete files[p]
  }
}

describe('syncAgents', () => {
  const home = '/h'
  const target = (rest: string): string => `${home}/${rest}`

  it('writes all three targets with markers, reports written', async () => {
    const fs = memFs()
    const report = await syncAgents([nac()], { fs, home })
    expect(report.filter((r) => r.action === 'written')).toHaveLength(3)
    expect(fs.files[target('.claude/agents/my-reviewer.md')]).toContain('managed-by: nac-code')
    expect(fs.files[target('.copilot/agents/my-reviewer.agent.md')]).toBeDefined()
    expect(fs.files[target('.config/opencode/agent/my-reviewer.md')]).toContain('mode: primary')
  })

  it('unchanged rev → skipped (idempotent)', async () => {
    const fs = memFs()
    await syncAgents([nac()], { fs, home })
    const report = await syncAgents([nac()], { fs, home })
    expect(report.every((r) => r.action === 'skipped')).toBe(true)
  })

  it('NEVER touches a foreign file at a colliding path — reports conflict', async () => {
    const fs = memFs({ [target('.claude/agents/my-reviewer.md')]: '---\nname: my-reviewer\n---\nhand-authored' })
    const report = await syncAgents([nac()], { fs, home })
    expect(fs.files[target('.claude/agents/my-reviewer.md')]).toContain('hand-authored')
    expect(report.find((r) => r.provider === 'claude')!.action).toBe('conflict')
    expect(report.filter((r) => r.action === 'written')).toHaveLength(2) // other targets proceed
  })

  it('prunes marker files whose agent no longer exists; leaves foreign files alone', async () => {
    const fs = memFs()
    await syncAgents([nac()], { fs, home })
    fs.files[target('.claude/agents/handmade.md')] = '---\nname: handmade\n---\nkeep me'
    const report = await syncAgents([], { fs, home })
    expect(fs.files[target('.claude/agents/my-reviewer.md')]).toBeUndefined()
    expect(fs.files[target('.claude/agents/handmade.md')]).toContain('keep me')
    expect(report.some((r) => r.action === 'pruned' && r.provider === 'claude')).toBe(true)
  })
})
```

- [ ] **Step 2: Run to fail**, then implement:

```ts
// src/main/runtime/agents/sync.ts
import { homedir } from 'os'
import { readFile, writeFile, mkdir, readdir, unlink } from 'fs/promises'
import { join, dirname } from 'path'
import { slugify, type NacAgent, type SyncReportEntry } from '../../../shared/agents'
import { parseFrontmatter, renderFrontmatter, hasNacMarker } from './frontmatter'
import { invalidateAgents } from './index'

// NAC→harness one-way sync. THE contract (spec §3): only files carrying `managed-by: nac-code`
// are ever created, updated, deleted, or pruned. A colliding foreign file → conflict, untouched.

export interface SyncFsDeps {
  readFile(p: string): Promise<string>
  writeFile(p: string, s: string): Promise<void>
  mkdir(dir: string): Promise<void>
  readdir(dir: string): Promise<string[]>
  unlink(p: string): Promise<void>
}
const realFs: SyncFsDeps = {
  readFile: (p) => readFile(p, 'utf8'),
  writeFile: (p, s) => writeFile(p, s, 'utf8'),
  mkdir: async (d) => void (await mkdir(d, { recursive: true })),
  readdir: (d) => readdir(d),
  unlink: (p) => unlink(p)
}

const baseAttrs = (a: NacAgent): Record<string, string> => ({
  name: slugify(a.name),
  description: a.description,
  'managed-by': 'nac-code',
  'nac-rev': String(a.rev)
})

export const renderClaudeAgent = (a: NacAgent): string => renderFrontmatter(baseAttrs(a), a.prompt)
export const renderCopilotAgent = (a: NacAgent): string => renderFrontmatter(baseAttrs(a), a.prompt)
export const renderOpenCodeAgent = (a: NacAgent): string => renderFrontmatter({ ...baseAttrs(a), mode: 'primary' }, a.prompt)

interface Target {
  provider: 'claude' | 'copilot' | 'opencode'
  dir: (home: string) => string
  file: (slug: string) => string
  render: (a: NacAgent) => string
}
const TARGETS: Target[] = [
  { provider: 'claude', dir: (h) => join(h, '.claude', 'agents'), file: (s) => `${s}.md`, render: renderClaudeAgent },
  { provider: 'copilot', dir: (h) => join(h, '.copilot', 'agents'), file: (s) => `${s}.agent.md`, render: renderCopilotAgent },
  { provider: 'opencode', dir: (h) => join(h, '.config', 'opencode', 'agent'), file: (s) => `${s}.md`, render: renderOpenCodeAgent }
]

export async function syncAgents(nacAgents: NacAgent[], deps?: { fs?: SyncFsDeps; home?: string }): Promise<SyncReportEntry[]> {
  const fs = deps?.fs ?? realFs
  const home = deps?.home ?? homedir()
  const report: SyncReportEntry[] = []
  for (const t of TARGETS) {
    const dir = t.dir(home)
    const wanted = new Set(nacAgents.map((a) => t.file(slugify(a.name))))
    for (const a of nacAgents) {
      const path = join(dir, t.file(slugify(a.name)))
      try {
        let existing: { attrs: Record<string, string> } | null = null
        try {
          existing = parseFrontmatter(await fs.readFile(path))
        } catch {
          existing = null // no file — free to create
        }
        if (existing && !hasNacMarker(existing.attrs)) {
          report.push({ provider: t.provider, agentId: a.id, action: 'conflict', detail: `${path} exists and is not NAC-managed` })
          continue
        }
        if (existing && existing.attrs['nac-rev'] === String(a.rev)) {
          report.push({ provider: t.provider, agentId: a.id, action: 'skipped' })
          continue
        }
        await fs.mkdir(dir)
        await fs.writeFile(path, t.render(a))
        report.push({ provider: t.provider, agentId: a.id, action: 'written' })
      } catch (e) {
        report.push({ provider: t.provider, agentId: a.id, action: 'error', detail: (e as Error).message })
      }
    }
    // Prune: marker-bearing files in our dir that no current NacAgent claims (deleted/renamed in NAC).
    try {
      for (const name of await fs.readdir(dir)) {
        if (wanted.has(name)) continue
        const path = join(dir, name)
        try {
          const parsed = parseFrontmatter(await fs.readFile(path))
          if (parsed && hasNacMarker(parsed.attrs)) {
            await fs.unlink(path)
            report.push({ provider: t.provider, agentId: name, action: 'pruned' })
          }
        } catch {
          // unreadable/foreign — leave it
        }
      }
    } catch {
      // dir missing — nothing to prune
    }
  }
  invalidateAgents() // discovery must re-see the world after any sync
  return report
}
```

- [ ] **Step 3: Wire IPC + preload.** `ipc.ts` — import `{ syncAgents }` from `'./agents/sync'` and `type NacAgent` from `'../../shared/agents'`; below the `agents:get` handler:

```ts
  ipcMain.handle(AGENTS_CHANNELS.sync, (_e, nacAgents: NacAgent[]) => syncAgents(Array.isArray(nacAgents) ? nacAgents : []))
```

`preload/index.ts` — extend the agents bridge:

```ts
  agents: {
    get: (provider: string, cwd?: string, refresh?: boolean): Promise<ProviderAgents> => ipcRenderer.invoke(AGENTS_CHANNELS.get, provider, cwd, refresh),
    sync: (nacAgents: NacAgent[]): Promise<SyncReportEntry[]> => ipcRenderer.invoke(AGENTS_CHANNELS.sync, nacAgents)
  }
```

(types `NacAgent`, `SyncReportEntry` join the shared-agents import line.)

- [ ] **Step 4: Run everything:** `npx vitest run` + `npm run typecheck` — green.

- [ ] **Step 5: Commit:**

```bash
git add src/main/runtime/agents/sync.ts src/main/runtime/agents/sync.test.ts src/main/runtime/ipc.ts src/preload/index.ts
git commit -m "feat(agents): sync engine — marker-guarded native-file writes with conflict/prune report"
```

---

### Task 4: Run threading — RunRequest.agent → claude --agent / opencode mode

**Files:**
- Modify: `src/shared/runtime.ts:17` (RunRequest), `src/main/runtime/acp/acpSession.ts:17-21` (PromptOpts) + `runTurn` (~:267), `src/main/runtime/acp/mapClaude.ts:8-17` (claudeSessionArgs), `src/main/runtime/acp/claudeSession.ts:35-40,70,86,130-140` (needsRespawn/spawned), `src/main/runtime/claudeAdapter.ts:75` (claudeArgs) + `startClaudeRun` req type + call, `src/main/runtime/acp/sessionManager.ts:46-58,96,113` (opts threading), `src/main/runtime/ipc.ts:86,95` (pass agent)
- Test: extend `src/main/runtime/acp/claudeSession.test.ts` (needsRespawn cases) and `src/main/runtime/claudeAdapter.test.ts` / `mapClaude.test.ts` wherever `claudeArgs`/`claudeSessionArgs` are already asserted (find with `grep -rn "claudeSessionArgs\|claudeArgs(" src --include=*.test.ts`)

**Interfaces:**
- Consumes: nothing new — pure threading.
- Produces: `RunRequest.agent?: string`; `PromptOpts.agent?: string`; `claudeSessionArgs({... agent?})` emits `--agent <name>`; `claudeArgs(..., agent?)` (append as LAST param to preserve existing call sites); `needsRespawn` treats agent like model/effort; AcpSession applies configId `'mode'` for opencode.

- [ ] **Step 1: Failing tests.** Add to the existing suites (exact test names/files may differ — extend whichever file already tests each function):

```ts
// claudeSession.test.ts additions
it('needsRespawn fires on agent change like model/effort, and not on undefined', () => {
  expect(needsRespawn({ agent: 'a' }, { agent: 'b' }, 'sid')).toBe(true)
  expect(needsRespawn({ agent: 'a' }, {}, 'sid')).toBe(false)
  expect(needsRespawn({ agent: 'a' }, { agent: 'b' }, null)).toBe(false)
})

// mapClaude.test.ts additions
it('claudeSessionArgs appends --agent when provided', () => {
  const args = claudeSessionArgs({ yolo: false, agent: 'reviewer' })
  expect(args).toContain('--agent')
  expect(args[args.indexOf('--agent') + 1]).toBe('reviewer')
  expect(claudeSessionArgs({ yolo: false })).not.toContain('--agent')
})

// claudeAdapter.test.ts additions
it('claudeArgs appends --agent as the trailing optional', () => {
  const args = claudeArgs('p', undefined, false, undefined, undefined, undefined, 'reviewer')
  expect(args).toContain('--agent')
})
```

- [ ] **Step 2: Run to fail, then implement each seam:**

`src/shared/runtime.ts` — after `fast?: boolean` (line 17):

```ts
  agent?: string // harness-native agent (claude --agent / opencode ACP mode); omitted = harness default
```

`acpSession.ts` PromptOpts:

```ts
export interface PromptOpts {
  model?: string
  effort?: string
  agent?: string // opencode: applied as the `mode` configOption (probe 2026-07-10); claude: spawn-arg (see claudeSession)
  context?: ContextPayload
}
```

`acpSession.ts` — add `private appliedMode: string | null = null` beside `appliedModel`, and in `runTurn` directly after the existing model set_config block (before the `if (this.interrupted)` check):

```ts
      if (this.profile.provider === 'opencode' && opts?.agent && opts.agent !== this.appliedMode) {
        try {
          await this.client.request('session/set_config_option', { sessionId: this.sessionId, configId: 'mode', value: opts.agent }, HANDSHAKE_TIMEOUT_MS)
          this.appliedMode = opts.agent
        } catch {
          // fail-open, same doctrine as model: the harness keeps its current mode; reuse the single
          // "requested config wasn't honored" completion marker.
          this.modelMismatchThisTurn = true
        }
      }
```

`mapClaude.ts` `claudeSessionArgs`:

```ts
export function claudeSessionArgs(o: { yolo: boolean; model?: string; effort?: string; agent?: string; sessionId?: string }): string[] {
  // ...existing base args unchanged...
  if (o.model) args.push('--model', o.model)
  if (o.effort) args.push('--effort', o.effort)
  if (o.agent) args.push('--agent', o.agent) // spawn-time agent identity (probe: global flag, stream-json-safe)
  if (o.sessionId) args.push('--resume', o.sessionId)
  return args
}
```

`claudeSession.ts` — `spawned`/`needsRespawn`/`newClient`/constructor/prompt all learn `agent`, exactly parallel to `model`:

```ts
export function needsRespawn(spawned: PromptOpts, requested: PromptOpts, sessionId: string | null): boolean {
  if (sessionId === null) return false
  const modelChanged = requested.model !== undefined && requested.model !== spawned.model
  const effortChanged = requested.effort !== undefined && requested.effort !== spawned.effort
  const agentChanged = requested.agent !== undefined && requested.agent !== spawned.agent
  return modelChanged || effortChanged || agentChanged
}
```

constructor: `this.spawned = { model: opts?.model, effort: opts?.effort, agent: opts?.agent }`; `newClient`: pass `agent: this.spawned.agent` into `claudeSessionArgs`; the respawn block in `prompt()` adds `agent: requested.agent !== undefined ? requested.agent : this.spawned.agent`.

`claudeAdapter.ts` — `claudeArgs` gains a trailing `agent?: string` param emitting `if (agent) args.push('--agent', agent)`; `startClaudeRun`'s req type gains `agent?: string` and the `claudeArgs(...)` call passes `req.agent` last.

`sessionManager.ts` — `promptViaTransport` opts gains `agent?: string`; the ClaudeSession construction passes `{ model: opts.model, effort: opts.effort, agent: opts.agent }`; `promptOpts` becomes `{ model: opts.model, effort: opts.effort, agent: opts.agent, context: opts.context }`.

`ipc.ts` — the `promptViaTransport({...})` call adds `agent: req.agent`, and the claude one-shot fallback adds `agent: req.agent` to its req object. (codex/copilot/opencode fallbacks do NOT get it.)

- [ ] **Step 3: Run everything:** `npx vitest run` + `npm run typecheck` — green.

- [ ] **Step 4: Commit:**

```bash
git add src/shared/runtime.ts src/main/runtime/acp src/main/runtime/claudeAdapter.ts src/main/runtime/ipc.ts
git commit -m "feat(agents): thread RunRequest.agent — claude --agent respawn, opencode ACP mode set_config"
```

---

### Task 5: Renderer — store slice, persistence, AgentModal, composer chip

**Files:**
- Modify: `src/renderer/src/store/store.ts` (Chat.agent at the interface ~:61-90, `ModalKind` :92, new slices + actions), `src/renderer/src/store/persist.ts` (PersistedState + normalizeChat + snapshot), `src/renderer/src/store/runtime.ts` (send path ~:146), `src/renderer/src/components/ChatView.tsx` (toolbar ~:196), `src/renderer/src/components/Shell.tsx` (:59-61 mounts)
- Create: `src/renderer/src/components/AgentModal.tsx`
- Test: extend `src/renderer/src/store/persist.test.ts`

**Interfaces:**
- Consumes: `ProviderAgents`, `NacAgent`, `SyncReportEntry`, `slugify` from `src/shared/agents`; `window.nac.agents.get/sync` (Tasks 2-3); `RunRequest.agent` (Task 4).
- Produces: store fields `agents: Record<string, ProviderAgents>`, `nacAgents: NacAgent[]`, `Chat.agent: string | null`; actions `loadAgents(provider, refresh?)`, `setAgent(name)`, `saveNacAgent(a)`, `deleteNacAgent(id)`, `lastSyncReport: SyncReportEntry[] | null`; `ModalKind` gains `'agent'`.

- [ ] **Step 1: Failing persistence tests** (add to persist.test.ts):

```ts
describe('agent picker persistence', () => {
  it('hydrates a string Chat.agent and null default; junk becomes null', () => {
    expect(normalizeChat({ agent: 'reviewer' } as never, 'c1').agent).toBe('reviewer')
    expect(normalizeChat({} as never, 'c2').agent).toBeNull()
    expect(normalizeChat({ agent: 42 as unknown as string } as never, 'c3').agent).toBeNull()
  })
  it('round-trips nacAgents and drops malformed entries', async () => {
    const nacAgents = [
      { id: 'u_ag_1_1', name: 'A', description: 'd', prompt: 'p', rev: 1 },
      null,
      { id: 'u_ag_2_2', name: 'B' } // missing prompt/rev
    ]
    const loaded = { chats: {}, workspaces: [{ id: 'ws_default', name: 'W', path: '' }], activeChatId: '', layout: 'studio', expanded: {}, nacAgents }
    // @ts-expect-error minimal window.nac.state stub
    globalThis.window = { nac: { state: { load: async () => loaded, save: async () => {} } } }
    await initPersistence()
    expect(useApp.getState().nacAgents).toEqual([{ id: 'u_ag_1_1', name: 'A', description: 'd', prompt: 'p', rev: 1 }])
  })
})
```

(add the `afterEach` window teardown to the new describe, matching the file's existing pattern.)

- [ ] **Step 2: Run to fail, then implement store + persistence.**

`store.ts` — `Chat` gains `agent: string | null` (after `effort`); `ModalKind` becomes `'model' | 'stats' | 'workspace' | 'agent' | null`; state gains:

```ts
  agents: Record<string, ProviderAgents> // discovery results per provider (session cache; not persisted)
  nacAgents: NacAgent[] // NAC-authored agents (persisted; synced to harness dirs via agents:sync)
  lastSyncReport: SyncReportEntry[] | null
```

initial values `agents: {}`, `nacAgents: []`, `lastSyncReport: null`; new-chat creation (~:350 area) adds `agent: null`; actions (following `setEffort`'s exact shape at :390):

```ts
  setAgent: (name) =>
    set((s) => {
      const chat = s.chats[s.activeChatId]
      if (!chat) return {}
      return { chats: { ...s.chats, [s.activeChatId]: { ...chat, agent: name } } }
    }),
  loadAgents: async (provider, refresh) => {
    const ws = get().workspaces.find((w) => w.id === get().chats[get().activeChatId]?.workspaceId)
    const r = await window.nac.agents.get(provider, ws?.path || undefined, refresh)
    set((s) => ({ agents: { ...s.agents, [provider]: r } }))
  },
  saveNacAgent: async (a) => {
    const existing = get().nacAgents.find((x) => x.id === a.id)
    const next = existing
      ? get().nacAgents.map((x) => (x.id === a.id ? { ...a, rev: x.rev + 1 } : x))
      : [...get().nacAgents, { ...a, rev: 1 }]
    set({ nacAgents: next })
    const report = await window.nac.agents.sync(next)
    set({ lastSyncReport: report })
    void get().loadAgents(get().chats[get().activeChatId]?.provider ?? 'claude', true)
  },
  deleteNacAgent: async (id) => {
    const next = get().nacAgents.filter((x) => x.id !== id)
    set({ nacAgents: next })
    const report = await window.nac.agents.sync(next) // sync prunes the marker files
    set({ lastSyncReport: report })
    void get().loadAgents(get().chats[get().activeChatId]?.provider ?? 'claude', true)
  }
```

(add matching signatures to the store's type block; `ProviderAgents/NacAgent/SyncReportEntry` imported from `../../../shared/agents` — match the path style of the existing `shared/runtime` imports in this file.)

`persist.ts` — `PersistedState` gains `nacAgents?: NacAgent[]`; `normalizeChat` return gains `agent: typeof c.agent === 'string' ? c.agent : null` (NOTE: replaces the current silent drop — legacy pre-NFP fake values may resurface as strings; the send-path validation in step 3 makes them harmless: they're omitted unless discovered); hydrate block filters like userConfigs:

```ts
      const nacAgents = Array.isArray(loaded.nacAgents)
        ? loaded.nacAgents.filter((a) => a && typeof a.id === 'string' && typeof a.name === 'string' && typeof a.prompt === 'string' && typeof a.rev === 'number')
        : useApp.getState().nacAgents
```

…included in the `useApp.setState({...})` and in the save snapshot (`nacAgents: s.nacAgents`).

- [ ] **Step 3: Send-path validation** in `store/runtime.ts` beside the effort validation (~:141):

```ts
    // Send-time agent validation (mirrors effort): only claude/opencode take an agent, and if the
    // discovery slice for the provider is loaded, the value must name a selectable discovered agent —
    // a stale/legacy value is omitted rather than sent to the harness.
    const providerAgents = s.agents[chat.provider]
    const agentOk =
      (chat.provider === 'claude' || chat.provider === 'opencode') &&
      chat.agent &&
      (!providerAgents || providerAgents.agents.some((a) => a.id === chat.agent && a.selectable))
```

and in the `runs.start` call: `agent: agentOk ? chat.agent! : undefined,` (after `fast`).

- [ ] **Step 4: AgentModal + chip + mount.**

`src/renderer/src/components/AgentModal.tsx` (new — follow ModelModal's overlay/card visual idioms; read it first and reuse its container styles):

```tsx
import { useEffect, useState } from 'react'
import { useApp } from '../store/store'
import { slugify, type DiscoveredAgent, type NacAgent } from '../../../shared/agents'

const GROUP_LABEL: Record<DiscoveredAgent['source'], string> = {
  nac: 'NAC-managed', user: 'Yours', project: 'Project', plugin: 'Plugins', builtin: 'Built-in'
}
const GROUP_ORDER: DiscoveredAgent['source'][] = ['nac', 'user', 'project', 'plugin', 'builtin']

export default function AgentModal(): React.JSX.Element {
  const { chats, activeChatId, agents, nacAgents, lastSyncReport, openModal, setAgent, loadAgents, saveNacAgent, deleteNacAgent } = useApp()
  const active = chats[activeChatId]
  const provider = active?.provider ?? 'claude'
  const pa = agents[provider]
  const [editing, setEditing] = useState<NacAgent | null>(null)

  useEffect(() => {
    void loadAgents(provider)
  }, [provider, loadAgents])

  if (!active) return <></>

  const pick = (name: string | null): void => {
    setAgent(name)
    openModal(null)
  }

  const groups = GROUP_ORDER.map((src) => ({ src, items: (pa?.agents ?? []).filter((a) => a.source === src) })).filter((g) => g.items.length)

  return (
    <div onClick={() => openModal(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 460, maxHeight: '70vh', overflowY: 'auto', background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, padding: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <strong>Agent — {provider}</strong>
          <span style={{ cursor: 'pointer', color: 'var(--muted)' }} onClick={() => void loadAgents(provider, true)}>refresh</span>
        </div>
        {pa?.support === 'none' ? (
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>{pa.note}</div>
        ) : (
          <>
            <div onClick={() => pick(null)} style={{ padding: '7px 9px', borderRadius: 6, cursor: 'pointer', background: active.agent === null ? 'var(--accent-dim, rgba(124,108,240,0.15))' : 'transparent' }}>
              No agent <span style={{ color: 'var(--muted)', fontSize: 12 }}>(harness default)</span>
            </div>
            {groups.map((g) => (
              <div key={g.src} style={{ marginTop: 10 }}>
                <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{GROUP_LABEL[g.src]}</div>
                {g.items.map((a) => {
                  const nacEntry = g.src === 'nac' ? nacAgents.find((n) => slugify(n.name) === a.id) : undefined
                  return (
                    <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', borderRadius: 6, cursor: a.selectable ? 'pointer' : 'default', opacity: a.selectable ? 1 : 0.5, background: active.agent === a.id ? 'var(--accent-dim, rgba(124,108,240,0.15))' : 'transparent' }} onClick={() => a.selectable && pick(a.id)}>
                      <span style={{ flex: 1 }}>
                        {a.name}
                        {a.description && <span style={{ color: 'var(--muted)', fontSize: 12 }}> — {a.description}</span>}
                      </span>
                      {nacEntry && (
                        <>
                          <span style={{ fontSize: 12, color: 'var(--muted)', cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); setEditing(nacEntry) }}>edit</span>
                          <span style={{ fontSize: 12, color: 'var(--warning)', cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); void deleteNacAgent(nacEntry.id) }}>delete</span>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
            {pa?.note && <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>{pa.note}</div>}
          </>
        )}
        <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          {editing ? (
            <AgentForm agent={editing} onSave={(a) => { void saveNacAgent(a); setEditing(null) }} onCancel={() => setEditing(null)} />
          ) : (
            <span style={{ cursor: 'pointer', color: 'var(--accent)' }} onClick={() => setEditing({ id: `u_ag_${Date.now()}`, name: '', description: '', prompt: '', rev: 0 })}>
              + New agent…
            </span>
          )}
          {lastSyncReport && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>
              {lastSyncReport.map((r, i) => (
                <div key={i} style={{ color: r.action === 'conflict' || r.action === 'error' ? 'var(--warning)' : 'var(--muted)' }}>
                  {r.provider}: {r.action}{r.detail ? ` — ${r.detail}` : ''}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function AgentForm({ agent, onSave, onCancel }: { agent: NacAgent; onSave: (a: NacAgent) => void; onCancel: () => void }): React.JSX.Element {
  const [a, setA] = useState(agent)
  const input = { width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '6px 8px', fontSize: 13, marginBottom: 6 } as const
  return (
    <div>
      <input style={input} placeholder="Name" value={a.name} onChange={(e) => setA({ ...a, name: e.target.value })} />
      <input style={input} placeholder="Description" value={a.description} onChange={(e) => setA({ ...a, description: e.target.value })} />
      <textarea style={{ ...input, resize: 'vertical' }} rows={4} placeholder="System prompt" value={a.prompt} onChange={(e) => setA({ ...a, prompt: e.target.value })} />
      <div style={{ display: 'flex', gap: 10 }}>
        <span style={{ cursor: 'pointer', color: 'var(--accent)', opacity: a.name.trim() && a.prompt.trim() ? 1 : 0.4 }} onClick={() => a.name.trim() && a.prompt.trim() && onSave(a)}>Save + sync</span>
        <span style={{ cursor: 'pointer', color: 'var(--muted)' }} onClick={onCancel}>Cancel</span>
      </div>
    </div>
  )
}
```

`ChatView.tsx` — after the effort chip (~:211), add:

```tsx
              <span style={toolbarItem} onClick={() => openModal('agent')}>
                Agent: {active.agent ?? 'none'}
              </span>
```

`Shell.tsx` — `import AgentModal from './AgentModal'` and add `{modal === 'agent' && <AgentModal />}` beside the other mounts (:59-61).

- [ ] **Step 5: Run everything:** `npx vitest run` + `npm run typecheck` + `npm run build` — green.

- [ ] **Step 6: Commit:**

```bash
git add src/renderer/src src/shared/agents.ts
git commit -m "feat(agents): AgentModal + composer chip + nacAgents persistence + send-path validation"
```

---

### Task 6: Live verification (controller, computer use) + docs + final review

**Files:**
- Modify: `docs/DECISIONS.md`, `docs/README.md` (if it indexes specs)

- [ ] **Step 1: Gate** — `npm run typecheck && npx vitest run && npm run build`.
- [ ] **Step 2: Live matrix** (controller drives; app restart required — main-process changes don't hot-reload; quit other dev instances first per the shared-state rule):
  1. AgentModal on claude lists real filesystem agents (plugins group present on this machine); codex shows the honest none-note; copilot shows synced agents disabled + note.
  2. Author a NAC agent "Probe" with prompt `Always begin every reply with the exact token AGENTPROBE:` → Save + sync → report shows 3× written → files exist with markers (`grep -l "managed-by: nac-code" ~/.claude/agents/probe.md ~/.copilot/agents/probe.agent.md ~/.config/opencode/agent/probe.md`).
  3. claude chat, agent=probe: send "say hello" → reply begins `AGENTPROBE:`. Mid-chat switch probe→none: respawn-with-resume (context intact — plant + recall a codeword across the switch).
  4. opencode chat, agent=probe (or `plan` if the Task-1 spike recorded `CUSTOM_PRIMARY_VISIBLE: no`): behavior-proving turn (AGENTPROBE token, or for `plan`: an edit request is refused/planned-not-executed).
  5. Conflict: `echo 'hand' > ~/.claude/agents/probe.md` (strip frontmatter) → edit the NAC agent → report shows claude `conflict`, file still says `hand`. Restore by deleting the hand file + re-sync.
  6. Delete the NAC agent → three files pruned; a hand-made unmarked file in the same dir survives.
- [ ] **Step 3: DECISIONS.md** — Current-phase entry (include the spike verdict + honest per-provider support map + what was live-verified) and add the agent picker line item where the NFP note pointed to it. Commit docs.
- [ ] **Step 4: Final whole-branch review** (most capable model) with `review-package MERGE_BASE HEAD`; one fix subagent for findings; re-review; then `superpowers:finishing-a-development-branch`.
