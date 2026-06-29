// Minimal slice of the canonical AgentEvent model (see docs/specs/M0-agent-runtime-and-context.md, Part A).
// Expanded incrementally; the M0-7 tracer only needs run lifecycle + content deltas.

export interface RunRequest {
  prompt: string
  provider?: string // harness driver id; selects the adapter (e.g. 'claude' → real, else stub)
  sessionId?: string // native session id to resume (e.g. Claude `--resume`) — same-provider fast-path (FR-4.2)
  cwd?: string // working directory for the harness = the chat's workspace folder (agents act on real code)
  yolo?: boolean // autonomy: on = full file/command access; off (default) = restricted per harness (M0-2)
}

// One-shot text summarization through a harness — provider-neutral compaction (FR-9 / M0-8).
export interface SummarizeRequest {
  text: string
  provider?: string
}

export type AgentEvent =
  | { type: 'run.started'; runId: string; sessionId?: string }
  | { type: 'content.delta'; runId: string; streamKind: 'assistant_text' | 'reasoning'; text: string }
  | { type: 'run.completed'; runId: string; stopReason: 'end_turn' | 'error' | 'canceled' }
  | { type: 'run.errored'; runId: string; message: string }

// IPC channel names shared by main and preload.
export const RUN_CHANNELS = {
  start: 'run:start',
  cancel: 'run:cancel',
  event: 'run:event',
  summarize: 'run:summarize'
} as const

export const STATE_CHANNELS = {
  load: 'state:load',
  save: 'state:save'
} as const

export const DIALOG_CHANNELS = {
  pickDirectory: 'dialog:pickDirectory'
} as const
