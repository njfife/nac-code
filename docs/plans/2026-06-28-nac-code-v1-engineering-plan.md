# NAC Code — v1 Master Engineering Plan

> **Status:** Master/program plan. This locks scope, architecture, and sequencing, and schedules spec-closure. Each subsystem below gets its own bite-sized TDD implementation plan (via the writing-plans skill) once it reaches the front of the queue. Do **not** start coding subsystems M1+ before Milestone 0 closes the spec gaps it owns.

**Goal:** Build a desktop, IDE-style GUI harness for coding agents — workspace-grouped chats, per-chat configuration, a managed static-context library, multi-provider model selection (delegated to installed CLIs), and visibility into the agent's work and cost — shipping a *real working harness* with durable persistence in v1.

**Architecture:** A React/TypeScript front end (the Electron renderer) renders the high-fidelity UI and owns the per-chat state spine; the Electron main process (Node.js/TypeScript) provides the privileged seams — agent-runtime orchestration over installed CLIs, durable persistence, OS integration, and CLI discovery/auth. All OS- and integration-specific behavior sits behind narrow interfaces so platforms and not-yet-real integrations (git, cost) are additive, not structural.

**Tech Stack (decided):** Electron + React 18 + TypeScript + Vite (electron-vite); single language (TS) across main and renderer; persistence via SQLite (better-sqlite3) in the main process; state via a typed store (Zustand or Redux Toolkit — decide in M1); packaging via electron-builder; IBM Plex Sans/Mono + Newsreader (PRD doc only) from Google Fonts. *Electron chosen for pixel-identical cross-OS rendering (bundled Chromium) and single-language TS; the cost is a heavier runtime and mandatory security hardening (see Global Constraints).*

---

## Global Constraints

- **Per-chat state is the spine (FR-4.1):** model, provider, agent, attached context, active configuration, dirty flag, and context-window/compaction state belong to the individual chat. **No configuration is global.** Every feature reads/writes the chat object; a leak to global state is a defect.
- **Durable persistence is in v1 (decision):** chats, workspaces, branches, saved configurations, and full per-chat state survive app restart. (Promotes roadmap FR-4.3 into v1/P0.)
- **Context preservation is an invariant, not a feature (hard requirement):** the displayed conversation and the agent's actual working context must always derive from the *same* persisted source of truth. NAC Code owns a canonical, provider-neutral **transcript** per chat (messages, tool calls, tool results, attachments, system/instruction context); resuming a chat must reconstruct the agent's context from it so the agent genuinely "remembers" prior turns. A harness's own native session is an optimization layered on top — never the source of truth. This must hold for **every** harness — including local models (always driven through a carrier harness; NAC Code never connects to a raw endpoint), where the transcript is replayed into the active harness via `buildContext`. **Provider switching preserves context (super-hard requirement):** the user can change provider/model — including to/from a local LM Studio model — *within or across* a conversation and the full context carries over. Since **no native session is portable across providers**, provider-neutral transcript replay is the PRIMARY mechanism; native-session resume is only a *same-provider* fast-path optimization. See M0-8. *(Avoids the observed t3code defect — restored display over an empty agent context — and goes beyond t3code, which welds a thread to one provider and cannot switch providers mid-conversation.)*
- **Every model is reached through an agentic harness — NAC Code is a wrapper, never a harness (decision):** the app orchestrates installed harness CLI subprocesses (Claude Code, Codex, Cursor, OpenCode); the CLIs own their auth and agent loop. NAC Code **never connects to a raw model endpoint and never implements an agent loop.** **Local models (LM Studio / Ollama) are used only *through* a carrier harness** that supports custom backends, and NAC Code **auto-configures** that carrier (OpenCode is the v1 carrier; pi.dev deferred — it IS agentic but doesn't speak ACP (custom JSONL RPC), so it needs a bespoke adapter; see `docs/research/carrier-harnesses.md`) — so "use local model X" transparently provisions the carrier pointed at the local endpoint and wraps it like any other harness. In-app API-key storage is **out of v1 scope** (FR-7.3 → fallback/roadmap); the inspector's CLI Connections + re-auth (FR-15) is the primary auth surface.
- **Real agent execution is in v1 (decision):** the agent genuinely runs against models/tools — this is not a UI-only shell.
- **Git review and cost are v1 stubs (decision):** the Changes view binds to a `GitReader` that returns demo/illustrative data; cost figures are illustrative constants from a `CostCollector` stub. Both sit behind real interfaces so the live implementations (roadmap FR-12.9, FR-13.2) drop in without UI change. **This must be relabeled honestly in the PRD (see Doc-Cleanup batch) — these surfaces are not production-wired in v1.**
- **Cross-platform:** target macOS + Linux for v1; Windows is a deferred, additive decision. All OS integration goes through one `PlatformServices` interface so Windows is a later implementation of the same contract, not a rewrite.
- **Minimum window width 1180px** with horizontal scroll below it; panes never collapse or overlap (FR-1.5 / NFR-4).
- **Design tokens are exact:** colors, type, spacing, and panel dimensions per `design_handoff_nac_code/README.md` "Design Tokens" (verified to match the prototype CSS). Dark theme only.
- **Security/execution-safety NFR (new):** subprocess execution is the trust boundary. The autonomy ("YOLO") policy gates which agent tool/command actions run unattended; this is per-chat and has a safe default (see M0-2). **Electron hardening is mandatory:** the renderer runs with `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`; it reaches privileged main-process functions only through a typed, allowlisted preload bridge — never direct Node access. Disable navigation to remote origins; load only local content.

---

## 1 · v1 Scope Lock (status taxonomy)

The PRD's single "Implemented" label conflates "the mock shows it" with "v1 ships it." Replace it with four statuses. Only the consequential/ambiguous requirements are listed; everything not called out as **stub** or **roadmap** is **V1-real**.

| Status | Meaning |
|---|---|
| **V1-real** | Production-wired behavior ships in v1 |
| **V1-stub** | Surface ships in v1 backed by mock/illustrative data behind a real interface |
| **Roadmap** | Deferred past v1 |

**Decisions that move requirements off the default:**

- **V1-real (promoted):** FR-4.3 durable persistence (was roadmap) → **V1-real, P0**.
- **V1-stub:**
  - FR-12.1/12.2/12.3/12.5/12.6 **Changes view + diff/source viewer** → ship reading from `GitReader` **stub** (demo data). Real working-tree read is **roadmap** (subset of FR-12.9).
  - FR-12.4 **Launch repo in IDE** and FR-12.7 **Reveal in Finder/editor** → **V1-real** via `PlatformServices` (these are cheap OS calls and worth shipping real), but note FR-12.7's per-file open-in-editor / reveal-folder actions are *absent from the prototype* and must be specified.
  - FR-10.4 / FR-11.5 / FR-13.1 **cost** → **V1-stub** (illustrative; provider-aware unit shape is real, numbers are not). Live metering FR-13.2 = **roadmap**.
  - FR-10.3 **MCP servers** → **V1-stub** (empty-state placeholder, as today). FR-10.10 = **roadmap**.
  - FR-5.6 **scope** → **V1-stub** (display-only). FR-5.10 enforcement = **roadmap**.
  - FR-7.3 **in-app API-key connect** → **V1-stub/fallback** (CLI delegation is primary). Real secret storage = **roadmap**.
- **Roadmap (unchanged):** FR-6.7, FR-5.9, FR-5.10, FR-10.10, FR-12.9, FR-13.2.

**Action:** encode this taxonomy back into the PRD as a per-requirement field (Doc-Cleanup batch, below).

---

## 2 · Target Architecture & Interface Contracts

Two processes: the **Renderer** (React/TS, the UI) and the **Core** (the Electron main process — Node/TS, privileged). They communicate over Electron IPC (`ipcMain`/`ipcRenderer`) through the allowlisted preload bridge, plus an event channel for streaming. Every integration that is OS-specific, not-yet-real, or external lives behind one of these interfaces. These signatures are the **Produces** contracts the per-subsystem plans consume — keep them stable.

```typescript
// ---- The spine: per-chat state (UI-owned, persisted by Core) ----
interface Chat {
  id: string;
  workspaceId: string;
  title: string;
  createdAt: number; updatedAt: number;
  provider: string;          // provider id
  model: string;             // model id
  agent: string | null;      // selected AgentDefinition id (see ContextStore)
  activeConfig: string | null; // Configuration id, or null
  attached: AttachedSet;     // { skill: id[], agent: id[], instruction: id[], file: id[] }
  dirty: boolean;            // attachments diverge from activeConfig
  thinking: ThinkingLevel;   // 'none'|'low'|'medium'|'high'
  yolo: boolean;             // autonomy policy (per-chat — NOT global)
  contextK: number;          // current context-window tokens used
  windowK: number;           // model's context window (derived from model, not hardcoded 128k)
  compacting: boolean;
  compacted: boolean;
  branchedFrom: string | null; // parent chat id (stable id, NOT a title string)
}
type ThinkingLevel = 'none' | 'low' | 'medium' | 'high';
interface AttachedSet { skill: string[]; agent: string[]; instruction: string[]; file: string[]; }

// ---- Persistence (Core) — backs the durable-persistence decision ----
interface PersistenceStore {
  loadAll(): Promise<{ workspaces: Workspace[]; chats: Chat[]; configs: Configuration[] }>;
  upsertChat(chat: Chat): Promise<void>;
  deleteChat(id: string): Promise<void>;
  upsertWorkspace(ws: Workspace): Promise<void>;
  upsertConfig(cfg: Configuration): Promise<void>;
  // schema-versioned; migrations run on open
}

// ---- Agent runtime (Core) — THE core seam, spec-closed in M0 ----
// Pattern validated against t3code: per-provider ADAPTERS implement ONE shared interface and emit ONE
// canonical event union (AgentEvent). Integrate at each provider's STRUCTURED protocol — ACP (Agent
// Client Protocol) where supported (Cursor, Gemini, others), else the provider's app-server/SDK JSON-RPC
// (Codex app-server, Claude SDK) — NOT by scraping human stdout. Transport is FULL-DUPLEX: the agent
// calls back into the host for tool approvals / fs reads-writes / terminal.
interface AgentRuntime {
  // Assembles request (agent + instructions + attached files/skills + history + thinking + autonomy).
  start(req: RunRequest): RunHandle;          // returns immediately; streams AgentEvents
  cancel(runId: string): Promise<void>;
  respondToRequest(runId: string, requestId: string, r: ApprovalDecision | { input: unknown }): Promise<void>; // answers agent-initiated requests (approval, user-input)
  buildContext(transcript: Transcript, target: { provider: string; model: string; windowTokens: number }): ProviderInput; // UNIVERSAL: provider-neutral transcript -> target provider's input; this is what survives a provider switch
  capabilities(provider: string): { nativeResume: boolean; transport: 'acp' | 'app-server' | 'sdk' }; // every provider is an agentic harness (incl. local via a carrier); nativeResume = same-provider fast-path; buildContext replay is ALWAYS the cross-provider path
}
type ApprovalDecision = 'allow-once' | 'allow-session' | 'deny' | 'cancel';
interface RunRequest {
  chatId: string; provider: string; model: string; agent: string | null;
  instructions: string[]; skills: string[]; files: string[];
  history: Message[]; prompt: string; thinking: ThinkingLevel; yolo: boolean;
}
// AgentEvent = ONE versioned tagged union all adapters normalize into: content deltas (assistant text +
// reasoning), generic tool/item lifecycle (started|updated|completed) with a canonical item-type enum +
// opaque data, request.opened/resolved (approvals/user-input), usage, run lifecycle, error. Each event
// carries { provider, instanceId, sessionId, raw?: { source, payload } } for provenance/passthrough.
// Defined in the shared `contracts` schema package (Zod). Finalized in M0-1.

// ---- CLI registry / connections (Core) — harness delegation + carrier auto-config + FR-15 ----
// Provider model (from t3code): split DRIVER (a harness impl: 'codex'|'claude'|'cursor'|'opencode'|'pi')
// from INSTANCE (a user config of a driver: 'claude-work' vs 'claude-personal'). BOTH are OPEN string slugs,
// never closed unions — persisted state must never fail to parse on an unknown driver (registry marks it
// 'unavailable'). Adding a new harness needs no schema migration.
// LOCAL MODELS are NOT drivers — they are backends reached THROUGH a carrier harness (OpenCode in v1; pi deferred) that
// NAC Code auto-configures to point at the local endpoint.
interface CliRegistry {
  discover(): Promise<ProviderInstance[]>;                 // detect installed harnesses + configured instances + auth/health
  reauth(instanceId: string): Promise<ProviderInstance>;  // FR-15.2
  // Carrier auto-config: provision a carrier harness to drive a local backend, then expose it as a normal
  // ProviderInstance. NAC Code writes the carrier's provider config; it does NOT build an agent loop.
  configureLocalBackend(carrier: 'opencode' /* v1: opencode only; pi deferred — agentic but non-ACP, needs a bespoke adapter */, backend: { endpoint: string; model: string; kind: 'lmstudio' | 'ollama' | 'openai-compatible' }): Promise<ProviderInstance>;
}
interface ProviderInstance { instanceId: string; driver: string; displayName: string;
  binaryPath?: string; homePath?: string; env?: Record<string, string>; // per-instance config (multi-account / router)
  status: 'authenticated'|'expired'|'not-authenticated'|'not-installed'; }
// NOTE: env may carry sensitive routing tokens (e.g. ANTHROPIC_AUTH_TOKEN for OpenRouter) → these need a
// write-only secret store even though primary auth is CLI-delegated (tempers the "secrets out of v1 scope" line).

// ---- Context library (Core-backed, UI-cached) ----
interface ContextStore {
  list(): Promise<ContextItem[]>;
  estimateTokens(item: ContextItem): number;         // tokenizer/heuristic — decided M0-3
  listConfigurations(): Promise<Configuration[]>;
  saveConfiguration(cfg: Configuration): Promise<void>;
}
interface ContextItem { id: string; type: 'skill'|'agent'|'instruction'|'file';
  name: string; description: string; tokens: number; scope: 'workspace'|'global'; tags: string[];
  source: string; }
interface Configuration { id: string; name: string; description: string; itemIds: string[]; }
// AgentDefinition is the agent-typed ContextItem; Chat.agent references its id (one id namespace).

// ---- OS integration (Core) — per-OS impls; mac+linux in v1 ----
interface PlatformServices {
  launchIde(kind: 'intellij'|'vscode', repoPath: string): Promise<void>; // FR-12.4
  revealInFileManager(path: string): Promise<void>;                       // FR-12.7
  openInEditor(path: string): Promise<void>;                              // FR-12.7
}

// ---- v1 STUBS behind real interfaces ----
interface GitReader {        // V1-stub: returns demo data; roadmap FR-12.9 = real working-tree read
  changedRepos(): Promise<Repository[]>;            // Repository has ChangedFile[]
}
interface CostCollector {    // V1-stub: illustrative; roadmap FR-13.2 = live metering
  // A chat can span multiple providers (cross-provider switching), so cost is a PER-PROVIDER breakdown,
  // never one figure — and is NOT summable across units ($ + credits + free). Usage is attributed per
  // turn by the provider that handled it. QoL/lower-priority for v1 (numbers are illustrative), but fix
  // the SHAPE now so live metering (FR-13.2) and the multi-provider UI aren't a retrofit.
  costFor(chatId: string): CostBreakdown[];   // one entry per provider used in the chat; each in its own unit
}
```

**Why these boundaries:** `GitReader`/`CostCollector` being interfaces means the stub→live swap (roadmap) touches zero UI. `PlatformServices` being one interface means Windows is an additive impl. `AgentRuntime` isolating CLI heterogeneity means each provider's quirks live in one adapter, not smeared across the UI. Define the Core API as a **transport-agnostic typed RPC surface** (ship it over Electron IPC in v1); t3code runs the identical surface over a local WebSocket, which is the single reason they get web/mobile/remote clients for free — keeping the seam transport-agnostic lets us unlock that later without a rewrite.

---

## 3 · Subsystem Decomposition → one plan each

Sequenced along the spine (FR-4.1 first). Each is an independently testable deliverable with its own bite-sized TDD plan written when it reaches the front of the queue.

| # | Subsystem | Covers (FRs) | Depends on | Spec status |
|---|---|---|---|---|
| **M0** | **Spec-closure + stack spike** | run loop, autonomy, error/empty states, new-chat seeding, file lifecycle, token estimation | — | **resolves the gaps** |
| **M1** | **Foundation & Shell** | FR-1.1–1.5, design tokens, routing | M0 | well-specified |
| **M2** | **State Spine + Persistence** | FR-2.1–2.4, FR-4.1–4.3 | M1 | well-specified |
| **M3** | **Context Library + Configurations** | FR-5.1–5.8, FR-6.1–6.6 | M2 | mostly; token-est from M0 |
| **M4** | **Providers, Agents & Connections** | FR-7.x, FR-8.x, FR-15.x | M2 | well-specified (CLI-delegated) |
| **M5** | **Conversation Surface + Agent Runtime** | FR-3.1–3.6 + the run loop | M2, M3, M4 | **needs M0** |
| **M6** | **Inspector + Stats** | FR-10.x, FR-11.x, FR-13.1 (stub) | M2, M4, M5 | well-specified |
| **M7** | **Compaction & Branching** | FR-9.1–9.3, FR-2.4 | M2, M5 | well-specified |
| **M8** | **Changes (git-stub), Palette & Polish** | FR-12.x (stub), FR-14.x, NFRs | M2, M5 | well-specified |

---

## 4 · Milestone 0 — Spec-closure & Stack Spike (do this first)

These are decisions, not code. Each ends with a written spec section appended to the PRD (or a sibling `docs/specs/` doc) so the dependent milestone can be TDD-planned without placeholders. **My recommended default is given for each — confirm or override.**

- **M0-1 · Agent run loop & event protocol.** Define request assembly (how agent + instructions + skills + files + history + thinking + autonomy combine into a provider invocation), the canonical streamed-event union, the tool-call/approval round-trip, and run-error handling. *Recommended default (validated against t3code):* integrate at each provider's **structured protocol** — **ACP (Agent Client Protocol)** where the agent supports it (generate the ACP types from the published spec; don't hand-write them), else the provider's app-server/SDK JSON-RPC (Codex app-server, Claude SDK); naive stdout-parsing is the *last-resort* transport, not the default. One adapter per provider, all implementing the shared `AgentRuntime`/adapter interface and normalizing into the single `AgentEvent` union (with a `raw` provenance envelope). Use a **two-hop** normalization (thin wire-envelope → per-provider mapper that may emit 0..n canonical events). Transport must be **full-duplex** — bridge agent-initiated approval/user-input requests to the UI via a parked promise (Deferred) keyed by requestId. **✓ Spec drafted: `docs/specs/M0-agent-runtime-and-context.md` (Part A).**
- **M0-2 · Autonomy (YOLO) & execution-safety model.** Exact set of actions gated when OFF, the approval UI when OFF, what ON bypasses, destructive-action carve-outs. Per-chat, persisted. *Recommended default:* OFF = every shell/file-write tool call requires per-call approval; ON = auto-approve non-destructive + file-writes within workspace, still prompt for out-of-workspace writes and destructive git ops. **Safe default = OFF for new chats.** Where a harness exposes a *native* approval/sandbox policy (e.g. Codex `approvalPolicy` + `sandboxMode`; cf. t3code's "Full access" vs "Supervised" runtime modes), **drive that native policy** rather than reimplementing gating. Since every model (incl. local via a carrier harness) runs inside a harness, the harness **always** owns approval/sandbox — NAC Code never builds its own gating.
- **M0-3 · Token estimation & window sizing.** Tokenizer/heuristic, estimated-vs-real labeling, what the budget includes (static context vs + history), and deriving `windowK` from the active model (not a fixed 128k). *Recommended default:* per-provider tokenizer where the CLI exposes one, else a `chars/4` estimate clearly labeled "~"; budget = attached static context + history; thresholds >76k amber / >108k red promoted from the README into FR-5.7. *Spike finding (2026-06-28, LM Studio qwen3.6-27b):* local **reasoning** models spend far more on *completion-side* reasoning tokens than on the prompt — 218–1396 reasoning tokens for a one-word answer against a ~90-token prompt — so the window budget must **reserve generous output/reasoning headroom** (not just fit the prompt), and an under-budgeted `max_tokens` returns an *empty* answer. Account for reasoning tokens explicitly when switching to a small-window local model.
- **M0-4 · New-chat seed contract.** Provider/model/agent/config a new chat inherits, landing position, initial title. *Recommended default:* inherit the **active chat's** provider/model/agent (or, if none, the first authenticated CLI's default model); apply the `Standard` configuration; insert at top of the active workspace; title = "New chat" until the first user message, then auto-derive.
- **M0-5 · Error & empty states.** compaction failure, IDE-not-installed (tie to FR-15.1 "not-installed"), CLI run failure, empty thread, empty Changes, re-auth failure. *Recommended default:* every async action has explicit loading/empty/error states; failures surface as inline state + a retry affordance and leave prior state unchanged.
- **M0-6 · File-context lifecycle.** Snapshot-at-attach vs live reference; behavior on change/delete; binary/oversized handling; re-tokenization. *Recommended default:* **live path reference** (re-read at send time), re-tokenize on send, show a "missing" badge if the file is gone, refuse binary + warn over a size cap.
- **M0-7 · Foundation spike (Electron, decided).** Scaffold Electron + React + TS (electron-vite) with hardened defaults (`contextIsolation` on, `nodeIntegration` off, `sandbox` on, allowlisted preload bridge); render one high-fidelity screen (Studio chat) on macOS + Linux; spawn a provider CLI subprocess from the main process and stream its output to the renderer over IPC; confirm `electron-builder` packaging on both OSes. *This is validation, not a decision gate:* the stack is chosen (rendering fidelity is no longer a risk — bundled Chromium renders identically across OSes). The spike must prove clean CLI subprocess streaming over IPC and packaging, and record the Windows go/no-go cost estimate.

- **M0-8 · Context preservation & cross-provider portability (super-hard requirement).** Define the canonical, **provider-neutral** per-chat transcript and the deterministic context-assembly path that lets the user (a) resume any old chat and (b) **switch provider/model mid-conversation — including to/from a local model (run via the OpenCode carrier harness) — with full context intact.** *Recommended default:* the transcript (normalized turns — user/assistant text + *portable* tool-call/result representations + attached context; each provider's native event blob kept only in `raw` for provenance) is the single source of truth for both UI render and agent context. Every adapter implements `buildContext(transcript, target)` — the **universal** path that renders the transcript into the target provider's input; this is the ONLY mechanism that survives a provider switch, so it is primary, not a fallback. Native-session resume (Codex rollout/`resume`, Claude `--resume`, ACP `session/load`) is an **optional same-provider fast-path**, used only when `provider unchanged && native session alive && matches transcript`; any switch — or a missing/expired/mismatched session — forces `buildContext` replay. Cross-provider specifics: a *foreign* provider's tool calls/results are flattened into readable context (the new provider learns *what happened* even though it didn't *do* it; its own subsequent tool calls are native); reasoning/thinking content is not replayed (optionally summarized); context is re-tokenized against the **target** provider's window (M0-3) and compacted (FR-9) when switching to a smaller-window local model. Also settle the UX: is a switch *in-place* on the same chat, or a *branch* into a new chat that inherits the transcript? (Same core machinery either way.) **Executable acceptance tests (in CI):** (1) *resume* — open a chat with ≥2 prior turns, ask "what was the first thing I asked you?"; the agent references the real first message, for Codex, Claude, Cursor, OpenCode, and a local model via a carrier harness; (2) *switch* — start on provider A, take ≥2 turns, **switch to provider B (incl. to/from a local-model-via-carrier-harness), ask the same question — B answers correctly.** *t3code cautionary tale:* it welds a thread to one provider's native session/home and cannot switch providers mid-thread (its docs admit you usually can't even switch Claude *accounts*); making the provider's session the source of truth is the exact mistake we avoid. **✓ Validated (spike, 2026-06-28):** the text-turn case passed end-to-end — captured 2 Claude turns into the neutral transcript, replayed via `buildContext` so a local model (LM Studio qwen3.6-27b) recalled the first-message codeword across the switch; the negative control (no replay) did NOT, reproducing the t3code bug. (`spikes/cross-provider-portability/`.) *Note:* that spike hit LM Studio **directly** as the simplest possible target to prove the principle; in the product a local model is driven **through a carrier harness**, so the path that still matters is **replay INTO the OpenCode carrier harness configured with a local backend.** **Still unproven — next spike:** replay-into-carrier-harness, tool-call/result flattening across harnesses, and window/compaction on switch. **✓ Spec drafted: `docs/specs/M0-agent-runtime-and-context.md` (Part B).**

**Exit criteria for M0:** M0-1..M0-6 and M0-8 written specs merged; M0-7 Electron scaffold builds, the "hello, streaming CLI" spike runs, and `electron-builder` packages on both target OSes.

---

## 5 · Milestone sequencing, dependencies & rough sizing

T-shirt sizing (S ≈ days, M ≈ 1–2 wks, L ≈ 2–4 wks for one engineer; greenfield, excludes M0).

1. **M0** Spec-closure + spike — **M** (mostly decisions + a spike)
2. **M1** Foundation & Shell — **M** *(scaffold, chrome, 3 layout modes, token system, routing)*
3. **M2** State Spine + Persistence — **L** *(the backbone + durable SQLite store + lossless switching + migrations + the canonical-transcript store and context reconstruction per M0-8; highest correctness bar)*
4. **M3** Context Library + Configurations — **M**
5. **M4** Providers, Agents & Connections — **M** *(CLI discovery/auth/re-auth; model/agent pickers)*
6. **M5** Conversation Surface + Agent Runtime — **L** *(the real run loop; CLI adapters; streaming; tool cards; inline diffs; concurrency model)*
7. **M6** Inspector + Stats — **M** *(stats entities + chart + cost-stub)*
8. **M7** Compaction & Branching — **S/M**
9. **M8** Changes (git-stub) + Palette + a11y/perf polish — **M**

**Critical path:** M0 → M1 → M2 → M5. M3/M4 can parallelize after M2 if staffed >1. M6/M7/M8 follow M5.

**Concurrency decision (resolve in M5, flagged in M0-1):** v1 should allow **one active streaming run per chat, multiple chats running concurrently in the background**; switching chats does **not** cancel a background run; the Activity/Token&Cost/context-window panels always reflect the *active* chat, with a subtle indicator on background chats that are still running. (This honors the product's parallel-work pitch; confirm during M0.)

---

## 6 · Top risks & mitigations

- **CLI heterogeneity (highest).** Each provider CLI has a different invocation, streaming format, and tool protocol. *Mitigation:* one normalizing adapter per provider behind the common `AgentEvent` schema; **prefer each agent's structured protocol (ACP / app-server / SDK) over stdout-scraping** — t3code proves this is the tractable path, and ACP lets you generate types from the published spec instead of hand-parsing. M0-7 spike de-risks the first adapter; start with one provider in M5 and add others behind the same interface.
- **Electron security posture & footprint.** Electron ships Node + Chromium with permissive defaults and a heavier runtime. *Mitigation:* hardened renderer (`contextIsolation`/`sandbox` on, `nodeIntegration` off), a narrow allowlisted preload/IPC bridge as the only path to privileged calls, and the execution-safety model in M0-2; accept the footprint as the cost of pixel-identical cross-OS rendering. *(Choosing Electron eliminates the webview-rendering-drift risk entirely — the main reason it was selected over Tauri.)*
- **Durable-persistence correctness.** The spine must round-trip losslessly across restart and chat-switch. *Mitigation:* M2 is sized L with a property-test of switch→switch→restore byte-equality (the FR-4.2 AC made executable).
- **Cross-provider context portability (highest-correctness risk).** The classic harness-wrapper bug is a restored display over an empty agent context (observed in t3code); our super-hard requirement raises the bar — context must survive **switching providers mid-conversation**, which native session resume fundamentally cannot do, and must handle heterogeneous tool-call histories and differing context windows. *Mitigation:* a single provider-neutral transcript as source of truth; a universal `buildContext` replay path (native resume only as a same-provider optimization); foreign tool-calls flattened to readable context; per-target re-tokenization + compaction on switch; and the M0-8 acceptance tests — both *resume* and *cross-provider switch* (incl. agentic↔LM Studio) — run for every provider in CI. *(Text-turn agentic→stateless case spike-validated 2026-06-28; tool-call flattening + reverse stateless→agentic direction still open — the genuinely hard half.)*
- **Scope creep from "Implemented."** *Mitigation:* the §1 taxonomy + the Doc-Cleanup PRD relabel make stub vs real explicit and reviewable.
- **Cross-platform tail.** *Mitigation:* `PlatformServices` interface; mac+Linux first; Windows is an additive impl with a cost estimate from M0-7.

---

## 7 · Doc-Cleanup batch (non-blocking, do alongside M0)

Cheap fixes the reviews verified; bundle into one PRD/README pass:
- README line 145: "45 v1 requirements" → **69** (76 total; "7 roadmap" is correct).
- Encode the §1 status taxonomy as a per-requirement field; relabel git/cost/MCP/scope/API-key surfaces as **stub/roadmap**.
- **Reframe LM Studio / Ollama from "providers" (FR-7.2) to *local backends* reached via an auto-configured carrier harness (OpenCode in v1; pi.dev deferred — agentic but non-ACP, needs a bespoke adapter).** NAC Code is a wrapper only — no agent loop, no raw model connections. Add an FR for carrier auto-config (`configureLocalBackend`).
- Fix §8 cross-reference inconsistencies (FR-4.1 dependents listed three ways; FR-7.4 inline vs matrix; family-level refs FR-1.3/10.2/10.4); add the missing FR for **Cockpit chat tabs**.
- Add ACs to the 12 P0s that lack them; quantify performance NFRs; add the security/execution-safety NFR (M0-2) and accessibility NFRs (keyboard/ARIA/focus/reduced-motion).
- Extend §10 data model: `Session`/`Message`/`ToolCall`/`ToolResult`/`TokenUsage`/`CostEvent` entities (`TokenUsage`/`CostEvent` **attributed per provider**, since one session can span providers → session cost is a per-provider, multi-unit breakdown, not a scalar); add `dirty`, `branchedFrom`, `thinking` to Chat; model MCP servers; resolve the Agent dual-namespace (AgentDefinition vs Chat.agent reference).
- README chat-header description: add the Agent picker; fix "ctx"→"attached" status-bar quote; regenerate screenshots at ≥1180px.

---

## Self-Review (spec coverage)

- **Every v1 FR family maps to a milestone** (M1: FR-1; M2: FR-2/4; M3: FR-5/6; M4: FR-7/8/15; M5: FR-3; M6: FR-10/11/13.1; M7: FR-9; M8: FR-12/14). ✔
- **Roadmap items** explicitly out of v1 in §1. ✔
- **Behavioral gaps from both reviews** are owned by M0 (run loop, autonomy, errors, new-chat, file lifecycle, token est) — none deferred silently. ✔
- **The three scope decisions** are reflected in Global Constraints + §1 + the architecture (durable persistence = M2 store; CLI delegation = CliRegistry/AgentRuntime; git/cost = stubs behind interfaces). ✔
- **Stack decided:** Electron (chosen for pixel-identical cross-OS rendering and single-language TS); M0-7 is now a validation/scaffold spike, not a decision gate.
