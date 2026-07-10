import { useApp, type Chat, type Turn } from './store'
import { modelIdFor, effortScaleFor } from '../../../shared/capabilities'
import { ITEMS_BY_ID, seedKey, type ContextItem } from '../data/context'
import { renderContextText, type ContextPayload } from '../../../shared/contextRender'

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
      case 'tool.updated':
        s.upsertTool(chatId, { toolCallId: event.toolCallId, title: event.title, kind: event.kind, status: event.status, detail: event.detail })
        break
      case 'permission.requested':
        s.upsertPermission(chatId, { requestId: event.requestId, title: event.title, detail: event.detail, options: event.options })
        break
      case 'permission.resolved':
        s.resolvePermission(chatId, event.requestId, event.optionId)
        break
      case 'usage.updated':
        s.setLiveContext(chatId, event.contextUsedTokens ?? 0, event.contextWindow)
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
  const payloadItems: ContextPayload['items'] = []
  for (const it of items) {
    const content = it.content && it.content.trim() ? it.content.trim() : it.path ? fileContents[it.path] : undefined
    if (content) {
      payloadItems.push({ name: it.name, content, path: it.path })
    }
  }
  return renderContextText({ items: payloadItems, removed: [] })
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
      // Record seed KEYS, not bare ids — a user item's key carries its rev, so a later edit to an
      // already-seeded note trips contextPending even though the attached id set hasn't changed.
      const seedKeys = chat.attachedIds.map((id) => {
        const u = s.userItems.find((i) => i.id === id)
        return u ? seedKey(u) : id
      })
      s.markSeeded(chatId, seedKeys) // record what's now seeded into the (fresh) session
    }
    // Send-time effort validation: a stale/invalid effort (e.g. carried over from a model switch
    // whose scale doesn't include it) is treated as null rather than sent to the harness.
    const scale = effortScaleFor(s.caps[chat.provider], chat.model)
    const { runId } = await window.nac.runs.start({
      prompt: useNative ? message : contextBlock + buildReplayPrompt(chat.summary, tail, message),
      provider: chat.provider,
      chatId,
      sessionId: useNative ? chat.sessionId ?? undefined : undefined,
      cwd,
      yolo: chat.yolo,
      model: modelIdFor(chat.provider, chat.model, s.caps[chat.provider]),
      effort: chat.effort && scale.includes(chat.effort) ? chat.effort : undefined,
      fast: chat.fast || undefined
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

// Reverse-lookup: the run id currently driving a chat's streaming turn (for Stop / permission responses).
export function runIdForChat(chatId: string): string | undefined {
  return Object.keys(runToChat).find((r) => runToChat[r] === chatId)
}
