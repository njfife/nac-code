import { spawn, type ChildProcess } from 'child_process'
import type { AgentEvent } from '../../shared/runtime'
import type { HarnessRun } from './harnessRunner'

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

export function startCopilotRun(
  runId: string,
  req: { prompt: string; binPath?: string },
  onEvent: (e: AgentEvent) => void
): HarnessRun {
  let settled = false
  const emit = (e: AgentEvent): void => {
    if (settled) return
    if (e.type === 'run.completed' || e.type === 'run.errored') settled = true
    onEvent(e)
  }

  // --allow-all-tools is required for non-interactive mode; the autonomy/YOLO policy (M0-2) will scope this.
  // --no-ask-user keeps it from blocking on questions; no --share so it never writes a session .md to the cwd.
  const args = ['-p', req.prompt, '--output-format', 'json', '--allow-all-tools', '--no-ask-user', '--no-color', '--log-level', 'none']

  let child: ChildProcess
  try {
    child = spawn(req.binPath ?? 'copilot', args, { stdio: ['ignore', 'pipe', 'pipe'] })
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
