import { spawn, type ChildProcess } from 'child_process'
import type { AgentEvent } from '../../shared/runtime'
import type { HarnessRun } from './harnessRunner'

// Real adapter for Claude Code (`claude -p … --output-format stream-json --verbose`).
// Maps Claude's stream-json events to the canonical AgentEvent union — the first REAL harness (M5),
// behind the same interface as the stub. Two-hop normalization: one wire line → 0..n AgentEvents.

interface ClaudeBlock {
  type: string
  text?: string
  thinking?: string
  name?: string
}
interface ClaudeEvent {
  type?: string
  subtype?: string
  is_error?: boolean
  stop_reason?: string
  message?: { content?: ClaudeBlock[] }
}

/** Pure + exported for testing: one stream-json line → 0..n AgentEvents. */
export function parseClaudeLine(runId: string, line: string): AgentEvent[] {
  const trimmed = line.trim()
  if (!trimmed) return []
  let m: ClaudeEvent
  try {
    m = JSON.parse(trimmed)
  } catch {
    return []
  }
  switch (m.type) {
    case 'system':
      return m.subtype === 'init' ? [{ type: 'run.started', runId }] : [] // ignore hooks etc.
    case 'assistant': {
      const out: AgentEvent[] = []
      for (const b of m.message?.content ?? []) {
        if (b.type === 'text' && b.text) out.push({ type: 'content.delta', runId, streamKind: 'assistant_text', text: b.text })
        else if (b.type === 'thinking' && b.thinking) out.push({ type: 'content.delta', runId, streamKind: 'reasoning', text: b.thinking })
        else if (b.type === 'tool_use') out.push({ type: 'content.delta', runId, streamKind: 'assistant_text', text: `\n[tool: ${b.name ?? 'unknown'}]\n` })
      }
      return out
    }
    case 'result':
      return [{ type: 'run.completed', runId, stopReason: m.is_error ? 'error' : 'end_turn' }]
    default:
      return [] // rate_limit_event, post_turn_summary, …
  }
}

export function startClaudeRun(
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

  let child: ChildProcess
  try {
    child = spawn(req.binPath ?? 'claude', ['-p', req.prompt, '--output-format', 'stream-json', '--verbose'], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
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
      for (const ev of parseClaudeLine(runId, line)) emit(ev)
    }
  })

  let stderr = ''
  child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')))

  child.on('error', (err) => emit({ type: 'run.errored', runId, message: err.message }))
  child.on('close', (code) => {
    if (buffer.trim()) for (const ev of parseClaudeLine(runId, buffer)) emit(ev)
    if (code !== 0 && code !== null) emit({ type: 'run.errored', runId, message: stderr.trim() || `claude exited with code ${code}` })
  })

  return {
    cancel: () => {
      emit({ type: 'run.completed', runId, stopReason: 'canceled' })
      child.kill()
    }
  }
}
