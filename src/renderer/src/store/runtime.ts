import { useApp, type Chat, type Turn } from './store'
import { modelIdFor } from '../data/providers'
import { ITEMS_BY_ID, type ContextItem } from '../data/context'

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
        s.recordUsage(chatId, s.chats[chatId]?.provider ?? 'unknown', event.usage ?? {})
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

// Build the replay context — the universal buildContext path (M0-8 Part B): the compaction summary (if any)
// plus the turns since that checkpoint. This is what makes a Claude↔Codex switch preserve context while
// staying bounded as conversations grow (replay = summary + tail, never the whole raw transcript).
export function buildReplayPrompt(summary: string | null, tail: Turn[], message: string): string {
  const parts: string[] = []
  if (summary) parts.push(`Summary of the earlier conversation:\n\n${summary}`)
  for (const t of tail) if (t.text.trim()) parts.push(`${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`)
  if (parts.length === 0) return message
  return `Here is the prior conversation, for context:\n\n${parts.join('\n\n')}\n\n---\nContinue the conversation.\n\nUser: ${message}`
}

// Inject attached context items (authored notes/skills + file contents) as a leading context block (FR-5).
export function buildContextBlock(items: ContextItem[], fileContents: Record<string, string>): string {
  const parts: string[] = []
  for (const it of items) {
    if (it.content && it.content.trim()) parts.push(`## ${it.name}\n${it.content.trim()}`)
    else if (it.path && fileContents[it.path]) parts.push(`## ${it.name} (${it.path})\n\`\`\`\n${fileContents[it.path]}\n\`\`\``)
  }
  if (!parts.length) return ''
  return `Attached context for this conversation:\n\n${parts.join('\n\n')}\n\n---\n\n`
}

export async function sendMessage(text: string): Promise<void> {
  const s = useApp.getState()
  const message = text.trim()
  if (!message || !window.nac?.runs) return
  const chatId = s.activeChatId
  const chat = s.chats[chatId]
  const cwd = s.workspaces.find((w) => w.id === chat.workspaceId)?.path || undefined // run in the workspace folder
  // Replay = compaction summary + the turns since that checkpoint (the tail).
  const tail = chat.messages.slice(chat.summarizedThrough)
  // Native resume when continuing the SAME provider's live session (all harnesses: claude --resume,
  // codex exec resume, copilot --resume, opencode -s). Otherwise replay the bounded context into the
  // (possibly different) harness — that's the cross-provider context carry-over.
  const useNative = chat.sessionProvider === chat.provider && Boolean(chat.sessionId)
  const now = Date.now()
  s.pushTurn(chatId, { id: `u_${now}`, role: 'user', text: message })
  s.pushTurn(chatId, { id: `a_${now}`, role: 'assistant', text: '', streaming: true })
  try {
    let contextBlock = ''
    if (!useNative) {
      const attachedItems = chat.attachedIds
        .map((id) => s.userItems.find((u) => u.id === id) ?? ITEMS_BY_ID[id])
        .filter((i): i is ContextItem => Boolean(i))
      const fileContents: Record<string, string> = {}
      for (const it of attachedItems) {
        if (it.path && !it.content) {
          const c = await window.nac.files?.read(it.path)
          if (c) fileContents[it.path] = c
        }
      }
      contextBlock = buildContextBlock(attachedItems, fileContents)
    }
    const { runId } = await window.nac.runs.start({
      prompt: useNative ? message : contextBlock + buildReplayPrompt(chat.summary, tail, message),
      provider: chat.provider,
      sessionId: useNative ? chat.sessionId ?? undefined : undefined,
      cwd,
      yolo: chat.yolo,
      model: modelIdFor(chat.provider, chat.model)
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
