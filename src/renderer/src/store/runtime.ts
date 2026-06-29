import { useApp, type Chat } from './store'

// Renderer-side run controller: maps each run's AgentEvent stream onto the owning chat's transcript,
// and decides native-resume vs transcript-replay per send.
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
        // Stamp the native session with the provider that produced it (resume only valid if it matches later).
        if (event.sessionId) s.setSession(chatId, event.sessionId, s.chats[chatId]?.provider ?? 'claude')
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

// Render the prior transcript as a priming preamble — the universal buildContext path (M0-8 Part B).
// This is what makes a Claude↔Codex switch preserve context: the new harness gets the conversation as text.
function primedPrompt(prior: Chat['messages'], message: string): string {
  const convo = prior
    .filter((t) => t.text.trim())
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`)
    .join('\n\n')
  if (!convo) return message
  return `Here is the prior conversation, for context:\n\n${convo}\n\n---\nContinue the conversation.\n\nUser: ${message}`
}

export async function sendMessage(text: string): Promise<void> {
  const s = useApp.getState()
  const message = text.trim()
  if (!message || !window.nac?.runs) return
  const chatId = s.activeChatId
  const chat = s.chats[chatId]
  const prior = chat.messages
  // Native resume only when continuing the SAME provider's live session (Claude today). Otherwise replay
  // the transcript into the (possibly different) harness — that's the cross-provider context carry-over.
  const useNative = chat.provider === 'claude' && chat.sessionProvider === 'claude' && Boolean(chat.sessionId)
  const now = Date.now()
  s.pushTurn(chatId, { id: `u_${now}`, role: 'user', text: message })
  s.pushTurn(chatId, { id: `a_${now}`, role: 'assistant', text: '', streaming: true })
  try {
    const { runId } = await window.nac.runs.start({
      prompt: useNative ? message : primedPrompt(prior, message),
      provider: chat.provider,
      sessionId: useNative ? chat.sessionId ?? undefined : undefined
    })
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
