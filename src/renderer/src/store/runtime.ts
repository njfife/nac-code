import { useApp, type Chat } from './store'

// Renderer-side run controller: maps each run's AgentEvent stream onto the owning chat's transcript,
// so a run keeps streaming into its chat even if the user switches away.
const runToChat: Record<string, string> = {}
let initialized = false

export function initRuntime(): void {
  if (initialized || !window.nac?.runs) return
  initialized = true
  window.nac.runs.onEvent((event) => {
    const chatId = runToChat[event.runId]
    if (!chatId) return
    const s = useApp.getState()
    switch (event.type) {
      case 'run.started':
        if (event.sessionId) s.setSession(chatId, event.sessionId)
        break
      case 'content.delta':
        if (event.streamKind === 'assistant_text') s.appendDelta(chatId, event.text)
        break
      case 'run.completed':
        s.endTurn(chatId)
        delete runToChat[event.runId]
        break
      case 'run.errored':
        s.endTurn(chatId, event.message)
        delete runToChat[event.runId]
        break
    }
  })
}

export async function sendMessage(text: string): Promise<void> {
  const s = useApp.getState()
  const prompt = text.trim()
  if (!prompt || !window.nac?.runs) return
  const chatId = s.activeChatId
  const chat = s.chats[chatId]
  const now = Date.now()
  s.pushTurn(chatId, { id: `u_${now}`, role: 'user', text: prompt })
  s.pushTurn(chatId, { id: `a_${now}`, role: 'assistant', text: '', streaming: true })
  try {
    // Same-provider fast-path: pass the chat's native session id so Claude --resume's the prior turn (FR-4.2).
    const { runId } = await window.nac.runs.start({ prompt, provider: chat.provider, sessionId: chat.claudeSessionId ?? undefined })
    runToChat[runId] = chatId
  } catch (e) {
    s.endTurn(chatId, (e as Error).message)
  }
}

export function isStreaming(chat: Chat): boolean {
  const msgs = chat?.messages
  if (!msgs || msgs.length === 0) return false
  return Boolean(msgs[msgs.length - 1]?.streaming)
}
