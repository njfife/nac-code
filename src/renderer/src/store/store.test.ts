import { describe, it, expect, beforeEach } from 'vitest'
import { useApp, chatsForWorkspace, contextPending } from './store'

// Guards the FR-4.1 invariant (mutations affect only the active chat) and FR-9.3 branching.
describe('app store — per-chat spine', () => {
  beforeEach(() => useApp.getState().selectChat('c1'))

  it('setModel affects only the active chat (FR-4.1)', () => {
    const otherBefore = useApp.getState().chats.c3.model
    useApp.getState().selectChat('c1')
    useApp.getState().setModel('codex', 'gpt-5-codex')
    expect(useApp.getState().chats.c1.model).toBe('gpt-5-codex')
    expect(useApp.getState().chats.c3.model).toBe(otherBefore) // untouched
  })

  it('toggleAttach toggles membership and marks the chat dirty (FR-5.5 / FR-6.4)', () => {
    useApp.getState().selectChat('c1')
    const had = useApp.getState().chats.c1.attachedIds.includes('sk-review')
    useApp.getState().toggleAttach('sk-review')
    expect(useApp.getState().chats.c1.attachedIds.includes('sk-review')).toBe(!had)
    expect(useApp.getState().chats.c1.dirty).toBe(true)
  })

  it('newFromCompacted branches a new active chat and leaves the original intact (FR-9.3)', () => {
    useApp.getState().selectChat('c1')
    const n0 = Object.keys(useApp.getState().chats).length
    useApp.getState().newFromCompacted()
    const s = useApp.getState()
    expect(Object.keys(s.chats).length).toBe(n0 + 1)
    const active = s.chats[s.activeChatId]
    expect(active.branchedFrom).toBe('c1')
    expect(active.title).toContain('Compacted ·')
    expect(s.chats.c1.branchedFrom).toBeNull() // original untouched
    // branched chats sort to the top of their workspace group (FR-2.4)
    expect(chatsForWorkspace(s.chats, 'ws_nac')[0].branchedFrom).not.toBeNull()
  })

  it('applyConfig replaces the attached set and clears dirty (FR-6.3)', () => {
    useApp.getState().selectChat('c2') // seeded dirty
    useApp.getState().applyConfig('minimal')
    const c2 = useApp.getState().chats.c2
    expect(c2.attachedIds).toEqual(['in-style'])
    expect(c2.activeConfig).toBe('minimal')
    expect(c2.dirty).toBe(false)
  })

  it('newChat seeds from the active chat and applies Standard (FR-2.3 / M0-4)', () => {
    useApp.getState().selectChat('c3') // codex / infra workspace
    const n0 = Object.keys(useApp.getState().chats).length
    useApp.getState().newChat()
    const s = useApp.getState()
    expect(Object.keys(s.chats).length).toBe(n0 + 1)
    const active = s.chats[s.activeChatId]
    expect(active.title).toBe('New chat')
    expect(active.provider).toBe('codex') // inherited from the active chat
    expect(active.workspaceId).toBe('ws_infra')
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
    useApp.getState().addWorkspace('empty', '/tmp/empty')
    const empty = useApp.getState().workspaces.find((w) => w.name === 'empty')!
    useApp.getState().removeWorkspace(empty.id)
    expect(useApp.getState().workspaces.find((w) => w.id === empty.id)).toBeUndefined()
    const before = useApp.getState().workspaces.length
    useApp.getState().removeWorkspace('ws_nac') // ws_nac has seeded chats -> blocked
    expect(useApp.getState().workspaces.length).toBe(before)
    expect(useApp.getState().workspaces.find((w) => w.id === 'ws_nac')).toBeDefined()
  })

  it('newChat(workspaceId) inherits that workspace’s defaults over the active chat (M0-4)', () => {
    useApp.getState().addWorkspace('proj', '/p')
    const proj = useApp.getState().workspaces.find((w) => w.name === 'proj')!
    useApp.getState().setWorkspaceDefaults(proj.id, { provider: 'codex', model: 'gpt-5-codex', agent: 'infra' })
    useApp.getState().selectChat('c1') // active chat is in ws_nac, not proj
    useApp.getState().newChat(proj.id)
    const active = useApp.getState().chats[useApp.getState().activeChatId]
    expect(active.workspaceId).toBe(proj.id)
    expect(active.provider).toBe('codex')
    expect(active.model).toBe('gpt-5-codex')
    expect(active.agent).toBe('infra')
  })

  it('setWorkspaceDefaults merges partials and clears with null', () => {
    useApp.getState().addWorkspace('p2', '/p2')
    const p2 = useApp.getState().workspaces.find((w) => w.name === 'p2')!
    useApp.getState().setWorkspaceDefaults(p2.id, { provider: 'claude', model: 'Opus 4.8' })
    useApp.getState().setWorkspaceDefaults(p2.id, { agent: 'nac-code' })
    expect(useApp.getState().workspaces.find((w) => w.id === p2.id)!.defaults).toEqual({ provider: 'claude', model: 'Opus 4.8', agent: 'nac-code' })
    useApp.getState().setWorkspaceDefaults(p2.id, null)
    expect(useApp.getState().workspaces.find((w) => w.id === p2.id)!.defaults).toBeUndefined()
  })

  it('recordUsage accumulates per provider (FR-11)', () => {
    useApp.getState().recordUsage('c1', 'claude', { inputTokens: 100, outputTokens: 20, costUsd: 0.05 })
    useApp.getState().recordUsage('c1', 'claude', { inputTokens: 50, outputTokens: 10, costUsd: 0.02 })
    useApp.getState().recordUsage('c1', 'codex', { inputTokens: 200, outputTokens: 0 })
    const u = useApp.getState().chats.c1.usage
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
    useApp.getState().selectChat('c1')
    const prov = useApp.getState().chats.c1.provider
    useApp.getState().setSession('c1', 'sess1', prov)
    useApp.getState().markSeeded('c1', useApp.getState().chats.c1.attachedIds)
    expect(contextPending(useApp.getState().chats.c1)).toBe(false)
    useApp.getState().toggleAttach('sk-brainstorm') // changes the attached set
    expect(contextPending(useApp.getState().chats.c1)).toBe(true)
    useApp.getState().reseedContext('c1') // drops the session -> applies on next send
    expect(contextPending(useApp.getState().chats.c1)).toBe(false)
  })
})
