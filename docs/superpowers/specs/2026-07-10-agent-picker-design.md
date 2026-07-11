# Agent picker — harness-native discovery + NAC-authored sync — Design

**Date:** 2026-07-10
**Status:** Approved (approach A — per-provider discovery pillar mirroring M4, plus a NAC→harness sync engine)
**Scope decision:** Agents are **harness-native**: NAC discovers and selects each harness's own agents, and NAC-authored agents are synced INTO each harness's native on-disk format (one-way NAC→harness; existing harness-authored agents are discovered + selectable but read-only in NAC). Copilot's custom agents sync but are not selectable in-app (honest badge — its ACP surface doesn't expose `--agent`). Codex is an honest "none". DEFERRED: bidirectional adopt-into-NAC, per-harness model/tool pinning on NAC agents, workspace default agent + new-chat inheritance, copilot/claude session-mode surfaces (plan/autopilot), remote/org copilot agents.

## Goal

Restore the agent surface the no-fake-pixels sweep removed (`9ec2235`) — as a real capability: a provider-honest picker that lists each harness's actual agents, runs turns under a selected agent on claude + opencode, and lets the owner author an agent once in NAC and have it appear natively in claude, copilot, and opencode.

## Probe findings driving this spec (2026-07-10, live against installed binaries)

| | claude 2.1.181 | codex 0.142.3 | copilot 1.0.70 | opencode 1.17.11 |
|---|---|---|---|---|
| Concept | custom agents: `~/.claude/agents/*.md`, `<project>/.claude/agents/*.md`, plugin `agents/*.md`; frontmatter `name/description/tools/model` + prompt body; also inline `--agents <json>` | **none** — `-p/--profile` layers `$CODEX_HOME/<name>.config.toml` over base config (config preset, not a persona); `AGENTS.md` only | custom agents: `<repo>/.github/agents/*.agent.md` + `~/.copilot/agents/*.agent.md`; builtin `.agent.yaml` subagents ship inside the CLI | agents with `mode: primary\|subagent`; builtins `build`/`plan` (user-facing primaries), `compaction`/`summary`/`title` (internal primaries), `explore`/`general` (subagents); customs in `~/.config/opencode/agent/*.md` / project `.opencode/agent/` |
| Enumeration | **filesystem only** (`claude agents` lists running sessions, not types) | n/a | **filesystem only** (no list command; internal `agents.discover` RPC is not on the public ACP surface) | `opencode agent list` (programmatic) |
| Selection via NAC's transport | `--agent <name>` (+ `--agents <json>` inline) — global spawn-time flags, stream-json-safe; **live-verified headless** (marker agent echoed its token) | n/a | **`--agent` is CLI-only, NOT exposed over ACP** — `session/new` advertises only session modes (agent/plan/autopilot) | ACP `session/new` `configOptions` includes `{id: "mode", options: [build, plan]}` — the same `set_config` mechanism pillar 4 uses for `model`; internal primaries are filtered out of the options |

**Unverified assumption (early spike, Task 1 of the plan):** a custom `mode: primary` opencode agent appears as an ACP `mode` option (only builtins were observed; internals are filtered, so custom visibility is unproven). If false, opencode selection degrades to builtins-only and this spec's opencode-sync value drops to CLI-side use — record the outcome in DECISIONS.

## Design

### 1. Shared types (`src/shared/agents.ts` — new)

```ts
export interface DiscoveredAgent {
  id: string                   // provider-unique: slug/name as the harness knows it
  name: string
  description?: string
  source: 'user' | 'project' | 'plugin' | 'builtin' | 'nac'  // 'nac' = carries the managed-by marker
  selectable: boolean          // false for all copilot agents (ACP gap)
}
export interface ProviderAgents {
  provider: ProviderId
  support: 'full' | 'sync-only' | 'none'
  agents: DiscoveredAgent[]
  note?: string                // the honest badge text
  fetchedAt: number
}
export interface NacAgent {     // persisted in nac-state (renderer store)
  id: string                    // u_ag_<ts>_<n>
  name: string                  // display name; slug derived for filenames
  description: string
  prompt: string                // the system-prompt body
  rev: number                   // bumps on edit (context-library pattern)
}
export const AGENTS_CHANNELS = { get: 'agents:get', sync: 'agents:sync' }
```

Support map: claude/opencode `full`; copilot `sync-only`, note "Copilot CLI doesn't expose agent selection to integrations — synced agents work in copilot's own CLI"; codex `none`, note "Codex has no agent concept (profiles are config presets)".

### 2. Discovery (`src/main/runtime/agents/` — new, mirrors `capabilities/`)

- `claude.ts` — scan `~/.claude/agents/*.md`, `<workspaceCwd>/.claude/agents/*.md`, and `~/.claude/plugins/**/agents/*.md` (plugin agents, `source: 'plugin'`); parse frontmatter `name`/`description` with a small tolerant parser (no YAML dep — key: value lines between `---` fences, the same shape everywhere). Files carrying the NAC marker report `source: 'nac'`. Missing dirs → empty, never throws.
- `copilot.ts` — scan `<workspaceCwd>/.github/agents/*.agent.md` + `~/.copilot/agents/*.agent.md`; all `selectable: false`.
- `opencode.ts` — run `opencode agent list` (3s timeout, `stdio: ['ignore','pipe','ignore']`); parse `name (primary|subagent)` lines; keep primaries, drop the internal set `{compaction, summary, title}` and all subagents; on any failure fall back to scanning `~/.config/opencode/agent/*.md` + `<workspaceCwd>/.opencode/agent/*.md`, else builtins `build`/`plan` static floor.
- `codex.ts` — static `{support: 'none', agents: []}`.
- `index.ts` dispatcher — per-provider promise cache + `getAgents(provider, cwd, refresh)`, `invalidateAgents(provider)`; degradation never rejects (worst case: static floor / empty list with `support` intact).
- IPC: `ipcMain.handle(AGENTS_CHANNELS.get, (_e, provider, cwd, refresh) => ...)` in `ipc.ts`; preload bridge `nac.agents.get/sync`.

### 3. Sync engine (`src/main/runtime/agents/sync.ts` — new)

One NAC agent renders to three native files (pure render functions, unit-tested):

- claude `~/.claude/agents/<slug>.md`:
  ```markdown
  ---
  name: <slug>
  description: <description>
  managed-by: nac-code
  nac-rev: <rev>
  ---
  <prompt>
  ```
- copilot `~/.copilot/agents/<slug>.agent.md` — same frontmatter shape (`managed-by`/`nac-rev` included; copilot ignores unknown keys).
- opencode `~/.config/opencode/agent/<slug>.md` — frontmatter adds `mode: primary` (required for ACP mode visibility per the spike).

Rules (`syncAgents(nacAgents): SyncReport`):
- **Only marker-bearing files are ever created, updated, or deleted.** A path collision with a file lacking `managed-by: nac-code` → `conflict` (file untouched, reported).
- Delete of a NAC agent removes its marker-bearing files everywhere; a marker file whose id no longer exists in NAC state is pruned (that's what the marker is for).
- Idempotent: unchanged rev → `skipped`. Report shape: `{provider, agentId, action: 'written'|'skipped'|'conflict'|'error', detail?}` per target.
- Runs on NAC-agent save/delete and via an explicit "Sync now"; `agents:sync` IPC takes the current `NacAgent[]` and returns the report; after sync, discovery caches invalidate.

### 4. Run threading (mirrors model/effort exactly)

- `Chat.agent: string | null` returns to the store; hydration keeps it only when it names a currently-discoverable agent for the chat's provider (tolerant, like dead-attachedIds filtering; discovery result is available via the store's agents slice at hydrate-validate time — if the slice isn't loaded yet, keep the value and let the picker/send path re-validate).
- `RunRequest.agent?: string` (`src/shared/runtime.ts`); populated in `store/runtime.ts` beside model/effort.
- **claude:** `claudeSessionArgs` appends `--agent <name>`; `needsRespawn` learns agent-change (respawn-with-resume, same as model change); one-shot `claudeArgs` fallback gets `--agent` too.
- **opencode:** before the turn, `set_config` on configId `mode` (the pillar-4 model-switch plumbing, including its fail-open handling — a rejected mode proceeds on the harness's current mode and marks the run `modeMismatch` in the completion event, so the ledger/UI stay honest).
- **copilot/codex:** `agent` never reaches them (UI never offers selection).

### 5. UI

- **Composer chip** in `ChatView.tsx`'s toolbar (beside the model chip): shows `active.agent ?? 'No agent'`; opens `AgentModal` (new `ModalKind 'agent'`, mounted in `Shell.tsx`).
- **`AgentModal.tsx`** (new): agents for the **active provider**, grouped by source (NAC / yours / project / built-in) with source labels; "No agent" default row; `support: 'sync-only'` renders the list disabled with the note; `support: 'none'` renders the note alone. Refresh button → `agents.get(provider, cwd, true)`.
- **Authoring:** "New agent…" opens a form (name, description, prompt); Save persists the `NacAgent`, bumps rev, triggers sync, shows the per-harness sync report inline (written ✓ / conflict ⚠ with detail). Edit/Delete available only for `source: 'nac'` entries.
- Store: `agents: Record<ProviderId, ProviderAgents>` slice + `loadAgents(provider, refresh)`, `nacAgents: NacAgent[]` persisted, `setAgent(chatId, name|null)`.
- v1 omits workspace default agent + new-chat inheritance (deferred).

### 6. Error handling

- Discovery never throws; every failure degrades to a floor with `support` intact so the UI stays honest rather than empty.
- Sync failures are per-file and reported, never thrown; a conflict never overwrites foreign files.
- A selected agent that disappears from disk before a send: claude spawn fails → existing run-error path surfaces the harness's own error inline; the picker re-validates on open.

### 7. Testing

- Pure units: frontmatter parser (fences, missing keys, marker detection), `opencode agent list` parser (primaries/internals/subagents), the three render functions, conflict/prune logic, `needsRespawn` agent-change, hydration tolerance for `Chat.agent`.
- Strategies tested with injected fs/exec seams (M4 pattern); dispatcher degradation ladder.
- **Live matrix (final task, computer use if granted; headless equivalents otherwise):**
  1. **Spike (FIRST implementation task):** create a scratch `mode: primary` custom opencode agent → confirm it appears in ACP `session/new` `configOptions.mode` options; record outcome in DECISIONS (branch: if invisible, opencode selection = builtins-only).
  2. Author a NAC agent with a marker instruction ("start every reply with AGENTPROBE:") → sync → files exist in all three dirs with markers → claude chat with it selected echoes the token; opencode chat switched to it via mode echoes it.
  3. Mid-chat agent switch on claude respawns with `--resume` (context intact — codeword recall).
  4. Conflict: hand-authored file at a colliding path is untouched, report shows `conflict`.
  5. Copilot page shows the synced agents + disabled state + note; codex page shows the honest none-note.
  6. Delete the NAC agent → marker files pruned everywhere, foreign files untouched.

## Non-goals

Bidirectional adopt (harness→NAC import). Per-harness model/tool pinning on NAC agents. Workspace default agent / new-chat inheritance. Copilot/claude session-mode pickers (plan/autopilot — a separate "modes" feature if wanted). Copilot remote/org agents and extensions. Codex profiles as pseudo-agents.
