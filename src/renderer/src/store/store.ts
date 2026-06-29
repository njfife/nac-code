import { create } from 'zustand'
import { CONFIGS_BY_ID } from '../data/configs'

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
  yolo: boolean // autonomy toggle, per-chat (M0-2)
  thinking: ThinkingLevel // reasoning level, per-chat (M0-3)
  activeConfig: string | null // applied configuration id (FR-6.2)
  attachedIds: string[] // attached context item ids (FR-5.5)
  dirty: boolean // attachments diverge from the applied configuration (FR-6.4)
  compacting: boolean // compaction in progress (FR-9.1)
  compacted: boolean // context has been compacted
  contextK: number // context-window tokens used
  windowK: number // model context window
  branchedFrom: string | null // parent chat id for compaction branches (FR-9.3)
}

export type View = 'chat' | 'context' | 'changes'
export type Layout = 'studio' | 'cockpit' | 'focus'
export type ModalKind = 'model' | 'agent' | 'stats' | null
export type ThinkingLevel = 'none' | 'low' | 'medium' | 'high'

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
  applyConfig: (configId: string) => void
  setPalette: (b: boolean) => void
  togglePalette: () => void
  compactChat: () => void
  newFromCompacted: () => void
  newChat: () => void
  toggleYolo: () => void
  setThinking: (t: ThinkingLevel) => void
}

const workspaces: Workspace[] = [
  { id: 'ws_nac', name: 'nac-code' },
  { id: 'ws_infra', name: 'infra' }
]

const base = { compacting: false, compacted: false, yolo: false, thinking: 'medium' as ThinkingLevel }
const seedChats: Chat[] = [
  { id: 'c1', workspaceId: 'ws_nac', title: 'M0-7 scaffold + tracer', time: 'now', provider: 'claude', model: 'Opus 4.8', agent: 'nac-code', activeConfig: 'standard', attachedIds: ['sk-tdd', 'sk-debug', 'ag-nac', 'in-style', 'fl-readme'], dirty: false, ...base, contextK: 12, windowK: 200, branchedFrom: null },
  { id: 'c2', workspaceId: 'ws_nac', title: 'Cross-provider spike', time: '1h', provider: 'opencode', model: 'qwen3.6-27b', agent: null, activeConfig: null, attachedIds: ['sk-tdd', 'fl-spec'], dirty: true, ...base, contextK: 8, windowK: 32, branchedFrom: null },
  { id: 'c3', workspaceId: 'ws_infra', title: 'Deploy pipeline review', time: '3h', provider: 'codex', model: 'gpt-5-codex', agent: 'infra', activeConfig: 'infra', attachedIds: ['sk-tdd', 'ag-infra', 'in-security', 'fl-deploy'], dirty: false, ...base, contextK: 41, windowK: 128, branchedFrom: null }
]

export const useApp = create<AppState>()((set, get) => ({
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
  // Apply a configuration: set the chat's attachments to exactly that bundle, clear dirty (FR-6.2/6.3).
  applyConfig: (configId) =>
    set((s) => {
      const cfg = CONFIGS_BY_ID[configId]
      if (!cfg) return {}
      const chat = s.chats[s.activeChatId]
      return { chats: { ...s.chats, [s.activeChatId]: { ...chat, attachedIds: [...cfg.itemIds], activeConfig: configId, dirty: false } } }
    }),
  setPalette: (b) => set({ palette: b }),
  togglePalette: () => set((s) => ({ palette: !s.palette })),
  // Manual compaction (FR-9.1/9.2): in-progress → done; reduces context-window usage (~x0.4 in the mock).
  compactChat: () => {
    const id = get().activeChatId
    set((s) => ({ chats: { ...s.chats, [id]: { ...s.chats[id], compacting: true } } }))
    setTimeout(() => {
      set((s) => {
        const c = s.chats[id]
        if (!c) return {}
        return { chats: { ...s.chats, [id]: { ...c, compacting: false, compacted: true, contextK: Math.round(c.contextK * 0.4) } } }
      })
    }, 900)
  },
  // Branch a new chat from the compacted one (FR-9.3): inherits context/config/model/agent; original untouched.
  newFromCompacted: () => {
    const s = get()
    const src = s.chats[s.activeChatId]
    const id = `c_${Date.now()}`
    const branched: Chat = { ...src, id, title: `Compacted · ${src.title}`, time: 'now', dirty: false, compacting: false, compacted: true, branchedFrom: src.id }
    set((st) => ({ chats: { ...st.chats, [id]: branched }, activeChatId: id, view: 'chat' }))
  },
  // New chat (FR-2.3) — seed contract M0-4: inherit provider/model/agent from the active chat; apply Standard.
  newChat: () => {
    const s = get()
    const src = s.chats[s.activeChatId]
    const wsId = src?.workspaceId ?? s.workspaces[0].id
    const id = `c_${Date.now()}`
    const cfg = CONFIGS_BY_ID.standard
    const chat: Chat = {
      id,
      workspaceId: wsId,
      title: 'New chat',
      time: 'now',
      provider: src?.provider ?? 'claude',
      model: src?.model ?? 'Opus 4.8',
      agent: src?.agent ?? null,
      yolo: false,
      thinking: 'medium',
      activeConfig: 'standard',
      attachedIds: [...(cfg?.itemIds ?? [])],
      dirty: false,
      compacting: false,
      compacted: false,
      contextK: 0,
      windowK: src?.windowK ?? 200,
      branchedFrom: null
    }
    set((st) => ({ chats: { ...st.chats, [id]: chat }, activeChatId: id, view: 'chat', expanded: { ...st.expanded, [wsId]: true } }))
  },
  toggleYolo: () => set((s) => ({ chats: { ...s.chats, [s.activeChatId]: { ...s.chats[s.activeChatId], yolo: !s.chats[s.activeChatId].yolo } } })),
  setThinking: (t) => set((s) => ({ chats: { ...s.chats, [s.activeChatId]: { ...s.chats[s.activeChatId], thinking: t } } }))
}))

// --- selectors / helpers ---
export const selectActiveChat = (s: AppState): Chat => s.chats[s.activeChatId]
export const chatsForWorkspace = (chats: Record<string, Chat>, wsId: string): Chat[] =>
  Object.values(chats)
    .filter((c) => c.workspaceId === wsId)
    // Branched chats sit at the top of their workspace group (FR-2.4).
    .sort((a, b) => Number(Boolean(b.branchedFrom)) - Number(Boolean(a.branchedFrom)))
export const workspaceName = (workspaces: Workspace[], id: string): string =>
  workspaces.find((w) => w.id === id)?.name ?? id
