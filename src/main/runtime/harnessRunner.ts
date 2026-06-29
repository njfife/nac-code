import { spawn, type ChildProcess } from 'child_process'
import type { AgentEvent } from '../../shared/runtime'
import { resolveCwd } from './paths'

/**
 * Parse one NDJSON line from a (stub) harness into a canonical AgentEvent.
 * Pure + exported for unit testing. Returns null for blank/unparseable/unknown lines.
 * The real harness adapters (ACP / app-server / SDK) will map their native events the same way.
 */
export function parseHarnessLine(runId: string, line: string): AgentEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let msg: { type?: string; text?: string; reasoning?: boolean }
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return null
  }
  switch (msg.type) {
    case 'delta':
      return {
        type: 'content.delta',
        runId,
        streamKind: msg.reasoning ? 'reasoning' : 'assistant_text',
        text: String(msg.text ?? '')
      }
    case 'done':
      return { type: 'run.completed', runId, stopReason: 'end_turn' }
    default:
      return null
  }
}

export interface HarnessRun {
  cancel(): void
}

export interface HarnessSpawnRequest {
  prompt: string
  command: string
  args: string[]
  env?: Record<string, string>
  cwd?: string
}

/**
 * Spawn a harness subprocess and stream normalized AgentEvents via onEvent.
 * For the M0-7 tracer this runs the stub harness; swapping command/args for a real CLI
 * (e.g. `claude -p --output-format stream-json`) is the only change needed. stdout is framed
 * strictly on '\n' (NDJSON) — never on U+2028/U+2029, which are valid inside JSON strings.
 */
export function startHarnessRun(
  runId: string,
  req: HarnessSpawnRequest,
  onEvent: (e: AgentEvent) => void
): HarnessRun {
  let settled = false
  const emit = (e: AgentEvent): void => {
    if (settled) return
    if (e.type === 'run.completed' || e.type === 'run.errored') settled = true
    onEvent(e)
  }

  emit({ type: 'run.started', runId })

  let child: ChildProcess
  try {
    child = spawn(req.command, req.args, {
      cwd: resolveCwd(req.cwd),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(req.env ?? {}) }
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
      const event = parseHarnessLine(runId, line)
      if (event) emit(event)
    }
  })

  let stderr = ''
  child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')))

  child.on('error', (err) => emit({ type: 'run.errored', runId, message: err.message }))
  child.on('close', (code) => {
    if (buffer.trim()) {
      const event = parseHarnessLine(runId, buffer)
      if (event) emit(event)
    }
    if (code !== 0 && code !== null) {
      emit({ type: 'run.errored', runId, message: stderr.trim() || `harness exited with code ${code}` })
    }
  })

  return {
    cancel: () => {
      emit({ type: 'run.completed', runId, stopReason: 'canceled' })
      child.kill()
    }
  }
}
