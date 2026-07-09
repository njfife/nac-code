import type { AgentEvent } from '../../../shared/runtime'
import { AcpSession } from './acpSession'

// One live ACP session per chat. Sessions die on provider switch (a new prompt for the same chat
// with a different transport never reaches here), app quit, or idle timeout.

export const IDLE_MS = 15 * 60_000

interface Entry {
  session: AcpSession
  idleTimer: ReturnType<typeof setTimeout> | null
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
  if (!entry) {
    const session = new AcpSession((e) => {
      if (e.type === 'run.completed' || e.type === 'run.errored') runToChat.delete(e.runId)
      opts.onEvent(e)
    }, opts.yolo === true)
    try {
      await session.connect(opts.cwd, opts.sessionId)
    } catch {
      session.dispose()
      return { ok: false }
    }
    entry = { session, idleTimer: null }
    byChat.set(opts.chatId, entry)
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
