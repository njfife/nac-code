// Minimal slice of the canonical AgentEvent model (see docs/specs/M0-agent-runtime-and-context.md, Part A).
// Expanded incrementally; the M0-7 tracer only needs run lifecycle + content deltas.

export interface RunRequest {
  prompt: string
  provider?: string // harness driver id; selects the adapter (e.g. 'claude' → real, else stub)
  chatId?: string // session-affinity key for persistent transports
  sessionId?: string // native session id to resume (e.g. Claude `--resume`) — same-provider fast-path (FR-4.2)
  cwd?: string // working directory for the harness = the chat's workspace folder (agents act on real code)
  yolo?: boolean // autonomy: on = full file/command access; off (default) = restricted per harness (M0-2)
  model?: string // harness model id (e.g. opencode 'lmstudio/qwen/…'); passed as --model where supported
  effort?: string // reasoning depth; omitted = harness default. Adapter maps to its flag
  fast?: boolean // Claude fast mode (research preview) — injected per-run via --settings
}

// One-shot text summarization through a harness — provider-neutral compaction (FR-9 / M0-8).
export interface SummarizeRequest {
  text: string
  provider?: string
  model?: string
}

// Per-turn metering carried on completion (FR-11/13). Providers report different units; we capture what
// each gives (Claude: tokens + $; Codex: tokens; OpenCode: tokens + $; Copilot: neither → turns only).
export interface TurnUsage {
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
}

export interface PermissionOption {
  id: string
  label: string
  kind: 'allow' | 'allow_always' | 'deny'
}

export type AgentEvent =
  | { type: 'run.started'; runId: string; sessionId?: string }
  | { type: 'content.delta'; runId: string; streamKind: 'assistant_text' | 'reasoning'; text: string }
  | { type: 'run.completed'; runId: string; stopReason: 'end_turn' | 'error' | 'canceled'; usage?: TurnUsage }
  | { type: 'run.errored'; runId: string; message: string }
  | { type: 'tool.updated'; runId: string; toolCallId: string; title: string; kind?: string; status: 'pending' | 'running' | 'completed' | 'failed'; detail?: string }
  | { type: 'permission.requested'; runId: string; requestId: string; title: string; detail?: string; options: PermissionOption[] }
  | { type: 'permission.resolved'; runId: string; requestId: string; optionId: string }
  | { type: 'usage.updated'; runId: string; inputTokens: number; cachedInputTokens?: number; outputTokens: number; reasoningOutputTokens?: number; contextUsedTokens?: number; contextWindow?: number } // live token metering (codex app-server thread/tokenUsage); contextWindow/contextUsedTokens drive the Inspector bar

// IPC channel names shared by main and preload.
export const RUN_CHANNELS = {
  start: 'run:start',
  cancel: 'run:cancel',
  event: 'run:event',
  summarize: 'run:summarize',
  respondPermission: 'run:respondPermission'
} as const

export const STATE_CHANNELS = {
  load: 'state:load',
  save: 'state:save'
} as const

export const DIALOG_CHANNELS = {
  pickDirectory: 'dialog:pickDirectory',
  pickFile: 'dialog:pickFile'
} as const

export const FILES_CHANNELS = {
  read: 'files:read'
} as const

export const CHANGES_CHANNELS = {
  get: 'changes:get',
  diff: 'changes:diff'
} as const

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
  variants?: { id: string; label: string; gated?: boolean; contextWindowK?: number }[] // e.g. claude sonnet[1m]
  gated?: boolean // learned: this account's harness rejected the id
  note?: string // honest caveat (e.g. '9x usage', 'session-only')
  contextWindowK?: number // context window in K tokens (live caps or static floor, else 200)
}

export interface ProviderCapabilities {
  provider: string
  source: 'protocol' | 'static' | 'static+learned'
  models: DiscoveredModel[]
  efforts: string[] // provider-wide effort scale (fallback when models carry none)
  effortNote?: string // honest caveat shown under the effort chips (e.g. claude session-only levels)
  fetchedAt: number
}

// Real working-tree changes for a workspace (FR-12), read from git.
export type FileStatus = 'added' | 'modified' | 'deleted'
export interface ChangedFileInfo {
  path: string
  status: FileStatus
  additions: number
  deletions: number
}
export interface ChangesResult {
  branch: string
  root: string
  files: ChangedFileInfo[]
}
export interface DiffSpan {
  type: 'ctx' | 'add' | 'del'
  text: string
}
export interface FileDiffResult {
  diff: DiffSpan[]
  source: string
}
