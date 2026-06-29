import { create } from 'zustand'

// The per-chat state spine (FR-4.1): every chat owns its own provider/model/agent/attached/config.
// Mutations target the ACTIVE chat only — nothing is global. Switching chats is lossless (FR-4.2),
// since each chat object already carries its full configuration.

export interface Workspace {
  id: string
  name: string
}

export interface Chat {
  id: string
  workspaceId: string
  title: string
  time: string // relative label for now; real timestamps with durable persistence
  provider: string // harness driver id (claude | codex | cursor | opencode)
  model: string // model label
  agent: string | null
  attachedIds: string[] // attached context item ids (FR-5.5)
  dirty: boolean // attachments diverge from the applied configuration (FR-6.4)
  contextK: number // context-window tokens used
  windowK: number // model context window
  branchedFrom: string | null // parent chat id for compaction branches (FR-9.3)
}

export type View = 'chat' | 'context' | 'changes'
export type Layout = 'studio' | 'cockpit' | 'focus'
export type ModalKind = 'model' | 'agent' | null

interface AppState {
  workspaces: Workspace[]
  chats: Record<string, Chat>
  activeChatId: string
  view: View
  layout: Layout
  expanded: Record<string, boolean>
  modal: ModalKind
  palette: boolean

  selectChat: (id: string) => void
  toggleWorkspace: (wsId: string) => void
  setLayout: (l: Layout) => void
  setView: (v: View) => void
  setModel: (provider: string, model: string) => void
  setAgent: (agent: string | null) => void
  openModal: (m: ModalKind) => void
  closeModal: () => void
  toggleAttach: (itemId: string) => void
  setPalette: (b: boolean) => void
  togglePalette: () => void
}

const workspaces: Workspace[] = [
  { id: 'ws_nac', name: 'nac-code' },
  { id: 'ws_infra', name: 'infra' }
]

const seedChats: Chat[] = [
  { id: 'c1', workspaceId: 'ws_nac', title: 'M0-7 scaffold + tracer', time: 'now', provider: 'claude', model: 'Opus 4.8', agent: 'nac-code', attachedIds: ['sk-tdd', 'sk-debug', 'ag-nac', 'in-style', 'fl-readme'], dirty: false, contextK: 12, windowK: 200, branchedFrom: null },
  { id: 'c2', workspaceId: 'ws_nac', title: 'Cross-provider spike', time: '1h', provider: 'opencode', model: 'qwen3.6-27b', agent: null, attachedIds: ['sk-tdd', 'fl-spec'], dirty: true, contextK: 8, windowK: 32, branchedFrom: null },
  { id: 'c3', workspaceId: 'ws_infra', title: 'Deploy pipeline review', time: '3h', provider: 'codex', model: 'gpt-5-codex', agent: 'infra', attachedIds: ['sk-tdd', 'sk-debug', 'ag-infra', 'ag-reviewer', 'in-style', 'in-security', 'fl-deploy'], dirty: false, contextK: 41, windowK: 128, branchedFrom: null }
]

export const useApp = create<AppState>()((set) => ({
  workspaces,
  chats: Object.fromEntries(seedChats.map((c) => [c.id, c])),
  activeChatId: 'c1',
  view: 'chat',
  layout: 'studio',
  expanded: { ws_nac: true, ws_infra: false },
  modal: null,
  palette: false,

  selectChat: (id) => set({ activeChatId: id }),
  toggleWorkspace: (wsId) => set((s) => ({ expanded: { ...s.expanded, [wsId]: !s.expanded[wsId] } })),
  setLayout: (l) => set({ layout: l }),
  setView: (v) => set({ view: v }),
  // Per-chat mutations — affect ONLY the active chat (FR-4.1 invariant).
  setModel: (provider, model) =>
    set((s) => ({ chats: { ...s.chats, [s.activeChatId]: { ...s.chats[s.activeChatId], provider, model } } })),
  setAgent: (agent) =>
    set((s) => ({ chats: { ...s.chats, [s.activeChatId]: { ...s.chats[s.activeChatId], agent } } })),
  openModal: (m) => set({ modal: m }),
  closeModal: () => set({ modal: null }),
  toggleAttach: (itemId) =>
    set((s) => {
      const chat = s.chats[s.activeChatId]
      const has = chat.attachedIds.includes(itemId)
      const attachedIds = has ? chat.attachedIds.filter((id) => id !== itemId) : [...chat.attachedIds, itemId]
      // Diverging from the applied configuration marks the chat dirty (FR-6.4).
      return { chats: { ...s.chats, [s.activeChatId]: { ...chat, attachedIds, dirty: true } } }
    }),
  setPalette: (b) => set({ palette: b }),
  togglePalette: () => set((s) => ({ palette: !s.palette }))
}))

// --- selectors / helpers ---
export const selectActiveChat = (s: AppState): Chat => s.chats[s.activeChatId]
export const chatsForWorkspace = (chats: Record<string, Chat>, wsId: string): Chat[] =>
  Object.values(chats).filter((c) => c.workspaceId === wsId)
export const workspaceName = (workspaces: Workspace[], id: string): string =>
  workspaces.find((w) => w.id === id)?.name ?? id
