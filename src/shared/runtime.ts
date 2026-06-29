// Minimal slice of the canonical AgentEvent model (see docs/specs/M0-agent-runtime-and-context.md, Part A).
// Expanded incrementally; the M0-7 tracer only needs run lifecycle + content deltas.

export interface RunRequest {
  prompt: string
}

export type AgentEvent =
  | { type: 'run.started'; runId: string }
  | { type: 'content.delta'; runId: string; streamKind: 'assistant_text' | 'reasoning'; text: string }
  | { type: 'run.completed'; runId: string; stopReason: 'end_turn' | 'error' | 'canceled' }
  | { type: 'run.errored'; runId: string; message: string }

// IPC channel names shared by main and preload.
export const RUN_CHANNELS = {
  start: 'run:start',
  cancel: 'run:cancel',
  event: 'run:event'
} as const

export const STATE_CHANNELS = {
  load: 'state:load',
  save: 'state:save'
} as const
