import { spawn, type ChildProcess } from 'child_process'
import type { AgentEvent } from '../../shared/runtime'
import type { HarnessRun } from './harnessRunner'
import { resolveCwd } from './paths'

// Real adapter for OpenCode (`opencode run --format json`) — the carrier harness for local models
// (LM Studio) and OpenCode-hosted models. Normalizes its JSON events into the canonical AgentEvent union.
// Note: `--format json` emits one complete `text` part per message (not token deltas), and the turn ends
// at process exit (step_finish is per-step), so completion is emitted on a clean close, not from the stream.

interface OCPart {
  type?: string
  text?: string
  reason?: string
}
interface OCEvent {
  type?: string
  sessionID?: string
  part?: OCPart
}

/** Pure + exported for testing: build the opencode argv. model is `provider/model`; yolo skips permissions. */
export function openCodeArgs(prompt: string, model?: string, yolo?: boolean, sessionId?: string, variant?: string): string[] {
  const args = ['run', prompt, '--format', 'json']
  if (model) args.push('-m', model)
  if (variant) args.push('--variant', variant) // provider-specific reasoning effort
  if (yolo) args.push('--dangerously-skip-permissions')
  if (sessionId) args.push('-s', sessionId)
  return args
}

/** Pure + exported for testing: one opencode JSONL line → 0..n AgentEvents. */
export function parseOpenCodeLine(runId: string, line: string): AgentEvent[] {
  const trimmed = line.trim()
  if (!trimmed) return []
  let m: OCEvent
  try {
    m = JSON.parse(trimmed)
  } catch {
    return [] // skip non-JSON noise
  }
  switch (m.type) {
    case 'step_start':
      return m.sessionID ? [{ type: 'run.started', runId, sessionId: m.sessionID }] : []
    case 'text':
      return m.part?.text ? [{ type: 'content.delta', runId, streamKind: 'assistant_text', text: m.part.text }] : []
    case 'reasoning':
      return m.part?.text ? [{ type: 'content.delta', runId, streamKind: 'reasoning', text: m.part.text }] : []
    default:
      return [] // step_finish (completion comes from process exit), tool parts, etc.
  }
}

/** Pure + exported for testing: per-step token/cost usage from an opencode `step_finish` line. */
export function parseOpenCodeStepUsage(line: string): { inputTokens: number; outputTokens: number; costUsd: number } | null {
  const t = line.trim()
  if (!t) return null
  let m: { type?: string; part?: { tokens?: { input?: number; output?: number }; cost?: number } }
  try {
    m = JSON.parse(t)
  } catch {
    return null
  }
  if (m.type !== 'step_finish') return null
  const tok = m.part?.tokens ?? {}
  return { inputTokens: tok.input ?? 0, outputTokens: tok.output ?? 0, costUsd: m.part?.cost ?? 0 }
}

export function startOpenCodeRun(
  runId: string,
  req: { prompt: string; binPath?: string; model?: string; cwd?: string; yolo?: boolean; sessionId?: string },
  onEvent: (e: AgentEvent) => void
): HarnessRun {
  let settled = false
  const emit = (e: AgentEvent): void => {
    if (settled) return
    if (e.type === 'run.completed' || e.type === 'run.errored') settled = true
    onEvent(e)
  }

  const args = openCodeArgs(req.prompt, req.model, req.yolo, req.sessionId)

  let child: ChildProcess
  try {
    child = spawn(req.binPath ?? 'opencode', args, { cwd: resolveCwd(req.cwd), stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    emit({ type: 'run.errored', runId, message: (err as Error).message })
    return { cancel: () => {} }
  }

  const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 }
  let hasUsage = false
  const accUsage = (line: string): void => {
    const u = parseOpenCodeStepUsage(line)
    if (!u) return
    usage.inputTokens += u.inputTokens
    usage.outputTokens += u.outputTokens
    usage.costUsd += u.costUsd
    hasUsage = true
  }

  let buffer = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      for (const ev of parseOpenCodeLine(runId, line)) emit(ev)
      accUsage(line)
    }
  })

  let stderr = ''
  child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')))

  child.on('error', (err) => emit({ type: 'run.errored', runId, message: err.message }))
  child.on('close', (code) => {
    if (buffer.trim()) {
      for (const ev of parseOpenCodeLine(runId, buffer)) emit(ev)
      accUsage(buffer)
    }
    if (code === 0) emit({ type: 'run.completed', runId, stopReason: 'end_turn', usage: hasUsage ? usage : undefined }) // opencode signals completion by exiting
    else if (code !== null) emit({ type: 'run.errored', runId, message: stderr.trim().split('\n').pop() || `opencode exited with code ${code}` })
  })

  return {
    cancel: () => {
      emit({ type: 'run.completed', runId, stopReason: 'canceled' })
      child.kill()
    }
  }
}
