import { useApp, type Chat, type Workspace, type Layout, type ThinkingLevel } from './store'
import type { ContextItem } from '../data/context'

// Only the durable slice is persisted (not transient UI like modal/palette/view).
interface PersistedState {
  chats: Record<string, Partial<Chat>>
  workspaces: Workspace[]
  activeChatId: string
  layout: Layout
  expanded: Record<string, boolean>
  userItems?: ContextItem[]
}

// Tolerant hydration: fill any fields missing from older persisted data (schema drift) so a stale
// nac-state.json can never crash the app. Add new Chat fields here with a default when introduced.
function normalizeChat(c: Partial<Chat> & { claudeSessionId?: string | null }, id: string): Chat {
  return {
    id,
    workspaceId: c.workspaceId ?? 'ws_nac',
    title: c.title ?? 'Chat',
    time: c.time ?? 'now',
    provider: c.provider ?? 'claude',
    model: c.model ?? 'Opus 4.8',
    agent: c.agent ?? null,
    yolo: c.yolo ?? false,
    thinking: (c.thinking as ThinkingLevel) ?? 'medium',
    activeConfig: c.activeConfig ?? null,
    attachedIds: Array.isArray(c.attachedIds) ? c.attachedIds : [],
    dirty: c.dirty ?? false,
    compacting: false, // never restore a stuck in-progress state
    compacted: c.compacted ?? false,
    contextK: c.contextK ?? 0,
    windowK: c.windowK ?? 200,
    branchedFrom: c.branchedFrom ?? null,
    messages: Array.isArray(c.messages) ? c.messages : [],
    sessionId: c.sessionId ?? c.claudeSessionId ?? null, // migrate legacy claudeSessionId
    sessionProvider: c.sessionProvider ?? (c.claudeSessionId ? 'claude' : null),
    summary: c.summary ?? null,
    summarizedThrough: typeof c.summarizedThrough === 'number' ? c.summarizedThrough : 0,
    usage: c.usage ?? {},
    seededAttachments: Array.isArray(c.seededAttachments) ? c.seededAttachments : null
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

// Hydrate the store from disk on launch, then persist (debounced) on every change (FR-4.3).
export async function initPersistence(): Promise<void> {
  if (!window.nac?.state) return // preload bridge unavailable — run in-memory
  try {
    const loaded = (await window.nac.state.load()) as PersistedState | null
    if (loaded?.chats && Object.keys(loaded.chats).length > 0) {
      const chats: Record<string, Chat> = {}
      for (const [id, raw] of Object.entries(loaded.chats)) chats[id] = normalizeChat(raw ?? {}, id)
      const activeChatId = loaded.activeChatId in chats ? loaded.activeChatId : Object.keys(chats)[0]
      const workspaces = (loaded.workspaces ?? useApp.getState().workspaces).map((w) => ({ id: w.id, name: w.name, path: w.path ?? '', defaults: w.defaults }))
      useApp.setState({
        chats,
        workspaces,
        activeChatId,
        layout: loaded.layout ?? useApp.getState().layout,
        expanded: loaded.expanded ?? useApp.getState().expanded,
        userItems: Array.isArray(loaded.userItems) ? loaded.userItems : useApp.getState().userItems
      })
    }
  } catch {
    // ignore — keep seeded defaults
  }

  useApp.subscribe((s) => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      const snapshot: PersistedState = {
        chats: s.chats,
        workspaces: s.workspaces,
        activeChatId: s.activeChatId,
        layout: s.layout,
        expanded: s.expanded,
        userItems: s.userItems
      }
      void window.nac.state.save(snapshot)
    }, 400)
  })
}
