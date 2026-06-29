import { create } from 'zustand'
import { CONFIGS_BY_ID } from '../data/configs'

// The per-chat state spine (FR-4.1): every chat owns its own provider/model/agent/attached/config/transcript.
// Mutations target a specific chat — nothing is global. Switching chats is lossless (FR-4.2).

export interface Workspace {
  id: string
  name: string
}

// A turn in the provider-neutral transcript (M0-8 source of truth — renders the UI and, later, powers replay).
export interface Turn {
  id: string
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
  error?: boolean
}

export interface Chat {
  id: string
  workspaceId: string
  title: string
  time: string
  provider: string // harness driver id (claude | codex | cursor | opencode)
  model: string
  agent: string | null
  yolo: boolean
  thinking: ThinkingLevel
  activeConfig: string | null
  attachedIds: string[]
  dirty: boolean
  compacting: boolean
  compacted: boolean
  contextK: number
  windowK: number
  branchedFrom: string | null
  messages: Turn[] // conversation transcript
  claudeSessionId: string | null // native session id for Claude --resume (FR-4.2 fast-path)
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
  // transcript / run lifecycle (driven by AgentEvents) — by chatId so background runs route correctly
  pushTurn: (chatId: string, turn: Turn) => void
  appendDelta: (chatId: string, text: string) => void
  endTurn: (chatId: string, error?: string) => void
  setSession: (chatId: string, sessionId: string) => void
}

const workspaces: Workspace[] = [
  { id: 'ws_nac', name: 'nac-code' },
  { id: 'ws_infra', name: 'infra' }
]

const base = { yolo: false, thinking: 'medium' as ThinkingLevel, compacting: false, compacted: false, claudeSessionId: null }
const seedChats: Chat[] = [
  { id: 'c1', workspaceId: 'ws_nac', title: 'M0-7 scaffold + tracer', time: 'now', provider: 'claude', model: 'Opus 4.8', agent: 'nac-code', activeConfig: 'standard', attachedIds: ['sk-tdd', 'sk-debug', 'ag-nac', 'in-style', 'fl-readme'], dirty: false, ...base, contextK: 12, windowK: 200, branchedFrom: null, messages: [] },
  { id: 'c2', workspaceId: 'ws_nac', title: 'Cross-provider spike', time: '1h', provider: 'opencode', model: 'qwen3.6-27b', agent: null, activeConfig: null, attachedIds: ['sk-tdd', 'fl-spec'], dirty: true, ...base, contextK: 8, windowK: 32, branchedFrom: null, messages: [] },
  { id: 'c3', workspaceId: 'ws_infra', title: 'Deploy pipeline review', time: '3h', provider: 'codex', model: 'gpt-5-codex', agent: 'infra', activeConfig: 'infra', attachedIds: ['sk-tdd', 'ag-infra', 'in-security', 'fl-deploy'], dirty: false, ...base, contextK: 41, windowK: 128, branchedFrom: null, messages: [] }
]

const updateLast = (msgs: Turn[], patch: (t: Turn) => Turn): Turn[] => {
  if (msgs.length === 0) return msgs
  const copy = msgs.slice()
  copy[copy.length - 1] = patch(copy[copy.length - 1])
  return copy
}

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
      return { chats: { ...s.chats, [s.activeChatId]: { ...chat, attachedIds, dirty: true } } }
    }),
  applyConfig: (configId) =>
    set((s) => {
      const cfg = CONFIGS_BY_ID[configId]
      if (!cfg) return {}
      const chat = s.chats[s.activeChatId]
      return { chats: { ...s.chats, [s.activeChatId]: { ...chat, attachedIds: [...cfg.itemIds], activeConfig: configId, dirty: false } } }
    }),
  setPalette: (b) => set({ palette: b }),
  togglePalette: () => set((s) => ({ palette: !s.palette })),
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
  newFromCompacted: () => {
    const s = get()
    const src = s.chats[s.activeChatId]
    const id = `c_${Date.now()}`
    const branched: Chat = { ...src, id, title: `Compacted · ${src.title}`, time: 'now', dirty: false, compacting: false, compacted: true, branchedFrom: src.id, messages: [...src.messages], claudeSessionId: null }
    set((st) => ({ chats: { ...st.chats, [id]: branched }, activeChatId: id, view: 'chat' }))
  },
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
      branchedFrom: null,
      messages: [],
      claudeSessionId: null
    }
    set((st) => ({ chats: { ...st.chats, [id]: chat }, activeChatId: id, view: 'chat', expanded: { ...st.expanded, [wsId]: true } }))
  },
  toggleYolo: () => set((s) => ({ chats: { ...s.chats, [s.activeChatId]: { ...s.chats[s.activeChatId], yolo: !s.chats[s.activeChatId].yolo } } })),
  setThinking: (t) => set((s) => ({ chats: { ...s.chats, [s.activeChatId]: { ...s.chats[s.activeChatId], thinking: t } } })),

  pushTurn: (chatId, turn) =>
    set((s) => {
      const c = s.chats[chatId]
      if (!c) return {}
      return { chats: { ...s.chats, [chatId]: { ...c, messages: [...c.messages, turn] } } }
    }),
  appendDelta: (chatId, text) =>
    set((s) => {
      const c = s.chats[chatId]
      if (!c) return {}
      return { chats: { ...s.chats, [chatId]: { ...c, messages: updateLast(c.messages, (t) => ({ ...t, text: t.text + text })) } } }
    }),
  endTurn: (chatId, error) =>
    set((s) => {
      const c = s.chats[chatId]
      if (!c) return {}
      const messages = updateLast(c.messages, (t) => ({ ...t, streaming: false, error: Boolean(error), text: error ? `${t.text}\n[error] ${error}` : t.text }))
      return { chats: { ...s.chats, [chatId]: { ...c, messages } } }
    }),
  setSession: (chatId, sessionId) =>
    set((s) => {
      const c = s.chats[chatId]
      if (!c) return {}
      return { chats: { ...s.chats, [chatId]: { ...c, claudeSessionId: sessionId } } }
    })
}))

// --- selectors / helpers ---
export const selectActiveChat = (s: AppState): Chat => s.chats[s.activeChatId]
export const chatsForWorkspace = (chats: Record<string, Chat>, wsId: string): Chat[] =>
  Object.values(chats)
    .filter((c) => c.workspaceId === wsId)
    .sort((a, b) => Number(Boolean(b.branchedFrom)) - Number(Boolean(a.branchedFrom)))
export const workspaceName = (workspaces: Workspace[], id: string): string =>
  workspaces.find((w) => w.id === id)?.name ?? id
