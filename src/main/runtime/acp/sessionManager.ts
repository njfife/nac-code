import type { AgentEvent } from '../../../shared/runtime'
import { AcpSession } from './acpSession'

// One live ACP session per chat. Sessions are disposed on provider switch (promptViaAcp detects
// this when the renderer sends no sessionId — see below), a dead child process being replaced on
// the next prompt, app quit, or idle timeout.

export const IDLE_MS = 15 * 60_000

interface Entry {
  session: AcpSession
  idleTimer: ReturnType<typeof setTimeout> | null
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

/** Try the interactive path. Resolves { ok: false } when ACP is unavailable — caller falls back. */
export async function promptViaAcp(opts: {
  chatId: string
  runId: string
  prompt: string
  cwd?: string
  yolo?: boolean
  sessionId?: string
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

  // Important 5: no sessionId means the renderer built a replay prompt — it believes there's no
  // native session (provider changed, or the session was otherwise dropped client-side). Any ACP
  // session we're still holding for this chat is stale and must be disposed, per spec.
  if (entry && opts.sessionId === undefined) {
    disposeChat(opts.chatId)
    entry = undefined
  }

  if (!entry) {
    const ref = { onEvent: opts.onEvent }
    const session = new AcpSession((e) => {
      if (e.type === 'run.completed' || e.type === 'run.errored') runToChat.delete(e.runId)
      ref.onEvent(e)
    }, opts.yolo === true)
    try {
      await session.connect(opts.cwd, opts.sessionId)
    } catch {
      session.dispose()
      return { ok: false }
    }
    entry = { session, idleTimer: null, ref }
    byChat.set(opts.chatId, entry)
  } else {
    entry.ref.onEvent = opts.onEvent
  }
  entry.session.setYolo(opts.yolo === true)
  runToChat.set(opts.runId, opts.chatId)
  entry.session.prompt(opts.runId, opts.prompt)
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
