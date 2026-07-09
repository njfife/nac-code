import { spawn, type ChildProcess } from 'child_process'
import type { AgentEvent } from '../../shared/runtime'
import type { HarnessRun } from './harnessRunner'
import { resolveCwd } from './paths'

// Real adapter for the GitHub Copilot CLI (`copilot -p --output-format json`). Maps its JSONL events to
// the canonical AgentEvent union — third real harness, same interface as Claude/Codex. Token-streaming:
// assistant.message_delta carries incremental deltaContent, so the reply streams in token-by-token.

interface CopilotEvent {
  type?: string
  sessionId?: string
  exitCode?: number
  data?: { deltaContent?: string }
}

/** Pure + exported for testing: one copilot JSONL line → 0..n AgentEvents. */
export function parseCopilotLine(runId: string, line: string): AgentEvent[] {
  const trimmed = line.trim()
  if (!trimmed) return []
  let m: CopilotEvent
  try {
    m = JSON.parse(trimmed)
  } catch {
    return [] // skip non-JSON noise
  }
  switch (m.type) {
    case 'assistant.message_delta':
      return m.data?.deltaContent ? [{ type: 'content.delta', runId, streamKind: 'assistant_text', text: m.data.deltaContent }] : []
    case 'result': {
      // Copilot delivers the session id only at the end; carry it so a same-provider resume (-r) is possible later.
      const events: AgentEvent[] = []
      if (m.sessionId) events.push({ type: 'run.started', runId, sessionId: m.sessionId })
      events.push({ type: 'run.completed', runId, stopReason: m.exitCode && m.exitCode !== 0 ? 'error' : 'end_turn' })
      return events
    }
    default:
      return [] // session.*, user.message, assistant.turn_start/message_start/message/turn_end, tool events (v1)
  }
}

/** Pure + exported for testing: build the copilot argv. yolo → --yolo; sessionId → resume that session. */
export function copilotArgs(prompt: string, yolo?: boolean, sessionId?: string, effort?: string, model?: string): string[] {
  const args = ['-p', prompt, '--output-format', 'json', yolo ? '--yolo' : '--allow-all-tools', '--no-ask-user', '--no-color', '--log-level', 'none']
  if (effort) args.push('--reasoning-effort', effort)
  if (model) args.push('--model', model)
  if (sessionId) args.push(`--resume=${sessionId}`)
  return args
}

export function startCopilotRun(
  runId: string,
  req: { prompt: string; binPath?: string; cwd?: string; yolo?: boolean; sessionId?: string; effort?: string; model?: string },
  onEvent: (e: AgentEvent) => void
): HarnessRun {
  let settled = false
  const emit = (e: AgentEvent): void => {
    if (settled) return
    if (e.type === 'run.completed' || e.type === 'run.errored') settled = true
    onEvent(e)
  }

  // off = --allow-all-tools (tools auto-run, paths/URLs still verified); yolo = --yolo (all paths/URLs too).
  // --no-ask-user keeps it from blocking on questions; no --share so it never writes a session .md to the cwd.
  const args = copilotArgs(req.prompt, req.yolo, req.sessionId, req.effort, req.model)

  let child: ChildProcess
  try {
    child = spawn(req.binPath ?? 'copilot', args, { cwd: resolveCwd(req.cwd), stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    emit({ type: 'run.errored', runId, message: (err as Error).message })
    return { cancel: () => {} }
  }

  let buffer = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      for (const ev of parseCopilotLine(runId, line)) emit(ev)
    }
  })

  let stderr = ''
  child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')))

  child.on('error', (err) => emit({ type: 'run.errored', runId, message: err.message }))
  child.on('close', (code) => {
    if (buffer.trim()) for (const ev of parseCopilotLine(runId, buffer)) emit(ev)
    if (code !== 0 && code !== null) emit({ type: 'run.errored', runId, message: stderr.trim().split('\n').pop() || `copilot exited with code ${code}` })
  })

  return {
    cancel: () => {
      emit({ type: 'run.completed', runId, stopReason: 'canceled' })
      child.kill()
    }
  }
}
