import type { AgentEvent } from '../../../shared/runtime'
import { AcpSession, type TransportSession, type PromptOpts, OPENCODE_PROFILE } from './acpSession'
import { CodexSession } from './codexSession'
import { ClaudeSession } from './claudeSession'
import type { ContextPayload } from '../../../shared/contextRender'

// One live transport session per chat — copilot ACP, codex app-server, claude SDK, or opencode ACP.
// Sessions are disposed on provider switch (promptViaTransport detects this when the renderer sends
// no sessionId — see below), a dead child process being replaced on the next prompt, app quit, or idle timeout.

export const IDLE_MS = 15 * 60_000

interface Entry {
  session: TransportSession
  idleTimer: ReturnType<typeof setTimeout> | null
  provider: 'copilot' | 'codex' | 'claude' | 'opencode'
  // Mutable indirection so a reused session's event sink always points at the CURRENT caller's
  // onEvent, not the closure captured when the session was first created (Important 4).
  ref: { onEvent: (e: AgentEvent) => void }
}

const byChat = new Map<string, Entry>()
const runToChat = new Map<string, string>()

function touch(chatId: string): void {
  const e = byChat.get(chatId)
  if (!e) return
  if (e.idleTimer) clearTimeout(e.idleTimer)
  e.idleTimer = setTimeout(() => disposeChat(chatId), IDLE_MS)
}

function disposeChat(chatId: string, force = false): void {
  const e = byChat.get(chatId)
  if (!e) return
  if (!force && e.session.busy) {
    // Idle reaper path: a turn can run up to 30 min — re-arm instead of killing mid-turn.
    touch(chatId)
    return
  }
  byChat.delete(chatId)
  if (e.idleTimer) clearTimeout(e.idleTimer)
  e.session.dispose()
}

/** Try the interactive path. Resolves { ok: false } when the transport is unavailable — caller falls back. */
export async function promptViaTransport(opts: {
  provider: 'copilot' | 'codex' | 'claude' | 'opencode'
  chatId: string
  runId: string
  prompt: string
  cwd?: string
  yolo?: boolean
  sessionId?: string
  model?: string
  effort?: string
  agent?: string
  context?: ContextPayload
  onEvent: (e: AgentEvent) => void
}): Promise<{ ok: boolean }> {
  let entry = byChat.get(opts.chatId)

  // Important 2: a dead child (process exited mid-lifetime) must never be reused — its stdin is
  // gone, so a session/prompt against it would hang until the 30-min timeout with Stop a no-op.
  if (entry && entry.session.dead) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.session.dispose()
    byChat.delete(opts.chatId)
    entry = undefined
  }

  // Defense-in-depth: an entry from a different provider must never be reused, regardless of what
  // sessionId the renderer sent — the renderer's single sessionProvider slot makes this unreachable
  // today, but the invariant belongs here, self-enforced.
  if (entry && entry.provider !== opts.provider) {
    disposeChat(opts.chatId, true)
    entry = undefined
  }

  // Important 5: no sessionId means the renderer built a replay prompt — it believes there's no
  // native session (provider changed, or the session was otherwise dropped client-side). Any
  // transport session we're still holding for this chat is stale and must be disposed, per spec.
  if (entry && opts.sessionId === undefined) {
    disposeChat(opts.chatId)
    entry = undefined
  }

  if (!entry) {
    const ref = { onEvent: opts.onEvent }
    const sink = (e: AgentEvent): void => {
      if (e.type === 'run.completed' || e.type === 'run.errored') runToChat.delete(e.runId)
      ref.onEvent(e)
    }
    const session: TransportSession & { connect(cwd: string | undefined, id: string | undefined): Promise<string> } =
      opts.provider === 'codex'
        ? new CodexSession(sink, opts.yolo === true)
        : opts.provider === 'claude'
          ? new ClaudeSession(sink, opts.yolo === true, { model: opts.model, effort: opts.effort, agent: opts.agent })
          : opts.provider === 'opencode'
            ? new AcpSession(sink, opts.yolo === true, OPENCODE_PROFILE)
            : new AcpSession(sink, opts.yolo === true)
    try {
      await session.connect(opts.cwd, opts.sessionId)
    } catch {
      session.dispose()
      return { ok: false }
    }
    entry = { session, idleTimer: null, provider: opts.provider, ref }
    byChat.set(opts.chatId, entry)
  } else {
    entry.ref.onEvent = opts.onEvent
  }
  entry.session.setYolo(opts.yolo === true)
  runToChat.set(opts.runId, opts.chatId)
  const promptOpts: PromptOpts = { model: opts.model, effort: opts.effort, agent: opts.agent, context: opts.context }
  entry.session.prompt(opts.runId, opts.prompt, promptOpts)
  touch(opts.chatId)
  return { ok: true }
}

export function respondPermission(runId: string, requestId: string, optionId: string): void {
  const chatId = runToChat.get(runId)
  if (!chatId) return
  byChat.get(chatId)?.session.respondPermission(requestId, optionId)
  touch(chatId)
}

export function cancelRun(runId: string): boolean {
  const chatId = runToChat.get(runId)
  if (!chatId) return false
  const e = byChat.get(chatId)
  if (!e) return false
  e.session.cancel()
  return true
}

export function disposeAll(): void {
  // App quit: force — a busy session must still be torn down (the process is exiting).
  for (const chatId of [...byChat.keys()]) disposeChat(chatId, true)
}
