import { describe, it, expect, beforeEach } from 'vitest'
import { useApp, chatsForWorkspace, contextPending } from './store'

// Fresh-install empty state (sweep Task 2): no demo workspaces/chats ship — the store boots with one
// unbound workspace and zero chats. This describe runs before any other test in the file mutates the
// (file-scoped) store module, so it observes the true fresh-load state.
describe('app store — fresh install (Task 2)', () => {
  it('fresh state has one empty workspace and no chats', () => {
    expect(useApp.getState().workspaces.some((w) => w.id === 'ws_default')).toBe(true)
    expect(Object.keys(useApp.getState().chats).length).toBe(0)
    expect(useApp.getState().activeChatId).toBe('')
  })

  it('newChat works from the empty state (first-chat flow)', () => {
    const s = useApp.getState()
    s.newChat()
    expect(Object.keys(useApp.getState().chats).length).toBeGreaterThan(0)
    expect(useApp.getState().activeChatId).not.toBe('')
  })
})

// Guards the FR-4.1 invariant (mutations affect only the active chat) and FR-9.3 branching.
describe('app store — per-chat spine', () => {
  // No seeded chats ship anymore — ensure there's always at least one chat to act on, and make it active.
  beforeEach(() => {
    const s = useApp.getState()
    if (Object.keys(s.chats).length === 0) s.newChat()
    useApp.getState().selectChat(Object.keys(useApp.getState().chats)[0])
  })

  it('setModel affects only the active chat (FR-4.1)', () => {
    const s = useApp.getState()
    const first = s.activeChatId
    s.newChat()
    const second = useApp.getState().activeChatId
    const otherBefore = useApp.getState().chats[first].model
    useApp.getState().selectChat(second)
    useApp.getState().setModel('codex', 'gpt-5-codex')
    expect(useApp.getState().chats[second].model).toBe('gpt-5-codex')
    expect(useApp.getState().chats[first].model).toBe(otherBefore) // untouched
  })

  it('setModel reseeds windowK from the model table (stale denominators die)', () => {
    const s = useApp.getState()
    s.setModel('claude', 'Sonnet 4.6 · 1M')
    expect(useApp.getState().chats[s.activeChatId].windowK).toBe(1000)
    s.setModel('claude', 'Opus 4.8')
    expect(useApp.getState().chats[s.activeChatId].windowK).toBe(200)
  })

  it('toggleAttach toggles membership and marks the chat dirty (FR-5.5 / FR-6.4)', () => {
    const id = useApp.getState().activeChatId
    const had = useApp.getState().chats[id].attachedIds.includes('in-security')
    useApp.getState().toggleAttach('in-security')
    expect(useApp.getState().chats[id].attachedIds.includes('in-security')).toBe(!had)
    expect(useApp.getState().chats[id].dirty).toBe(true)
  })

  it('newFromCompacted branches a new active chat and leaves the original intact (FR-9.3)', () => {
    const s = useApp.getState()
    const srcId = s.activeChatId
    const wsId = s.chats[srcId].workspaceId
    const n0 = Object.keys(s.chats).length
    s.newFromCompacted()
    const s2 = useApp.getState()
    expect(Object.keys(s2.chats).length).toBe(n0 + 1)
    const active = s2.chats[s2.activeChatId]
    expect(active.branchedFrom).toBe(srcId)
    expect(active.title).toContain('Compacted ·')
    expect(s2.chats[srcId].branchedFrom).toBeNull() // original untouched
    // branched chats sort to the top of their workspace group (FR-2.4)
    expect(chatsForWorkspace(s2.chats, wsId)[0].branchedFrom).not.toBeNull()
  })

  it('applyConfig replaces the attached set and clears dirty (FR-6.3)', () => {
    const s = useApp.getState()
    s.newChat()
    const id = useApp.getState().activeChatId
    s.toggleAttach('sk-tdd') // dirty it, same as a seeded-dirty chat used to be
    expect(useApp.getState().chats[id].dirty).toBe(true)
    s.applyConfig('minimal')
    const c = useApp.getState().chats[id]
    expect(c.attachedIds).toEqual(['in-style'])
    expect(c.activeConfig).toBe('minimal')
    expect(c.dirty).toBe(false)
  })

  it('newChat seeds from the active chat and applies Standard (FR-2.3 / M0-4)', () => {
    const s = useApp.getState()
    s.addWorkspace('infra', '/infra')
    const infra = useApp.getState().workspaces.find((w) => w.name === 'infra')!
    s.newChat(infra.id) // active chat now lives in the infra workspace
    s.setModel('codex', 'gpt-5-codex')
    const n0 = Object.keys(useApp.getState().chats).length
    useApp.getState().newChat()
    const s2 = useApp.getState()
    expect(Object.keys(s2.chats).length).toBe(n0 + 1)
    const active = s2.chats[s2.activeChatId]
    expect(active.title).toBe('New chat')
    expect(active.provider).toBe('codex') // inherited from the active chat
    expect(active.workspaceId).toBe(infra.id)
    expect(active.activeConfig).toBe('standard')
    expect(active.contextK).toBe(0)
  })

  it('addWorkspace appends a folder-bound workspace and expands it', () => {
    const n0 = useApp.getState().workspaces.length
    useApp.getState().addWorkspace('proj', '/Users/x/proj')
    const s = useApp.getState()
    expect(s.workspaces.length).toBe(n0 + 1)
    const ws = s.workspaces[s.workspaces.length - 1]
    expect(ws.name).toBe('proj')
    expect(ws.path).toBe('/Users/x/proj')
    expect(s.expanded[ws.id]).toBe(true)
  })

  it('removeWorkspace drops an empty workspace but never one with chats', () => {
    const s = useApp.getState()
    s.addWorkspace('empty', '/tmp/empty')
    const empty = useApp.getState().workspaces.find((w) => w.name === 'empty')!
    s.removeWorkspace(empty.id)
    expect(useApp.getState().workspaces.find((w) => w.id === empty.id)).toBeUndefined()
    // any workspace holding a chat right now is blocked from removal — there is always at least one
    // (the active chat's workspace), since beforeEach guarantees a chat exists.
    const nonEmpty = useApp.getState().workspaces.find((w) => Object.values(useApp.getState().chats).some((c) => c.workspaceId === w.id))!
    const before = useApp.getState().workspaces.length
    s.removeWorkspace(nonEmpty.id)
    expect(useApp.getState().workspaces.length).toBe(before)
    expect(useApp.getState().workspaces.find((w) => w.id === nonEmpty.id)).toBeDefined()
  })

  it('newChat(workspaceId) inherits that workspace’s defaults over the active chat (M0-4)', () => {
    useApp.getState().addWorkspace('proj', '/p')
    const proj = useApp.getState().workspaces.find((w) => w.name === 'proj')!
    useApp.getState().setWorkspaceDefaults(proj.id, { provider: 'codex', model: 'gpt-5-codex' })
    // the active chat (from beforeEach) is in a different workspace than the freshly-created 'proj'
    useApp.getState().newChat(proj.id)
    const active = useApp.getState().chats[useApp.getState().activeChatId]
    expect(active.workspaceId).toBe(proj.id)
    expect(active.provider).toBe('codex')
    expect(active.model).toBe('gpt-5-codex')
  })

  it('setWorkspaceDefaults merges partials and clears with null', () => {
    useApp.getState().addWorkspace('p2', '/p2')
    const p2 = useApp.getState().workspaces.find((w) => w.name === 'p2')!
    useApp.getState().setWorkspaceDefaults(p2.id, { provider: 'claude' })
    useApp.getState().setWorkspaceDefaults(p2.id, { model: 'Opus 4.8' })
    expect(useApp.getState().workspaces.find((w) => w.id === p2.id)!.defaults).toEqual({ provider: 'claude', model: 'Opus 4.8' })
    useApp.getState().setWorkspaceDefaults(p2.id, null)
    expect(useApp.getState().workspaces.find((w) => w.id === p2.id)!.defaults).toBeUndefined()
  })

  it('recordUsage accumulates per provider (FR-11)', () => {
    const id = useApp.getState().activeChatId
    useApp.getState().recordUsage(id, 'claude', { inputTokens: 100, outputTokens: 20, costUsd: 0.05 })
    useApp.getState().recordUsage(id, 'claude', { inputTokens: 50, outputTokens: 10, costUsd: 0.02 })
    useApp.getState().recordUsage(id, 'codex', { inputTokens: 200, outputTokens: 0 })
    const u = useApp.getState().chats[id].usage
    expect(u.claude.turns).toBe(2)
    expect(u.claude.inputTokens).toBe(150)
    expect(u.claude.outputTokens).toBe(30)
    expect(u.claude.costUsd).toBeCloseTo(0.07)
    expect(u.codex).toEqual({ turns: 1, inputTokens: 200, outputTokens: 0, costUsd: 0 })
  })

  it('addNote creates an injectable user item (FR-5)', () => {
    const n0 = useApp.getState().userItems.length
    useApp.getState().addNote('api-rules', 'Always validate input.')
    const items = useApp.getState().userItems
    expect(items.length).toBe(n0 + 1)
    const note = items[items.length - 1]
    expect(note.name).toBe('api-rules')
    expect(note.content).toBe('Always validate input.')
    expect(note.user).toBe(true)
    expect(note.type).toBe('instruction')
  })

  it('contextPending flags attachment changes after a session is seeded (FR-5)', () => {
    const id = useApp.getState().activeChatId
    const prov = useApp.getState().chats[id].provider
    useApp.getState().setSession(id, 'sess1', prov)
    useApp.getState().markSeeded(id, useApp.getState().chats[id].attachedIds)
    expect(contextPending(useApp.getState().chats[id])).toBe(false)
    useApp.getState().toggleAttach('in-security') // changes the attached set
    expect(contextPending(useApp.getState().chats[id])).toBe(true)
    useApp.getState().reseedContext(id) // drops the session -> applies on next send
    expect(contextPending(useApp.getState().chats[id])).toBe(false)
  })

  it('toggleFast flips fast on the active chat only', () => {
    const before = useApp.getState()
    const id = before.activeChatId
    expect(before.chats[id].fast).toBe(false)
    before.toggleFast()
    const after = useApp.getState()
    expect(after.chats[id].fast).toBe(true)
    for (const [cid, c] of Object.entries(after.chats)) if (cid !== id) expect(c.fast).toBe(false)
  })

  it('setEffort sets the active chat effort; provider switch resets it to null', () => {
    const s = useApp.getState()
    s.setEffort('xhigh')
    expect(useApp.getState().chats[useApp.getState().activeChatId].effort).toBe('xhigh')
    const chat = useApp.getState().chats[useApp.getState().activeChatId]
    const otherProvider = chat.provider === 'claude' ? 'codex' : 'claude'
    s.setModel(otherProvider, 'Account default')
    expect(useApp.getState().chats[useApp.getState().activeChatId].effort).toBeNull()
  })

  it('same-provider model switch clamps effort to the new model scale', () => {
    const s = useApp.getState()
    const chat = s.chats[s.activeChatId]
    // Seed caps: current model supports 'xhigh', the switch target does not.
    useApp.setState({
      caps: {
        ...s.caps,
        [chat.provider]: {
          provider: chat.provider,
          source: 'protocol',
          efforts: ['low', 'medium', 'high'],
          fetchedAt: 1,
          models: [
            { id: 'm1', label: chat.model, efforts: ['low', 'medium', 'high', 'xhigh'] },
            { id: 'm2', label: 'Other Model', efforts: ['low', 'medium'] }
          ]
        }
      }
    })
    s.setEffort('xhigh')
    s.setModel(chat.provider, 'Other Model')
    expect(useApp.getState().chats[s.activeChatId].effort).toBeNull() // xhigh not in m2's scale
    s.setEffort('low')
    s.setModel(chat.provider, chat.model)
    expect(useApp.getState().chats[s.activeChatId].effort).toBe('low') // still valid → kept
  })

  it('upsertTool merges by toolCallId on the streaming turn', () => {
    const s = useApp.getState()
    const id = s.activeChatId
    s.pushTurn(id, { id: 'a1', role: 'assistant', text: '', streaming: true })
    s.upsertTool(id, { toolCallId: 't1', title: 'Run x', status: 'pending', detail: 'x' })
    s.upsertTool(id, { toolCallId: 't1', title: 'Run x', status: 'completed', detail: 'done' })
    const turn = useApp.getState().chats[id].messages.at(-1)!
    expect(turn.tools).toEqual([{ toolCallId: 't1', title: 'Run x', status: 'completed', detail: 'done' }])
  })

  it('endTurn sweeps still-open tools to failed (interrupted turn leaves no live spinner)', () => {
    const s = useApp.getState()
    const id = s.activeChatId
    s.pushTurn(id, { id: 'a8', role: 'assistant', text: '', streaming: true })
    s.upsertTool(id, { toolCallId: 'r1', title: 'sleep 40', kind: 'execute', status: 'running' })
    s.upsertTool(id, { toolCallId: 'r2', title: 'touch x', kind: 'execute', status: 'completed' })
    s.endTurn(id)
    const turn = useApp.getState().chats[id].messages.at(-1)!
    expect(turn.tools?.find((t) => t.toolCallId === 'r1')?.status).toBe('failed')
    expect(turn.tools?.find((t) => t.toolCallId === 'r2')?.status).toBe('completed')
  })

  it('upsertTool keeps the existing title when a completion arrives with an empty one', () => {
    // claude tool_result completions carry no title (mapClaudeToolResult sends '') — the running
    // row's title must survive the merge.
    const s = useApp.getState()
    const id = s.activeChatId
    s.pushTurn(id, { id: 'a7', role: 'assistant', text: '', streaming: true })
    s.upsertTool(id, { toolCallId: 'w1', title: 'Edit /tmp/a.txt', kind: 'edit', status: 'running' })
    s.upsertTool(id, { toolCallId: 'w1', title: '', status: 'completed', detail: 'ok' })
    const row = useApp.getState().chats[id].messages.at(-1)!.tools![0]
    expect(row.title).toBe('Edit /tmp/a.txt')
    expect(row.status).toBe('completed')
  })

  it('permission cards resolve in place', () => {
    const s = useApp.getState()
    const id = s.activeChatId
    s.pushTurn(id, { id: 'a2', role: 'assistant', text: '', streaming: true })
    s.upsertPermission(id, { requestId: 'p1', title: 'Run x', options: [{ id: 'allow_once', label: 'Allow once', kind: 'allow' }] })
    s.resolvePermission(id, 'p1', 'allow_once')
    const turn = useApp.getState().chats[id].messages.at(-1)!
    expect(turn.permissions?.[0].resolvedOptionId).toBe('allow_once')
  })

  it('tool/permission events after a new user turn still target the last assistant turn', () => {
    const s = useApp.getState()
    const id = s.activeChatId
    s.pushTurn(id, { id: 'a9', role: 'assistant', text: 'done', streaming: false })
    s.pushTurn(id, { id: 'u9', role: 'user', text: 'next question' })
    s.upsertTool(id, { toolCallId: 'late', title: 'Late tool', status: 'completed' })
    const msgs = useApp.getState().chats[id].messages
    expect(msgs.at(-1)!.tools).toBeUndefined() // user turn untouched
    expect(msgs.at(-2)!.tools?.[0].toolCallId).toBe('late')
  })

  it('setLiveContext maps real tokens onto contextK/windowK and marks the chat live', () => {
    const s = useApp.getState()
    const id = s.activeChatId
    s.setLiveContext(id, 42305, 272000)
    const c = useApp.getState().chats[id]
    expect(c.contextK).toBe(42)
    expect(c.windowK).toBe(272)
    expect(c.contextLive).toBe(true)
    s.setLiveContext(id, 61000) // window omitted: keep the previous window
    expect(useApp.getState().chats[id].contextK).toBe(61)
    expect(useApp.getState().chats[id].windowK).toBe(272)
  })

  it('endTurn drops contextLive when the turn fell back to one-shot (fallback notice row)', () => {
    const s = useApp.getState()
    const id = s.activeChatId
    s.setLiveContext(id, 42000, 200000)
    expect(useApp.getState().chats[id].contextLive).toBe(true)
    s.pushTurn(id, { id: 'a20', role: 'assistant', text: '', streaming: true })
    s.upsertTool(id, { toolCallId: 'fallback_run9', title: 'interactive session unavailable — ran headless', kind: 'notice', status: 'failed' })
    s.endTurn(id)
    expect(useApp.getState().chats[id].contextLive).toBe(false) // stale live numbers get the ~ back
  })

  it('endTurn keeps contextLive on a normal interactive turn', () => {
    const s = useApp.getState()
    const id = s.activeChatId
    s.setLiveContext(id, 42000, 200000)
    s.pushTurn(id, { id: 'a21', role: 'assistant', text: 'done', streaming: true })
    s.endTurn(id)
    expect(useApp.getState().chats[id].contextLive).toBe(true)
  })
})
