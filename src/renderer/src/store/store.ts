import { create } from 'zustand'
import { CONFIGS_BY_ID } from '../data/configs'
import { modelIdFor } from '../data/providers'
import type { TurnUsage } from '../../../shared/runtime'

// The per-chat state spine (FR-4.1): every chat owns its own provider/model/agent/attached/config/transcript.
// Mutations target a specific chat — nothing is global. Switching chats is lossless (FR-4.2).

export interface WorkspaceDefaults {
  provider?: string
  model?: string
  agent?: string | null
}

export interface Workspace {
  id: string
  name: string
  path: string // project directory; harness runs for this workspace's chats execute here (~ allowed). '' = unbound
  defaults?: WorkspaceDefaults // new chats here inherit these (else fall back to active-chat inheritance — M0-4)
}

// A turn in the provider-neutral transcript (M0-8 source of truth — renders the UI and, later, powers replay).
export interface Turn {
  id: string
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
  error?: boolean
}

// Accumulated metering for a chat, keyed by provider (each provider reports in its own units).
export interface ProviderUsage {
  turns: number
  inputTokens: number
  outputTokens: number
  costUsd: number
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
  messages: Turn[] // conversation transcript (provider-neutral source of truth — M0-8)
  sessionId: string | null // native session id (provider-specific)
  sessionProvider: string | null // which provider owns sessionId (native resume valid only if it matches provider)
  summary: string | null // provider-neutral compaction checkpoint (covers messages[0..summarizedThrough))
  summarizedThrough: number // # of messages folded into summary; replay = summary + messages.slice(this)
  usage: Record<string, ProviderUsage> // accumulated metering, split by provider
}

export type View = 'chat' | 'context' | 'changes'
export type Layout = 'studio' | 'cockpit' | 'focus'
export type ModalKind = 'model' | 'agent' | 'stats' | 'workspace' | null
export type ThinkingLevel = 'none' | 'low' | 'medium' | 'high'

interface AppState {
  workspaces: Workspace[]
  chats: Record<string, Chat>
  activeChatId: string
  view: View
  layout: Layout
  expanded: Record<string, boolean>
  modal: ModalKind
  wsModalId: string | null // workspace targeted by the 'workspace' defaults modal
  palette: boolean

  selectChat: (id: string) => void
  toggleWorkspace: (wsId: string) => void
  addWorkspace: (name: string, path: string) => void
  renameWorkspace: (id: string, name: string) => void
  removeWorkspace: (id: string) => void
  openWorkspaceModal: (id: string) => void
  setWorkspaceDefaults: (id: string, defaults: WorkspaceDefaults | null) => void
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
  newChat: (workspaceId?: string) => void
  toggleYolo: () => void
  setThinking: (t: ThinkingLevel) => void
  // transcript / run lifecycle (driven by AgentEvents) — by chatId so background runs route correctly
  pushTurn: (chatId: string, turn: Turn) => void
  appendDelta: (chatId: string, text: string) => void
  endTurn: (chatId: string, error?: string) => void
  setSession: (chatId: string, sessionId: string, provider: string) => void
  recordUsage: (chatId: string, provider: string, usage: TurnUsage) => void
}

const workspaces: Workspace[] = [
  { id: 'ws_nac', name: 'nac-code', path: '~/Code/nac-code' },
  { id: 'ws_infra', name: 'infra', path: '~/Code/infra' }
]

const base = { yolo: false, thinking: 'medium' as ThinkingLevel, compacting: false, compacted: false, sessionId: null as string | null, sessionProvider: null as string | null, summary: null as string | null, summarizedThrough: 0, usage: {} as Record<string, ProviderUsage> }
const seedChats: Chat[] = [
  { id: 'c1', workspaceId: 'ws_nac', title: 'M0-7 scaffold + tracer', time: 'now', provider: 'claude', model: 'Opus 4.8', agent: 'nac-code', activeConfig: 'standard', attachedIds: ['sk-tdd', 'sk-debug', 'ag-nac', 'in-style', 'fl-readme'], dirty: false, ...base, contextK: 12, windowK: 200, branchedFrom: null, messages: [] },
  { id: 'c2', workspaceId: 'ws_nac', title: 'Cross-provider spike', time: '1h', provider: 'opencode', model: 'qwen3.6-27b (remote)', agent: null, activeConfig: null, attachedIds: ['sk-tdd', 'fl-spec'], dirty: true, ...base, contextK: 8, windowK: 32, branchedFrom: null, messages: [] },
  { id: 'c3', workspaceId: 'ws_infra', title: 'Deploy pipeline review', time: '3h', provider: 'codex', model: 'gpt-5-codex', agent: 'infra', activeConfig: 'infra', attachedIds: ['sk-tdd', 'ag-infra', 'in-security', 'fl-deploy'], dirty: false, ...base, contextK: 41, windowK: 128, branchedFrom: null, messages: [] }
]

const updateLast = (msgs: Turn[], patch: (t: Turn) => Turn): Turn[] => {
  if (msgs.length === 0) return msgs
  const copy = msgs.slice()
  copy[copy.length - 1] = patch(copy[copy.length - 1])
  return copy
}

// Collision-proof chat id (Date.now() alone collides on rapid creates within the same ms).
let chatSeq = 0
const nextChatId = (): string => `c_${Date.now()}_${++chatSeq}`

export const useApp = create<AppState>()((set, get) => ({
  workspaces,
  chats: Object.fromEntries(seedChats.map((c) => [c.id, c])),
  activeChatId: 'c1',
  view: 'chat',
  layout: 'studio',
  expanded: { ws_nac: true, ws_infra: false },
  modal: null,
  wsModalId: null,
  palette: false,

  selectChat: (id) => set({ activeChatId: id }),
  toggleWorkspace: (wsId) => set((s) => ({ expanded: { ...s.expanded, [wsId]: !s.expanded[wsId] } })),
  addWorkspace: (name, path) =>
    set((s) => {
      const id = `ws_${Date.now()}_${++chatSeq}`
      return { workspaces: [...s.workspaces, { id, name: name.trim() || 'workspace', path }], expanded: { ...s.expanded, [id]: true } }
    }),
  renameWorkspace: (id, name) =>
    set((s) => ({ workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, name: name.trim() || w.name } : w)) })),
  removeWorkspace: (id) =>
    set((s) => {
      const hasChats = Object.values(s.chats).some((c) => c.workspaceId === id)
      if (hasChats || s.workspaces.length <= 1) return {} // never remove a non-empty workspace or the last one
      const expanded = { ...s.expanded }
      delete expanded[id]
      return { workspaces: s.workspaces.filter((w) => w.id !== id), expanded }
    }),
  setLayout: (l) => set({ layout: l }),
  setView: (v) => set({ view: v }),
  setModel: (provider, model) =>
    set((s) => ({ chats: { ...s.chats, [s.activeChatId]: { ...s.chats[s.activeChatId], provider, model } } })),
  setAgent: (agent) =>
    set((s) => ({ chats: { ...s.chats, [s.activeChatId]: { ...s.chats[s.activeChatId], agent } } })),
  openModal: (m) => set({ modal: m }),
  closeModal: () => set({ modal: null, wsModalId: null }),
  openWorkspaceModal: (id) => set({ modal: 'workspace', wsModalId: id }),
  setWorkspaceDefaults: (id, defaults) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === id ? { ...w, defaults: defaults === null ? undefined : { ...w.defaults, ...defaults } } : w
      )
    })),
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
  // Real compaction (FR-9): summarize the conversation into a provider-neutral checkpoint, then invalidate
  // the native session so the next send replays `summary + tail` into a fresh one — true compaction on any
  // provider, and bounded cross-provider switches.
  compactChat: () => {
    const id = get().activeChatId
    const chat = get().chats[id]
    if (!chat || chat.compacting) return
    const through = chat.messages.length
    const tail = chat.messages.slice(chat.summarizedThrough).filter((t) => t.text.trim())
    const context = [chat.summary ? `Summary so far:\n${chat.summary}` : '', ...tail.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`)]
      .filter(Boolean)
      .join('\n\n')
    set((s) => ({ chats: { ...s.chats, [id]: { ...s.chats[id], compacting: true } } }))
    const finish = (summary: string | null): void =>
      set((s) => {
        const c = s.chats[id]
        if (!c) return {}
        if (!summary) return { chats: { ...s.chats, [id]: { ...c, compacting: false } } } // abort, leave transcript intact
        return {
          chats: {
            ...s.chats,
            [id]: { ...c, compacting: false, compacted: true, summary, summarizedThrough: through, sessionId: null, sessionProvider: null, contextK: Math.max(1, Math.round(summary.length / 4000)) }
          }
        }
      })
    if (!context || !window.nac?.runs?.summarize) {
      finish(null)
      return
    }
    void window.nac.runs
      .summarize({ text: context, provider: chat.provider, model: modelIdFor(chat.provider, chat.model) })
      .then((r) => finish(r?.summary?.trim() ? r.summary.trim() : null))
      .catch(() => finish(null))
  },
  newFromCompacted: () => {
    const s = get()
    const src = s.chats[s.activeChatId]
    const id = nextChatId()
    const branched: Chat = { ...src, id, title: `Compacted · ${src.title}`, time: 'now', dirty: false, compacting: false, compacted: true, branchedFrom: src.id, messages: [...src.messages], sessionId: null, sessionProvider: null, usage: {} }
    set((st) => ({ chats: { ...st.chats, [id]: branched }, activeChatId: id, view: 'chat' }))
  },
  newChat: (workspaceId) => {
    const s = get()
    const src = s.chats[s.activeChatId]
    const wsId = workspaceId ?? src?.workspaceId ?? s.workspaces[0].id
    const wsDefaults = s.workspaces.find((w) => w.id === wsId)?.defaults
    const id = nextChatId()
    const cfg = CONFIGS_BY_ID.standard
    const chat: Chat = {
      id,
      workspaceId: wsId,
      title: 'New chat',
      time: 'now',
      provider: wsDefaults?.provider ?? src?.provider ?? 'claude',
      model: wsDefaults?.model ?? src?.model ?? 'Opus 4.8',
      agent: wsDefaults?.agent !== undefined ? wsDefaults.agent : src?.agent ?? null,
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
      sessionId: null,
      sessionProvider: null,
      summary: null,
      summarizedThrough: 0,
      usage: {}
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
  setSession: (chatId, sessionId, provider) =>
    set((s) => {
      const c = s.chats[chatId]
      if (!c) return {}
      return { chats: { ...s.chats, [chatId]: { ...c, sessionId, sessionProvider: provider } } }
    }),
  recordUsage: (chatId, provider, u) =>
    set((s) => {
      const c = s.chats[chatId]
      if (!c) return {}
      const prev = c.usage[provider] ?? { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
      const next = {
        turns: prev.turns + 1,
        inputTokens: prev.inputTokens + (u.inputTokens ?? 0),
        outputTokens: prev.outputTokens + (u.outputTokens ?? 0),
        costUsd: prev.costUsd + (u.costUsd ?? 0)
      }
      return { chats: { ...s.chats, [chatId]: { ...c, usage: { ...c.usage, [provider]: next } } } }
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
