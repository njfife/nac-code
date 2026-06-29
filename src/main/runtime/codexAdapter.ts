import { spawn, type ChildProcess } from 'child_process'
import type { AgentEvent } from '../../shared/runtime'
import type { HarnessRun } from './harnessRunner'

// Real adapter for Codex (`codex exec --json`). Maps Codex's JSONL events to the canonical AgentEvent
// union — second real harness, behind the same interface as Claude. Non-token-streaming for now:
// agent_message items arrive complete (item.completed), so the reply appears when the item finishes.

interface CodexItem {
  id?: string
  type?: string
  text?: string
  command?: string
  exit_code?: number
  status?: string
}
interface CodexEvent {
  type?: string
  thread_id?: string
  message?: string
  item?: CodexItem
}

// Codex wraps shell commands as `/bin/zsh -lc '<cmd>'` — unwrap to the readable inner command.
function readableCommand(raw: string): string {
  const m = raw.match(/^\/bin\/(?:zsh|bash|sh)\s+-l?c\s+'([\s\S]*)'$/)
  return m ? m[1] : raw
}

/** Pure + exported for testing: one codex JSONL line → 0..n AgentEvents. */
export function parseCodexLine(runId: string, line: string): AgentEvent[] {
  const trimmed = line.trim()
  if (!trimmed) return []
  let m: CodexEvent
  try {
    m = JSON.parse(trimmed)
  } catch {
    return [] // skip non-JSON noise (e.g. a misconfigured MCP's stderr that lands on stdout)
  }
  switch (m.type) {
    case 'thread.started':
      return [{ type: 'run.started', runId, sessionId: m.thread_id }]
    case 'item.completed': {
      const it = m.item
      if (it?.type === 'agent_message' && it.text) return [{ type: 'content.delta', runId, streamKind: 'assistant_text', text: it.text }]
      if (it?.type === 'command_execution' && it.command) {
        const exit = typeof it.exit_code === 'number' && it.exit_code !== 0 ? ` (exit ${it.exit_code})` : ''
        return [{ type: 'content.delta', runId, streamKind: 'assistant_text', text: `\n$ ${readableCommand(it.command)}${exit}\n` }]
      }
      if (it?.type && it.type !== 'reasoning') return [{ type: 'content.delta', runId, streamKind: 'assistant_text', text: `\n[${it.type}]\n` }] // generic tool-item fallback
      return []
    }
    case 'turn.completed':
      return [{ type: 'run.completed', runId, stopReason: 'end_turn' }]
    case 'error':
      return [{ type: 'run.errored', runId, message: m.message ?? 'codex error' }]
    default:
      return [] // turn.started, item.started/updated, …
  }
}

export function startCodexRun(
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

  // read-only sandbox keeps autonomous runs safe; the YOLO/autonomy policy (M0-2) will drive this later.
  const args = ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', req.prompt]

  let child: ChildProcess
  try {
    child = spawn(req.binPath ?? 'codex', args, { stdio: ['ignore', 'pipe', 'pipe'] })
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
      for (const ev of parseCodexLine(runId, line)) emit(ev)
    }
  })

  let stderr = ''
  child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')))

  child.on('error', (err) => emit({ type: 'run.errored', runId, message: err.message }))
  child.on('close', (code) => {
    if (buffer.trim()) for (const ev of parseCodexLine(runId, buffer)) emit(ev)
    if (code !== 0 && code !== null) emit({ type: 'run.errored', runId, message: stderr.trim().split('\n').pop() || `codex exited with code ${code}` })
  })

  return {
    cancel: () => {
      emit({ type: 'run.completed', runId, stopReason: 'canceled' })
      child.kill()
    }
  }
}
