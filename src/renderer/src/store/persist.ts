import { useApp, type Chat, type Workspace, type Layout } from './store'

// Only the durable slice is persisted (not transient UI like modal/palette/view).
interface PersistedState {
  chats: Record<string, Chat>
  workspaces: Workspace[]
  activeChatId: string
  layout: Layout
  expanded: Record<string, boolean>
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

// Hydrate the store from disk on launch, then persist (debounced) on every change (FR-4.3).
export async function initPersistence(): Promise<void> {
  try {
    const loaded = (await window.nac.state.load()) as PersistedState | null
    if (loaded?.chats && Object.keys(loaded.chats).length > 0) {
      const activeChatId = loaded.activeChatId in loaded.chats ? loaded.activeChatId : Object.keys(loaded.chats)[0]
      useApp.setState({
        chats: loaded.chats,
        workspaces: loaded.workspaces ?? useApp.getState().workspaces,
        activeChatId,
        layout: loaded.layout ?? useApp.getState().layout,
        expanded: loaded.expanded ?? useApp.getState().expanded
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
        expanded: s.expanded
      }
      void window.nac.state.save(snapshot)
    }, 400)
  })
}
