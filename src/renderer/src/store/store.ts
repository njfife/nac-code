import { create } from 'zustand'
import { CONFIGS_BY_ID } from '../data/configs'
import { STATIC_CAPABILITIES, effortScaleFor, modelIdFor, windowKFor } from '../../../shared/capabilities'
import type { ContextItem } from '../data/context'
import type { TurnUsage, ProviderCapabilities, PermissionOption } from '../../../shared/runtime'

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

export interface ToolRow {
  toolCallId: string
  title: string
  kind?: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  detail?: string
}
export interface PermissionCard {
  requestId: string
  title: string
  detail?: string
  options: PermissionOption[]
  resolvedOptionId?: string
}

// A turn in the provider-neutral transcript (M0-8 source of truth — renders the UI and, later, powers replay).
export interface Turn {
  id: string
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
  error?: boolean
  tools?: ToolRow[] // render-only history — NEVER read by buildReplayPrompt
  permissions?: PermissionCard[]
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
  provider: string // harness driver id (claude | codex | copilot | opencode)
  model: string
  agent: string | null
  yolo: boolean
  fast: boolean // Claude fast mode (research preview); injected per-run via --settings
  effort: string | null // reasoning depth; null = harness default. Values come from discovered capabilities
  activeConfig: string | null
  attachedIds: string[]
  dirty: boolean
  compacting: boolean
  compacted: boolean
  contextK: number
  windowK: number
  contextLive?: boolean // context bar shows REAL harness-reported numbers (codex app-server); reset on hydrate/provider switch
  branchedFrom: string | null
  messages: Turn[] // conversation transcript (provider-neutral source of truth — M0-8)
  sessionId: string | null // native session id (provider-specific)
  sessionProvider: string | null // which provider owns sessionId (native resume valid only if it matches provider)
  summary: string | null // provider-neutral compaction checkpoint (covers messages[0..summarizedThrough))
  summarizedThrough: number // # of messages folded into summary; replay = summary + messages.slice(this)
  usage: Record<string, ProviderUsage> // accumulated metering, split by provider
  seededAttachments: string[] | null // attachedIds present when the live session was last seeded (null = not seeded)
}

export type View = 'chat' | 'context' | 'changes'
export type Layout = 'studio' | 'cockpit' | 'focus'
export type ModalKind = 'model' | 'agent' | 'stats' | 'workspace' | null

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
  caps: Record<string, ProviderCapabilities>

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
  toggleFast: () => void
  setEffort: (e: string | null) => void
  loadCaps: (provider: string, refresh?: boolean) => Promise<void>
  // transcript / run lifecycle (driven by AgentEvents) — by chatId so background runs route correctly
  pushTurn: (chatId: string, turn: Turn) => void
  appendDelta: (chatId: string, text: string) => void
  endTurn: (chatId: string, error?: string) => void
  setSession: (chatId: string, sessionId: string, provider: string) => void
  recordUsage: (chatId: string, provider: string, usage: TurnUsage) => void
  setLiveContext: (chatId: string, usedTokens: number, windowTokens?: number) => void
  upsertTool: (chatId: string, row: ToolRow) => void
  upsertPermission: (chatId: string, card: PermissionCard) => void
  resolvePermission: (chatId: string, requestId: string, optionId: string) => void
  // user-authored context library items (notes + files), persisted
  userItems: ContextItem[]
  addNote: (name: string, content: string) => void
  addFileItem: (name: string, path: string) => void
  removeUserItem: (id: string) => void
  markSeeded: (chatId: string, attachedIds: string[]) => void
  reseedContext: (chatId: string) => void
}

// Fresh installs boot empty: one unbound workspace, no chats — nothing on screen that isn't real
// (the empty-state UX in LeftRail/ChatView/Shell/Inspector covers the rest).
const workspaces: Workspace[] = [{ id: 'ws_default', name: 'Workspace', path: '' }]

const updateLast = (msgs: Turn[], patch: (t: Turn) => Turn): Turn[] => {
  if (msgs.length === 0) return msgs
  const copy = msgs.slice()
  copy[copy.length - 1] = patch(copy[copy.length - 1])
  return copy
}

// Tool/permission events may arrive after endTurn (expiry fires post-completion) or after the user's
// next message — target the last ASSISTANT turn, never whatever happens to be last.
const updateLastAssistant = (msgs: Turn[], patch: (t: Turn) => Turn): Turn[] => {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant') {
      const copy = msgs.slice()
      copy[i] = patch(copy[i])
      return copy
    }
  }
  return msgs
}

// Collision-proof chat id (Date.now() alone collides on rapid creates within the same ms).
let chatSeq = 0
const nextChatId = (): string => `c_${Date.now()}_${++chatSeq}`

export const useApp = create<AppState>()((set, get) => ({
  workspaces,
  chats: {},
  activeChatId: '',
  view: 'chat',
  layout: 'studio',
  expanded: { ws_default: true },
  modal: null,
  wsModalId: null,
  palette: false,
  caps: { ...STATIC_CAPABILITIES },
  userItems: [],

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
    set((s) => {
      const chat = s.chats[s.activeChatId]
      if (!chat) return {}
      const scale = effortScaleFor(s.caps[provider], model)
      // Effort scales aren't portable: reset on provider switch, and clamp to the new model's scale.
      const effort = provider !== chat.provider ? null : chat.effort && !scale.includes(chat.effort) ? null : chat.effort
      const contextLive = provider !== chat.provider ? false : chat.contextLive
      const windowK = windowKFor(provider, model, s.caps[provider])
      return { chats: { ...s.chats, [s.activeChatId]: { ...chat, provider, model, effort, contextLive, windowK } } }
    }),
  setAgent: (agent) =>
    set((s) => {
      const chat = s.chats[s.activeChatId]
      if (!chat) return {}
      return { chats: { ...s.chats, [s.activeChatId]: { ...chat, agent } } }
    }),
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
      if (!chat) return {}
      const has = chat.attachedIds.includes(itemId)
      const attachedIds = has ? chat.attachedIds.filter((id) => id !== itemId) : [...chat.attachedIds, itemId]
      return { chats: { ...s.chats, [s.activeChatId]: { ...chat, attachedIds, dirty: true } } }
    }),
  applyConfig: (configId) =>
    set((s) => {
      const cfg = CONFIGS_BY_ID[configId]
      const chat = s.chats[s.activeChatId]
      if (!cfg || !chat) return {}
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
      .summarize({ text: context, provider: chat.provider, model: modelIdFor(chat.provider, chat.model, get().caps[chat.provider]) })
      .then((r) => finish(r?.summary?.trim() ? r.summary.trim() : null))
      .catch(() => finish(null))
  },
  newFromCompacted: () => {
    const s = get()
    const src = s.chats[s.activeChatId]
    const id = nextChatId()
    const branched: Chat = { ...src, id, title: `Compacted · ${src.title}`, time: 'now', dirty: false, compacting: false, compacted: true, branchedFrom: src.id, messages: [...src.messages], sessionId: null, sessionProvider: null, usage: {}, seededAttachments: null }
    set((st) => ({ chats: { ...st.chats, [id]: branched }, activeChatId: id, view: 'chat' }))
  },
  newChat: (workspaceId) => {
    const s = get()
    const src = s.chats[s.activeChatId]
    const wsId = workspaceId ?? src?.workspaceId ?? s.workspaces[0].id
    const wsDefaults = s.workspaces.find((w) => w.id === wsId)?.defaults
    const id = nextChatId()
    const cfg = CONFIGS_BY_ID.standard
    const provider = wsDefaults?.provider ?? src?.provider ?? 'claude'
    const model = wsDefaults?.model ?? src?.model ?? 'Opus 4.8'
    const chat: Chat = {
      id,
      workspaceId: wsId,
      title: 'New chat',
      time: 'now',
      provider,
      model,
      agent: wsDefaults?.agent !== undefined ? wsDefaults.agent : src?.agent ?? null,
      yolo: false,
      fast: false,
      effort: null,
      activeConfig: 'standard',
      attachedIds: [...(cfg?.itemIds ?? [])],
      dirty: false,
      compacting: false,
      compacted: false,
      contextK: 0,
      windowK: windowKFor(provider, model, s.caps[provider]),
      branchedFrom: null,
      messages: [],
      sessionId: null,
      sessionProvider: null,
      summary: null,
      summarizedThrough: 0,
      usage: {},
      seededAttachments: null
    }
    set((st) => ({ chats: { ...st.chats, [id]: chat }, activeChatId: id, view: 'chat', expanded: { ...st.expanded, [wsId]: true } }))
  },
  toggleYolo: () =>
    set((s) => {
      const chat = s.chats[s.activeChatId]
      if (!chat) return {}
      return { chats: { ...s.chats, [s.activeChatId]: { ...chat, yolo: !chat.yolo } } }
    }),
  toggleFast: () =>
    set((s) => {
      const chat = s.chats[s.activeChatId]
      if (!chat) return {}
      return { chats: { ...s.chats, [s.activeChatId]: { ...chat, fast: !chat.fast } } }
    }),
  setEffort: (e) =>
    set((s) => {
      const chat = s.chats[s.activeChatId]
      if (!chat) return {}
      return { chats: { ...s.chats, [s.activeChatId]: { ...chat, effort: e } } }
    }),
  loadCaps: async (provider, refresh) => {
    if (!window.nac?.capabilities) return
    try {
      const caps = await window.nac.capabilities.get(provider, refresh)
      set((s) => ({ caps: { ...s.caps, [provider]: caps } }))
    } catch {
      // keep the current (static) entry
    }
  },

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
      // Interrupted/errored turns can leave tool rows mid-flight (codex turn/interrupt never
      // completes the open item) — same doctrine as the hydration sanitizer: nothing stays
      // live-looking once the run is over.
      const messages = updateLast(c.messages, (t) => ({
        ...t,
        streaming: false,
        error: Boolean(error),
        text: error ? `${t.text}\n[error] ${error}` : t.text,
        tools: t.tools?.map((x) => (x.status === 'pending' || x.status === 'running' ? { ...x, status: 'failed' as const } : x))
      }))
      // A fallback turn ran one-shot: no usage.updated arrived, so the last live context number is
      // stale — demote it to an estimate (the ~ returns) until the transport recovers.
      const fellBack = messages.at(-1)?.tools?.some((x) => x.toolCallId.startsWith('fallback_')) === true
      return { chats: { ...s.chats, [chatId]: { ...c, messages, ...(fellBack ? { contextLive: false } : {}) } } }
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
    }),
  setLiveContext: (chatId, usedTokens, windowTokens) =>
    set((s) => {
      const c = s.chats[chatId]
      if (!c || usedTokens <= 0) return {}
      return {
        chats: {
          ...s.chats,
          [chatId]: {
            ...c,
            contextK: Math.max(1, Math.round(usedTokens / 1000)),
            windowK: windowTokens && windowTokens > 0 ? Math.round(windowTokens / 1000) : c.windowK,
            contextLive: true
          }
        }
      }
    }),
  upsertTool: (chatId, row) =>
    set((s) => {
      const c = s.chats[chatId]
      if (!c) return {}
      const messages = updateLastAssistant(c.messages, (t) => {
        const tools = t.tools ? [...t.tools] : []
        const i = tools.findIndex((x) => x.toolCallId === row.toolCallId)
        // Completion events may carry no title (claude tool_result frames) — never let an empty
        // title clobber the running row's.
        if (i >= 0) tools[i] = { ...tools[i], ...row, title: row.title || tools[i].title }
        else tools.push(row)
        return { ...t, tools }
      })
      return { chats: { ...s.chats, [chatId]: { ...c, messages } } }
    }),
  upsertPermission: (chatId, card) =>
    set((s) => {
      const c = s.chats[chatId]
      if (!c) return {}
      const messages = updateLastAssistant(c.messages, (t) => {
        const permissions = t.permissions ? [...t.permissions] : []
        const i = permissions.findIndex((x) => x.requestId === card.requestId)
        if (i >= 0) permissions[i] = { ...permissions[i], ...card }
        else permissions.push(card)
        return { ...t, permissions }
      })
      return { chats: { ...s.chats, [chatId]: { ...c, messages } } }
    }),
  resolvePermission: (chatId, requestId, optionId) =>
    set((s) => {
      const c = s.chats[chatId]
      if (!c) return {}
      const messages = updateLastAssistant(c.messages, (t) => ({
        ...t,
        permissions: (t.permissions ?? []).map((p) => (p.requestId === requestId ? { ...p, resolvedOptionId: optionId } : p))
      }))
      return { chats: { ...s.chats, [chatId]: { ...c, messages } } }
    }),
  addNote: (name, content) =>
    set((s) => ({
      userItems: [...s.userItems, { id: `u_${Date.now()}_${++chatSeq}`, type: 'instruction', name: name.trim() || 'note', description: content.trim().slice(0, 80), tokens: Math.ceil(content.length / 4), scope: 'workspace', source: 'user', tags: ['note'], content, user: true }]
    })),
  addFileItem: (name, path) =>
    set((s) => ({
      userItems: [...s.userItems, { id: `u_${Date.now()}_${++chatSeq}`, type: 'file', name: name.trim() || path.split('/').pop() || 'file', description: path, tokens: 0, scope: 'workspace', source: 'file', tags: ['file'], path, user: true }]
    })),
  removeUserItem: (id) =>
    set((s) => ({
      userItems: s.userItems.filter((i) => i.id !== id),
      chats: Object.fromEntries(Object.entries(s.chats).map(([cid, c]) => [cid, { ...c, attachedIds: c.attachedIds.filter((a) => a !== id) }]))
    })),
  markSeeded: (chatId, ids) =>
    set((s) => {
      const c = s.chats[chatId]
      if (!c) return {}
      return { chats: { ...s.chats, [chatId]: { ...c, seededAttachments: [...ids] } } }
    }),
  reseedContext: (chatId) =>
    set((s) => {
      const c = s.chats[chatId]
      if (!c) return {}
      // Drop the native session so the next send replays with the current attachments (re-seeds context).
      return { chats: { ...s.chats, [chatId]: { ...c, sessionId: null, sessionProvider: null } } }
    })
}))

// --- selectors / helpers ---
export const selectActiveChat = (s: AppState): Chat | undefined => s.chats[s.activeChatId]
// True when attachments changed since the live session was seeded — they apply on the next re-seed (FR-5).
export function contextPending(chat: Chat): boolean {
  if (!chat.sessionId || chat.sessionProvider !== chat.provider || chat.seededAttachments === null) return false
  const seeded = new Set(chat.seededAttachments)
  return chat.attachedIds.length !== seeded.size || chat.attachedIds.some((id) => !seeded.has(id))
}
export const chatsForWorkspace = (chats: Record<string, Chat>, wsId: string): Chat[] =>
  Object.values(chats)
    .filter((c) => c.workspaceId === wsId)
    .sort((a, b) => Number(Boolean(b.branchedFrom)) - Number(Boolean(a.branchedFrom)))
export const workspaceName = (workspaces: Workspace[], id: string): string =>
  workspaces.find((w) => w.id === id)?.name ?? id
